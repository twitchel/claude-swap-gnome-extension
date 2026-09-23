import {test, assertEqual, assertNull, loadFixture} from './harness.js';
import {tightestPct, liveCountdown} from '../format.js';

const NOW = Date.parse('2026-09-23T01:40:00Z');

test('tightestPct returns the higher of 5h and 7d', () => {
    const usage = loadFixture('list-two-accounts').accounts[0].usage;
    assertEqual(tightestPct(usage), 70, 'five-hour is tighter');
});

test('tightestPct picks the weekly window when it is higher', () => {
    const usage = loadFixture('list-two-accounts').accounts[1].usage;
    assertEqual(tightestPct(usage), 67, 'seven-day is tighter');
});

test('tightestPct returns null for null usage', () => {
    assertNull(tightestPct(null), 'null usage');
});

test('tightestPct returns null for undefined usage', () => {
    assertNull(tightestPct(undefined), 'missing usage');
});

test('tightestPct returns null when no window has a numeric pct', () => {
    assertNull(tightestPct({fiveHour: {}, sevenDay: {}}), 'no pct fields');
});

test('tightestPct ignores spend, which is not a rate-limit window', () => {
    assertEqual(tightestPct({fiveHour: {pct: 10}, spend: {pct: 99}}), 10, 'spend excluded');
});

test('liveCountdown formats hours and minutes', () => {
    assertEqual(liveCountdown('2026-09-23T05:20:00Z', NOW), '3h 40m', 'hours and minutes');
});

test('liveCountdown formats days and hours', () => {
    assertEqual(liveCountdown('2026-09-26T10:00:00Z', NOW), '3d 8h', 'days and hours');
});

test('liveCountdown formats minutes only under an hour', () => {
    assertEqual(liveCountdown('2026-09-23T02:05:00Z', NOW), '25m', 'minutes only');
});

test('liveCountdown returns null once the reset has passed', () => {
    assertNull(liveCountdown('2026-09-23T01:00:00Z', NOW), 'already reset');
});

test('liveCountdown returns null for a missing resetsAt', () => {
    assertNull(liveCountdown(undefined, NOW), 'no resetsAt');
});

test('liveCountdown returns null for an unparseable resetsAt', () => {
    assertNull(liveCountdown('not a date', NOW), 'garbage resetsAt');
});
