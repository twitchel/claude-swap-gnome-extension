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
