import GLib from 'gi://GLib';
import Gio from 'gi://Gio';
import System from 'system';

const tests = [];

export function test(name, fn) {
    tests.push({name, fn});
}

export function assertEqual(actual, expected, msg = '') {
    const a = JSON.stringify(actual);
    const e = JSON.stringify(expected);
    if (a !== e)
        throw new Error(`${msg}\n      expected: ${e}\n      actual:   ${a}`);
}

export function assertNull(actual, msg = '') {
    if (actual !== null)
        throw new Error(`${msg}\n      expected null, got ${JSON.stringify(actual)}`);
}

export function assertThrows(fn, msg = '') {
    let threw = false;
    try {
        fn();
    } catch {
        threw = true;
    }
    if (!threw)
        throw new Error(`${msg}\n      expected a throw, none happened`);
}

/** Read tests/fixtures/<name>.json relative to this file. */
export function loadFixture(name) {
    const here = GLib.path_get_dirname(
        Gio.File.new_for_uri(import.meta.url).get_path());
    const path = GLib.build_filenamev([here, 'fixtures', `${name}.json`]);
    const [, bytes] = GLib.file_get_contents(path);
    return JSON.parse(new TextDecoder().decode(bytes));
}

export function runAll() {
    const loop = new GLib.MainLoop(null, false);
    let failures = 0;

    (async () => {
        for (const {name, fn} of tests) {
            try {
                await fn();
                print(`  ok    ${name}`);
            } catch (e) {
                failures++;
                print(`  FAIL  ${name}`);
                print(`        ${e.message}`);
            }
        }
        print('');
        print(`${tests.length - failures} passed, ${failures} failed`);
        loop.quit();
    })().catch(e => {
        print(`harness crashed: ${e}`);
        failures++;
        loop.quit();
    });

    loop.run();
    System.exit(failures > 0 ? 1 : 0);
}
