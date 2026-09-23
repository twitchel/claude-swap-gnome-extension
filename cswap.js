import GLib from 'gi://GLib';
import Gio from 'gi://Gio';

const CALL_TIMEOUT_MS = 10000;

/**
 * Async wrapper around the cswap CLI. The only module that spawns a process.
 *
 * GNOME Shell's PATH is /usr/local/sbin:/usr/local/bin:/usr/bin and does NOT
 * include ~/.local/bin, where cswap actually lives. Spawning it by bare name
 * works in a terminal and fails with ENOENT inside the shell, so the binary is
 * always resolved to an absolute path first.
 */
export class CswapClient {
    constructor({pathOverride = ''} = {}) {
        this._cancellable = new Gio.Cancellable();
        this._inFlight = null;
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

        this._binary = this._tried.find(
            p => GLib.file_test(p, GLib.FileTest.IS_EXECUTABLE)) ?? null;
    }

    get found() {
        return this._binary !== null;
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

        const proc = Gio.Subprocess.new(
            [this._binary, ...args],
            Gio.SubprocessFlags.STDOUT_PIPE | Gio.SubprocessFlags.STDERR_PIPE);

        let timeoutId = 0;
        const cancellable = new Gio.Cancellable();
        const parentHandler = this._cancellable.connect(() => cancellable.cancel());

        try {
            return await new Promise((resolve, reject) => {
                timeoutId = GLib.timeout_add(GLib.PRIORITY_DEFAULT, CALL_TIMEOUT_MS, () => {
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
            this._cancellable.disconnect(parentHandler);
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
}
