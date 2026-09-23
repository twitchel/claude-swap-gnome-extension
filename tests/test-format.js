import {test, assertEqual, assertNull, loadFixture} from './harness.js';
import {tightestPct, liveCountdown, rolledWeeklyWindow, usageSummary,
    accountLabel, panelText, iconState, accountsOf, snapshotSignature,
    severityOf, barGeometry, DEFAULT_THRESHOLD} from '../format.js';

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

test('rolledWeeklyWindow leaves a live window untouched', () => {
    const w = {pct: 45, resetsAt: '2026-09-26T10:00:00Z'};
    assertEqual(rolledWeeklyWindow(w, NOW).pct, 45, 'still live');
});

test('rolledWeeklyWindow zeroes a window whose reset has passed', () => {
    const w = {pct: 88, resetsAt: '2026-09-19T10:00:00Z'};
    assertEqual(rolledWeeklyWindow(w, NOW).pct, 0, 'rolled over');
});

test('rolledWeeklyWindow advances resetsAt to the next 7-day boundary', () => {
    const w = {pct: 88, resetsAt: '2026-09-19T10:00:00Z'};
    const rolled = rolledWeeklyWindow(w, NOW);
    assertEqual(rolled.resetsAt, '2026-09-26T10:00:00.000Z', 'one week later');
});

test('rolledWeeklyWindow does not mutate its input', () => {
    const w = {pct: 88, resetsAt: '2026-09-19T10:00:00Z'};
    rolledWeeklyWindow(w, NOW);
    assertEqual(w.pct, 88, 'input untouched');
});

test('rolledWeeklyWindow returns null for a missing window', () => {
    assertNull(rolledWeeklyWindow(undefined, NOW), 'no window');
});

test('usageSummary renders both windows with live countdowns', () => {
    const acct = loadFixture('list-two-accounts').accounts[0];
    assertEqual(usageSummary(acct, NOW),
        '5h 70% (3h 40m) · 7d 45% (3d 8h)', 'both windows');
});

test('usageSummary omits a countdown when resetsAt is absent', () => {
    const acct = loadFixture('list-two-accounts').accounts[1];
    assertEqual(usageSummary(acct, NOW),
        '5h 0% · 7d 67% (ahead) (7h 20m)', 'no 5h countdown, weekly ahead of pace');
});

test('usageSummary reflects a rolled-over weekly window', () => {
    const acct = loadFixture('list-expired-weekly').accounts[0];
    assertEqual(usageSummary(acct, NOW), '5h 12% · 7d 0% (3d 8h)', 'weekly rolled to zero');
});

test('usageSummary shows the status text when usageStatus is not ok', () => {
    const acct = loadFixture('list-usage-error').accounts[0];
    assertEqual(usageSummary(acct, NOW), 'auth failed', 'status instead of numbers');
});

test('usageSummary handles an account with no usage key at all', () => {
    const acct = loadFixture('list-usage-error').accounts[1];
    assertEqual(usageSummary(acct, NOW), 'backoff', 'status carried through');
});

test('usageSummary falls back when usage is absent and status is ok', () => {
    assertEqual(usageSummary({usageStatus: 'ok'}, NOW), 'usage unavailable', 'nothing to show');
});

test('usageSummary never emits NaN or undefined', () => {
    const s = usageSummary({usageStatus: 'ok', usage: {fiveHour: {pct: null}}}, NOW);
    assertEqual(s.includes('NaN') || s.includes('undefined'), false, `clean output, got: ${s}`);
});

const P = (panelTextMode, showAccountName = false) =>
    ({panelText: panelTextMode, showAccountName});

test('accountLabel prefers the alias', () => {
    assertEqual(accountLabel({email: 'a@b.com', alias: 'work'}), 'work', 'alias wins');
});

test('accountLabel falls back to the email local part', () => {
    assertEqual(accountLabel({email: 'alice@example.com'}), 'alice', 'local part');
});

test('accountLabel truncates a long local part', () => {
    assertEqual(accountLabel({email: 'averyveryverylongname@x.com'}), 'averyveryve*', 'truncated');
});

test('accountLabel handles a missing email', () => {
    assertEqual(accountLabel({}), '', 'no email');
});

test('panelText none shows nothing', () => {
    const a = loadFixture('list-two-accounts').accounts[0];
    assertEqual(panelText(a, P('none'), NOW), '', 'icon only');
});

test('panelText tightest shows one number', () => {
    const a = loadFixture('list-two-accounts').accounts[0];
    assertEqual(panelText(a, P('tightest'), NOW), '70%', 'tightest window');
});

test('panelText both shows two numbers', () => {
    const a = loadFixture('list-two-accounts').accounts[0];
    assertEqual(panelText(a, P('both'), NOW), '70% · 45%', 'five-hour then weekly');
});

test('panelText prefixes the account name when asked', () => {
    const a = loadFixture('list-two-accounts').accounts[0];
    assertEqual(panelText(a, P('both', true), NOW), 'alice · 70% · 45%', 'name first');
});

test('panelText 7d reflects a rolled-over weekly window', () => {
    const a = loadFixture('list-expired-weekly').accounts[0];
    assertEqual(panelText(a, P('7d'), NOW), '0%', 'rolled to zero');
});

test('panelText returns empty string for a null account', () => {
    assertEqual(panelText(null, P('tightest'), NOW), '', 'nothing active');
});

test('panelText omits the number when usage is unavailable', () => {
    assertEqual(panelText({email: 'a@b.com', usageStatus: 'ok'}, P('tightest'), NOW),
        '', 'no number to show');
});

test('iconState buckets below 70 as ok', () => {
    assertEqual(iconState({usage: {fiveHour: {pct: 69.4}}}, NOW), 'ok', 'under warn band');
});

