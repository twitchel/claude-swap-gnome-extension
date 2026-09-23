import {test, assertEqual, assertNull, assertThrows, loadFixture} from './harness.js';

test('assertEqual passes on deep equality', () => {
    assertEqual({a: [1, 2]}, {a: [1, 2]}, 'deep equal');
});

test('assertNull passes on null', () => {
    assertNull(null, 'null is null');
});

test('assertThrows passes when fn throws', () => {
    assertThrows(() => {
        throw new Error('boom');
    }, 'should catch');
});

test('async tests are awaited', async () => {
    const v = await Promise.resolve(42);
    assertEqual(v, 42, 'awaited value');
});

test('fixtures load and parse', () => {
    assertEqual(loadFixture('list-two-accounts').accounts.length, 2, 'two accounts');
    assertEqual(loadFixture('list-empty').accounts.length, 0, 'empty list');
    assertEqual(loadFixture('list-usage-error').accounts[0].usage, null, 'null usage');
});
