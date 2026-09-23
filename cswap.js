import GLib from 'gi://GLib';
import Gio from 'gi://Gio';

const DEFAULT_TIMEOUT_MS = 10000;

/**
 * Async wrapper around the cswap CLI. The only module that spawns a process.
 *
 * GNOME Shell's PATH is /usr/local/sbin:/usr/local/bin:/usr/bin and does NOT
 * include ~/.local/bin, where cswap actually lives. Spawning it by bare name
 * works in a terminal and fails with ENOENT inside the shell, so the binary is
 * always resolved to an absolute path first.
 */
export class CswapClient {
    constructor({pathOverride = '', timeoutMs = DEFAULT_TIMEOUT_MS} = {}) {
        this._cancellable = new Gio.Cancellable();
        this._timeoutMs = timeoutMs;
        this._inFlight = null;
        this._inFlightPromise = null;
        this.lastArgs = null;
        this.schemaWarned = false;

        // An explicit override is authoritative: falling back to a different
        // binary would silently ignore the setting the user reached for
        // precisely because auto-detection picked the wrong one.
        if (pathOverride) {
            this._tried = [pathOverride];
        } else {
            const home = GLib.get_home_dir();
            this._tried = [
                GLib.find_program_in_path('cswap'),
                GLib.build_filenamev([home, '.local', 'bin', 'cswap']),
                GLib.build_filenamev([home, '.local', 'share', 'uv', 'tools',
                    'claude-swap', 'bin', 'cswap']),
            ].filter(p => !!p);
        }

        // IS_EXECUTABLE alone is true for directories, so `/home/me/.local/bin`
        // would resolve as "found" and then fail to spawn on every tick,
        // routing around the self-explanatory notFound state.
        this._binary = this._tried.find(p =>
            GLib.file_test(p, GLib.FileTest.IS_REGULAR) &&
            GLib.file_test(p, GLib.FileTest.IS_EXECUTABLE)) ?? null;
    }

    get found() {
        return this._binary !== null;
    }

    get busy() {
        return this._inFlight !== null;
    }

    get binary() {
        return this._binary;
    }

    get triedPaths() {
        return [...this._tried];
    }

    destroy() {
        this._cancellable.cancel();
        this._inFlight = null;
        this._inFlightPromise = null;
    }

    /**
     * Resolve once nothing is in flight.
     *
     * The client is single-flight, so a user action issued while the menu-open
     * poll is still running would otherwise be rejected as "busy" and surface
     * as an error notification. Callers acting on a click await this first.
     */
    async whenIdle() {
        while (this._inFlightPromise) {
            try {
                await this._inFlightPromise;
            } catch {
                // the in-flight call's own caller handles its failure
            }
        }
    }

    /**
     * Run cswap with args. Resolves {stdout, stderr, status} without throwing
     * on a non-zero exit — callers decide whether the code is an error, since
     * `auto --once` uses exit codes to report normal outcomes.
     */
    async _run(args) {
        if (!this.found) {
            throw new Error(
                `cswap not found; tried:\n${this._tried.join('\n')}`);
        }

        if (this._inFlight)
            throw new Error(`cswap is busy running: ${this._inFlight}`);

        this._inFlight = args.join(' ');
        this.lastArgs = [...args];
        let settle;
        this._inFlightPromise = new Promise(res => (settle = res));

        let timeoutId = 0;
        let parentHandler = 0;
        const cancellable = new Gio.Cancellable();

        try {
            // Spawning lives inside the try so a spawn failure still runs the
            // finally: otherwise _inFlight would stay set and wedge the client
            // as permanently busy.
            const proc = Gio.Subprocess.new(
                [this._binary, ...args],
                Gio.SubprocessFlags.STDOUT_PIPE | Gio.SubprocessFlags.STDERR_PIPE);

            parentHandler = this._cancellable.connect(() => cancellable.cancel());

            return await new Promise((resolve, reject) => {
                timeoutId = GLib.timeout_add(GLib.PRIORITY_DEFAULT, this._timeoutMs, () => {
                    timeoutId = 0;
                    cancellable.cancel();
                    reject(new Error(`cswap ${args.join(' ')} timed out`));
                    return GLib.SOURCE_REMOVE;
                });

                proc.communicate_utf8_async(null, cancellable, (p, res) => {
                    try {
                        const [, stdout, stderr] = p.communicate_utf8_finish(res);
                        resolve({
                            stdout: stdout ?? '',
                            stderr: stderr ?? '',
                            status: p.get_exit_status(),
                        });
                    } catch (e) {
                        reject(e);
                    }
                });
            });
        } finally {
            if (timeoutId)
                GLib.Source.remove(timeoutId);
            if (parentHandler)
                this._cancellable.disconnect(parentHandler);
            this._inFlight = null;
            this._inFlightPromise = null;
            settle();
        }
    }

    /** Run and require a zero exit, parsing stdout as JSON. */
    async _runJson(args) {
        const {stdout, stderr, status} = await this._run(args);
        if (status !== 0) {
            const detail = stderr.trim() || stdout.trim() || `exit ${status}`;
            throw new Error(`cswap ${args.join(' ')} failed: ${detail}`);
        }
        let parsed;
        try {
            parsed = JSON.parse(stdout);
        } catch {
            throw new Error(
                `cswap ${args.join(' ')} returned unparseable JSON: ` +
                `${stdout.slice(0, 200)}`);
        }
        if (parsed?.schemaVersion !== 1 && !this.schemaWarned) {
            this.schemaWarned = true;
            console.warn(
                `claude-swap: unexpected schemaVersion ${parsed?.schemaVersion}, ` +
                'expected 1 — continuing on recognised fields');
        }
        return parsed;
    }

    async listAccounts() {
        return this._runJson(['list', '--json']);
    }

    async switchTo(number) {
        return this._runJson(['switch', String(number), '--json']);
    }

    async switchBy(strategy) {
        return this._runJson(['switch', '--strategy', strategy, '--json']);
    }

    /**
     * Plain round-robin to the next slot.
     *
     * Distinct from switchBy('next-available'), which skips rate-limited
     * accounts: `cswap switch` rotates, `--strategy next-available` rotates
     * while skipping. They only differ when an account is at its limit.
     */
    async rotate() {
        return this._runJson(['switch', '--json']);
    }

    /**
     * One auto-switch tick. Exit codes are outcomes, not failures:
     * 0 switched, 1 error, 2 no action needed, 3 blocked.
     */
    async autoOnce({dryRun = false} = {}) {
        const args = ['auto', '--once', '--json'];
        if (dryRun)
            args.push('--dry-run');

        const {stdout, status} = await this._run(args);
        const events = stdout
            .split('\n')
            .map(line => line.trim())
            .filter(line => line.startsWith('{'))
            .map(line => {
                try {
                    return JSON.parse(line);
                } catch {
                    return null;
                }
            })
            .filter(e => e !== null);

        return {code: status, events};
    }

    /**
     * Auto-switch policy lives in claude-swap's own settings, not ours, so the
     * CLI and the panel never disagree about the threshold.
     */
    async getThreshold() {
        const {stdout, status} = await this._run(['config']);
        if (status !== 0)
            return null;
        for (const line of stdout.split('\n')) {
            const m = line.match(/^autoswitch\.threshold\s+(\d+(?:\.\d+)?)/);
            if (m)
                return Number(m[1]);
        }
        return null;
    }

    async setThreshold(pct) {
        const {status, stderr} = await this._run(
            ['config', 'set', 'autoswitch.threshold', String(pct)]);
        if (status !== 0)
            throw new Error(`could not set threshold: ${stderr.trim() || status}`);
    }
}