test('iconState buckets 70 as warn', () => {
    assertEqual(iconState({usage: {fiveHour: {pct: 70}}}, NOW), 'warn', 'warn boundary');
});

test('iconState buckets 89 as warn', () => {
    assertEqual(iconState({usage: {fiveHour: {pct: 89}}}, NOW), 'warn', 'below the trigger');
});

test('iconState goes crit at the auto-switch threshold', () => {
    assertEqual(iconState({usage: {fiveHour: {pct: 90}}}, NOW), 'crit', 'default threshold 90');
});

test('iconState crit follows a raised threshold', () => {
    assertEqual(iconState({usage: {fiveHour: {pct: 90}}}, NOW, 95), 'warn', 'not yet at 95');
    assertEqual(iconState({usage: {fiveHour: {pct: 95}}}, NOW, 95), 'crit', 'at 95');
});

test('iconState falls back to ok when usage is unknown', () => {
    assertEqual(iconState({usageStatus: 'auth failed'}, NOW), 'ok', 'no colour alarm without data');
});

test('accountsOf returns the array when it is well formed', () => {
    const snap = loadFixture('list-two-accounts');
    assertEqual(accountsOf(snap).length, 2, 'both accounts');
});

test('accountsOf returns empty when accounts is not an array', () => {
    assertEqual(accountsOf({accounts: {a: 1}}), [], 'object instead of array');
});

test('accountsOf returns empty for a missing snapshot', () => {
    assertEqual(accountsOf(null), [], 'no snapshot');
});

test('accountsOf drops null and non-object entries', () => {
    const snap = {accounts: [{number: 1}, null, 'nonsense', {number: 2}]};
    assertEqual(accountsOf(snap).length, 2, 'only real entries survive');
});

test('snapshotSignature is stable across identical snapshots', () => {
    const a = loadFixture('list-two-accounts');
    const b = loadFixture('list-two-accounts');
    assertEqual(snapshotSignature(a, NOW) === snapshotSignature(b, NOW), true, 'stable');
});

test('snapshotSignature changes when a percentage changes', () => {
    const a = loadFixture('list-two-accounts');
    const b = loadFixture('list-two-accounts');
    b.accounts[0].usage.fiveHour.pct = 71;
    assertEqual(snapshotSignature(a, NOW) === snapshotSignature(b, NOW), false, 'differs');
});

test('snapshotSignature changes when the active account changes', () => {
    const a = loadFixture('list-two-accounts');
    const b = loadFixture('list-two-accounts');
    b.accounts[0].active = false;
    b.accounts[1].active = true;
    assertEqual(snapshotSignature(a, NOW) === snapshotSignature(b, NOW), false, 'differs');
});

test('snapshotSignature tolerates a malformed snapshot', () => {
    assertEqual(typeof snapshotSignature({accounts: 'nope'}, NOW), 'string', 'still a string');
    assertEqual(typeof snapshotSignature(null, NOW), 'string', 'still a string');
});

test('severityOf is ok below the warn band', () => {
    assertEqual(severityOf(69.9, 90), 'ok', 'under 70');
});

test('severityOf warns from 70 inclusive', () => {
    assertEqual(severityOf(70, 90), 'warn', 'boundary');
    assertEqual(severityOf(89.9, 90), 'warn', 'just under the trigger');
});

test('severityOf goes crit at the threshold inclusive', () => {
    assertEqual(severityOf(90, 90), 'crit', 'at the trigger');
});

test('severityOf tracks a lowered threshold', () => {
    assertEqual(severityOf(80, 80), 'crit', 'threshold 80');
    assertEqual(severityOf(79, 80), 'warn', 'just under');
});

test('severityOf falls back to the claude-swap default when unknown', () => {
    assertEqual(DEFAULT_THRESHOLD, 90, 'claude-swap default');
    assertEqual(severityOf(90, null), 'crit', 'null threshold uses 90');
    assertEqual(severityOf(85, null), 'warn', 'still warn');
});

test('severityOf is ok when the percentage is unknown', () => {
    assertEqual(severityOf(null, 90), 'ok', 'no colour alarm without data');
});

test('barGeometry fills proportionally', () => {
    assertEqual(barGeometry(50, 90, 100).fillWidth, 50, 'half');
    assertEqual(barGeometry(0, 90, 100).fillWidth, 0, 'empty');
    assertEqual(barGeometry(100, 90, 100).fillWidth, 100, 'full');
});

test('barGeometry clamps out-of-range percentages', () => {
    assertEqual(barGeometry(150, 90, 100).fillWidth, 100, 'over 100');
    assertEqual(barGeometry(-5, 90, 100).fillWidth, 0, 'negative');
});

test('barGeometry draws no fill when the percentage is unknown', () => {
    assertEqual(barGeometry(null, 90, 100).fillWidth, 0, 'no fill');
});

test('barGeometry places the tick at the threshold', () => {
    assertEqual(barGeometry(50, 90, 100).tickX, 90, 'at 90%');
});

test('barGeometry keeps the tick inside the track', () => {
    assertEqual(barGeometry(50, 100, 100).tickX, 99, 'never past the last pixel');
    assertEqual(barGeometry(50, 0, 100).tickX, 0, 'never before the first');
});

test('barGeometry omits the tick when the threshold is unknown', () => {
    assertNull(barGeometry(50, null, 100).tickX, 'no tick');
});

test('barGeometry survives a zero-width track', () => {
    const g = barGeometry(50, 90, 0);
    assertEqual(g.fillWidth, 0, 'nothing to fill');
    assertNull(g.tickX, 'nowhere to put a tick');
});
