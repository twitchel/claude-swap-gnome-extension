import GLib from 'gi://GLib';
import Gio from 'gi://Gio';
import {test, assertEqual, loadFixture} from './harness.js';
import {CswapClient} from '../cswap.js';

const HERE = GLib.path_get_dirname(Gio.File.new_for_uri(import.meta.url).get_path());
const STUB = GLib.build_filenamev([HERE, 'stub-cswap.sh']);

function stub(env) {
    for (const [k, v] of Object.entries(env))
        GLib.setenv(k, String(v), true);
}

function clearStub() {
    for (const k of ['STUB_STDOUT', 'STUB_STDERR', 'STUB_EXIT', 'STUB_SLEEP'])
        GLib.unsetenv(k);
}

test('an unresolvable binary leaves the client not found', () => {
    const c = new CswapClient({pathOverride: '/nonexistent/cswap'});
    assertEqual(c.found, false, 'not found');
    assertEqual(c.triedPaths.length > 0, true, 'reports what it tried');
    c.destroy();
});

test('an explicit override is used when executable', () => {
    const c = new CswapClient({pathOverride: STUB});
    assertEqual(c.found, true, 'found the stub');
    assertEqual(c.binary, STUB, 'uses the override');
    c.destroy();
});

test('listAccounts parses valid JSON', async () => {
    clearStub();
    stub({STUB_STDOUT: JSON.stringify(loadFixture('list-two-accounts'))});
    const c = new CswapClient({pathOverride: STUB});
    const result = await c.listAccounts();
    assertEqual(result.accounts.length, 2, 'two accounts parsed');
    assertEqual(result.accounts[0].email, 'alice@example.com', 'first account');
    c.destroy();
    clearStub();
});

test('listAccounts parses an empty account list', async () => {
    clearStub();
    stub({STUB_STDOUT: JSON.stringify(loadFixture('list-empty'))});
    const c = new CswapClient({pathOverride: STUB});
    const result = await c.listAccounts();
    assertEqual(result.accounts.length, 0, 'no accounts');
    c.destroy();
    clearStub();
});

test('listAccounts rejects on a non-zero exit', async () => {
    clearStub();
    stub({STUB_EXIT: 3, STUB_STDERR: 'boom'});
    const c = new CswapClient({pathOverride: STUB});
    let rejected = false;
    try {
        await c.listAccounts();
    } catch (e) {
        rejected = true;
        assertEqual(e.message.includes('boom'), true, `stderr carried: ${e.message}`);
    }
    assertEqual(rejected, true, 'should reject');
    c.destroy();
    clearStub();
});

test('listAccounts rejects on malformed JSON', async () => {
    clearStub();
    stub({STUB_STDOUT: 'not json at all'});
    const c = new CswapClient({pathOverride: STUB});
    let rejected = false;
    try {
        await c.listAccounts();
    } catch {
        rejected = true;
    }
    assertEqual(rejected, true, 'should reject');
    c.destroy();
    clearStub();
});

test('listAccounts rejects when the binary is not found', async () => {
    const c = new CswapClient({pathOverride: '/nonexistent/cswap'});
    let rejected = false;
    try {
        await c.listAccounts();
    } catch (e) {
        rejected = true;
        assertEqual(e.message.includes('not found'), true, `names the problem: ${e.message}`);
    }
    assertEqual(rejected, true, 'should reject');
    c.destroy();
});

test('an unexpected schemaVersion still parses, and warns once', async () => {
    clearStub();
    const payload = loadFixture('list-two-accounts');
    payload.schemaVersion = 2;
    stub({STUB_STDOUT: JSON.stringify(payload)});
    const c = new CswapClient({pathOverride: STUB});
    const result = await c.listAccounts();
    assertEqual(result.accounts.length, 2, 'still usable');
    assertEqual(c.schemaWarned, true, 'warned about the drift');
    c.destroy();
    clearStub();
});

test('autoOnce reports exit code 2 as a normal no-action outcome', async () => {
    clearStub();
    stub({STUB_EXIT: 2});
    const c = new CswapClient({pathOverride: STUB});
    const {code} = await c.autoOnce({});
    assertEqual(code, 2, 'no action needed');
    c.destroy();
    clearStub();
});

test('autoOnce reports exit code 3 as blocked without rejecting', async () => {
    clearStub();
    stub({STUB_EXIT: 3});
    const c = new CswapClient({pathOverride: STUB});
    const {code} = await c.autoOnce({});
    assertEqual(code, 3, 'blocked');
    c.destroy();
    clearStub();
});

test('autoOnce parses newline-delimited JSON events', async () => {
    clearStub();
    stub({
        STUB_EXIT: 0,
        STUB_STDOUT: '{"event":"evaluated","pct":91}\n{"event":"switched","to":2}\n',
    });
    const c = new CswapClient({pathOverride: STUB});
    const {code, events} = await c.autoOnce({});
    assertEqual(code, 0, 'switched');
    assertEqual(events.length, 2, 'two events');
    assertEqual(events[1].to, 2, 'switched to account 2');
    c.destroy();
    clearStub();
});

test('autoOnce ignores unparseable lines rather than failing the tick', async () => {
    clearStub();
    stub({STUB_EXIT: 0, STUB_STDOUT: 'warning: something\n{"event":"switched","to":2}\n'});
    const c = new CswapClient({pathOverride: STUB});
    const {events} = await c.autoOnce({});
    assertEqual(events.length, 1, 'only the JSON line');
    c.destroy();
    clearStub();
});

test('autoOnce passes --dry-run when asked', async () => {
    clearStub();
    stub({STUB_EXIT: 2});
    const c = new CswapClient({pathOverride: STUB});
    await c.autoOnce({dryRun: true});
    assertEqual(c.lastArgs.includes('--dry-run'), true, `args were: ${c.lastArgs}`);
    c.destroy();
    clearStub();
});

test('getThreshold parses the config table', async () => {
    clearStub();
    stub({STUB_STDOUT: 'autoswitch.threshold              80      (set)\nui.theme  auto  (default)\n'});
    const c = new CswapClient({pathOverride: STUB});
    assertEqual(await c.getThreshold(), 80, 'parsed threshold');
    c.destroy();
    clearStub();
});

test('getThreshold returns null when the key is absent', async () => {
    clearStub();
    stub({STUB_STDOUT: 'ui.theme  auto  (default)\n'});
    const c = new CswapClient({pathOverride: STUB});
    assertEqual(await c.getThreshold(), null, 'no threshold line');
    c.destroy();
    clearStub();
});

test('a second call while one is in flight is rejected, not queued', async () => {
    clearStub();
    stub({STUB_SLEEP: 1, STUB_STDOUT: '{"schemaVersion":1,"accounts":[]}'});
    const c = new CswapClient({pathOverride: STUB});
    const first = c.listAccounts();
    assertEqual(c.busy, true, 'busy while in flight');
    let rejected = false;
    try {
        await c.listAccounts();
    } catch (e) {
        rejected = true;
        assertEqual(e.message.includes('busy'), true, `says why: ${e.message}`);
    }
    assertEqual(rejected, true, 'second call rejected');
    await first;
    assertEqual(c.busy, false, 'idle again');
    c.destroy();
    clearStub();
});

test('a failed spawn does not wedge the client as permanently busy', async () => {
    clearStub();
    const c = new CswapClient({pathOverride: STUB});
    c._binary = '/nonexistent/definitely-not-here';
    try {
        await c.listAccounts();
    } catch {
        // expected: spawn fails
    }
    assertEqual(c.busy, false, 'not wedged after a spawn failure');
    c.destroy();
    clearStub();
});
