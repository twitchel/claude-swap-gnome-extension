# Claude Swap Indicator Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A GNOME 50 top-bar indicator that shows the active claude-swap account's rate-limit usage and lets the user switch accounts and drive auto-switching without a terminal.

**Architecture:** A thin GJS shell over the `cswap` CLI. `cswap.js` owns the process boundary, `format.js` is pure display logic with no GNOME imports (so it runs under plain `gjs` for tests), `indicator.js` owns everything St. No account, usage, or auto-switch logic is reimplemented — all data comes from the documented schema-v1 JSON.

**Tech Stack:** GJS 1.88.1 (ESM), GNOME Shell 50.5, GLib/Gio 2.88.3, St/Clutter, Adw 1 for prefs, claude-swap 0.26.0.

**Spec:** `docs/superpowers/specs/2026-09-23-claude-swap-indicator-design.md`

## Global Constraints

- Extension UUID is `claude-swap@danieljones.net`; `metadata.json` declares `"shell-version": ["50"]`.
- GSettings schema id is `org.gnome.shell.extensions.claude-swap`, path `/org/gnome/shell/extensions/claude-swap/`.
- **Always invoke `/usr/bin/glib-compile-schemas`, never bare `glib-compile-schemas`.** On this machine `/home/linuxbrew/.linuxbrew/bin` precedes `/usr/bin` on PATH and shadows it. Versions match today (both 2.88.3); a `brew upgrade` would silently skew them.
- **Always invoke `/usr/bin/gjs`** for the same reason.
- **GNOME Shell's PATH is `/usr/local/sbin:/usr/local/bin:/usr/bin` and does not contain `~/.local/bin`.** `cswap` must never be spawned by bare name from inside the shell.
- `format.js` must not import anything from `gi://` — that is what keeps it testable outside the shell.
- Every `GLib` timeout source id and every `Gio.Cancellable` created must be released in `disable()`. A GNOME extension that leaks a timeout keeps firing after it is disabled.
- `cswap auto --once` exit codes: `0` switched, `1` error, `2` no action needed, `3` blocked. `2` and `3` are normal outcomes, not errors.
- Do not port `claude_swap/pace.py`: schema-v1 JSON already ships `aheadOfPace` and `expectedPct`.
- Percentages render with no decimal places (`70%`, not `70.0%`).
- **Deliberate divergence from the spec:** the spec lists `refresh-interval` as a choice of 30/60/300 (macOS parity). The plan makes it a 30–600 spin range instead, because an Adwaita `SpinRow` is the idiomatic GNOME control and a three-value enum buys nothing here. Behaviour is otherwise identical.

## Review Focus

These are input classes the spec implies but that no task's happy-path tests would otherwise exercise. Each line's test is assigned to the task that owns the code.

1. **Teardown while a subprocess is in flight** — toggling the extension off mid-poll must not run a callback against destroyed actors. Expected: the cancellable fires, the callback returns early, nothing is logged as an error. → Task 10 (code + guard audit); verified live in Task 11 Step 6, since this needs a running shell and the `gjs` suite cannot reach it.
2. **`usageStatus` other than `"ok"`** — claude-swap reports auth failures and backoff this way, and it happens in normal use. Expected: the row shows the status text instead of a percentage, never `undefined%` or `NaN%`. → Task 3.
3. **An account with `usage` absent or null** — a never-polled or erroring account. Expected: `usage unavailable`, and `tightestPct` returns `null` so the icon falls back to the `ok` colour rather than throwing. → Task 2 and Task 3.
4. **Zero managed accounts** — `accounts: []`, which is what a fresh claude-swap install returns. Expected: a single insensitive `No managed accounts` row; the panel shows the icon with no number; no timer crash. → parsing tested in Task 5 (`list-empty` fixture) and the empty panel label in Task 4 (`panelText` with a null account); the menu row itself is shell-only, verified in Task 11 Step 5.
5. **`schemaVersion` drift after a `cswap upgrade`** — claude-swap self-upgrades. Expected: parse proceeds, a warning is logged once per session, and the extension keeps working on the fields it recognises rather than throwing. → Task 5.

---

## File Structure

```
claude-swap@danieljones.net/
├── metadata.json          manifest; declares shell-version and settings-schema
├── extension.js           enable()/disable() only — constructs and destroys the indicator
├── indicator.js           PanelMenu.Button: panel label, icon state, menu, poll timer
├── cswap.js               CswapClient — the only file that spawns a process
├── format.js              pure display functions; no gi:// imports
├── prefs.js               Adw preferences window
├── stylesheet.css         .cswap-ok / -warn / -crit / -switched / -stale
├── icons/
│   └── claude-robot-symbolic.svg
├── schemas/
│   └── org.gnome.shell.extensions.claude-swap.gschema.xml
└── tests/
    ├── harness.js         test registry, assertions, async runner, exit code
    ├── run.js             imports every test module, then runs
    ├── test-format.js
    ├── test-cswap.js
    ├── stub-cswap.sh      fake cswap binary driven by env vars
    └── fixtures/
        ├── list-two-accounts.json
        ├── list-empty.json
        ├── list-usage-error.json
        └── list-expired-weekly.json
```

---

### Task 1: Test harness

The harness has to be able to fail. A runner that reports success no matter what is worse than no runner, so this task's deliverable includes proving a failing assertion exits non-zero.

**Files:**
- Create: `tests/harness.js`
- Create: `tests/run.js`
- Create: `tests/fixtures/list-two-accounts.json`
- Create: `tests/fixtures/list-empty.json`
- Create: `tests/fixtures/list-usage-error.json`
- Create: `tests/fixtures/list-expired-weekly.json`
- Create: `tests/test-harness-selftest.js`

**Interfaces:**
- Consumes: nothing.
- Produces: `test(name, fn)`, `assertEqual(actual, expected, msg?)`, `assertNull(actual, msg?)`, `assertThrows(fn, msg?)`, `runAll()`, `loadFixture(name)` — all exported from `tests/harness.js`. `fn` may be async; the runner awaits it.

- [ ] **Step 1: Write the harness**

Create `tests/harness.js`:

```js
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
```

- [ ] **Step 2: Write the runner**

Create `tests/run.js`. It imports test modules for their side effect of registering tests, then runs them. Later tasks add lines to this file.

```js
import './test-harness-selftest.js';
import {runAll} from './harness.js';

runAll();
```

- [ ] **Step 3: Write the harness self-test, including a deliberately failing case**

Create `tests/test-harness-selftest.js`:

```js
import {test, assertEqual, assertNull, assertThrows} from './harness.js';

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
```

- [ ] **Step 4: Run the suite — expect it to pass**

Run: `/usr/bin/gjs -m tests/run.js; echo "exit=$?"`
Expected: four `ok` lines, `4 passed, 0 failed`, `exit=0`.

- [ ] **Step 5: Prove the harness can fail**

Temporarily append this to `tests/test-harness-selftest.js`:

```js
test('DELIBERATE FAILURE — remove me', () => {
    assertEqual(1, 2, 'this must fail');
});
```

Run: `/usr/bin/gjs -m tests/run.js; echo "exit=$?"`
Expected: a `FAIL` line, `4 passed, 1 failed`, `exit=1`.

Then delete that test block and re-run to confirm `exit=0` again. Do not commit the deliberate failure.

- [ ] **Step 6: Write the fixtures**

Create `tests/fixtures/list-two-accounts.json` — this is real captured output from `cswap list --json`:

```json
{
  "schemaVersion": 1,
  "activeAccountNumber": 1,
  "accounts": [
    {
      "number": 1,
      "email": "alice@example.com",
      "active": true,
      "usageStatus": "ok",
      "usage": {
        "fiveHour": {
          "pct": 70.0,
          "resetsAt": "2026-09-23T05:20:00.450756+00:00",
          "countdown": "3h 41m",
          "clock": "15:20"
        },
        "sevenDay": {
          "pct": 45.0,
          "resetsAt": "2026-09-26T10:00:00.450775+00:00",
          "countdown": "3d 8h",
          "clock": "Sep 26 20:00",
          "expectedPct": 52.2,
          "aheadOfPace": false
        }
      },
      "usageFetchedAt": "2026-09-23T01:38:33Z",
      "usageAgeSeconds": 0.7
    },
    {
      "number": 2,
      "email": "bob@example.net",
      "active": false,
      "usageStatus": "ok",
      "usage": {
        "fiveHour": {"pct": 0.0},
        "sevenDay": {
          "pct": 67.0,
          "resetsAt": "2026-09-23T09:00:00.133736+00:00",
          "countdown": "7h 21m",
          "clock": "19:00",
          "expectedPct": 95.6,
          "aheadOfPace": true
        }
      },
      "usageFetchedAt": "2026-09-23T01:38:34Z",
      "usageAgeSeconds": 0.0
    }
  ]
}
```

Create `tests/fixtures/list-empty.json`:

```json
{
  "schemaVersion": 1,
  "activeAccountNumber": null,
  "accounts": []
}
```

Create `tests/fixtures/list-usage-error.json`:

```json
{
  "schemaVersion": 1,
  "activeAccountNumber": 1,
  "accounts": [
    {
      "number": 1,
      "email": "alice@example.com",
      "active": true,
      "usageStatus": "auth failed",
      "usage": null
    },
    {
      "number": 2,
      "email": "bob@example.net",
      "active": false,
      "usageStatus": "backoff"
    }
  ]
}
```

Create `tests/fixtures/list-expired-weekly.json`. The `sevenDay.resetsAt` here is deliberately in the past, to exercise the roll-forward:

```json
{
  "schemaVersion": 1,
  "activeAccountNumber": 1,
  "accounts": [
    {
      "number": 1,
      "email": "alice@example.com",
      "active": true,
      "usageStatus": "ok",
      "usage": {
        "fiveHour": {
          "pct": 12.0,
          "resetsAt": "2026-09-20T00:00:00+00:00"
        },
        "sevenDay": {
          "pct": 88.0,
          "resetsAt": "2026-09-19T10:00:00+00:00"
        }
      }
    }
  ]
}
```

- [ ] **Step 7: Verify fixtures load**

Add to `tests/test-harness-selftest.js`:

```js
import {loadFixture} from './harness.js';

test('fixtures load and parse', () => {
    assertEqual(loadFixture('list-two-accounts').accounts.length, 2, 'two accounts');
    assertEqual(loadFixture('list-empty').accounts.length, 0, 'empty list');
    assertEqual(loadFixture('list-usage-error').accounts[0].usage, null, 'null usage');
});
```

Merge that `import` line into the existing import at the top of the file rather than adding a second import statement.

Run: `/usr/bin/gjs -m tests/run.js; echo "exit=$?"`
Expected: `5 passed, 0 failed`, `exit=0`.

- [ ] **Step 8: Commit**

```bash
git add tests/
git commit -m "test: add gjs test harness and captured cswap fixtures"
```

---

### Task 2: format.js — tightestPct and liveCountdown

**Files:**
- Create: `format.js`
- Create: `tests/test-format.js`
- Modify: `tests/run.js` (add one import line)

**Interfaces:**
- Consumes: `test`, `assertEqual`, `assertNull`, `loadFixture` from `tests/harness.js`.
- Produces:
  - `tightestPct(usage) -> number | null` — usage is the account's `usage` object.
  - `liveCountdown(resetsAt, nowMs) -> string | null` — `resetsAt` is an ISO 8601 string; `nowMs` is milliseconds since epoch.

- [ ] **Step 1: Write the failing tests**

Create `tests/test-format.js`:

```js
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
```

- [ ] **Step 2: Wire the module into the runner**

In `tests/run.js`, add `import './test-format.js';` above the existing `import './test-harness-selftest.js';` line.

- [ ] **Step 3: Run tests to verify they fail**

Run: `/usr/bin/gjs -m tests/run.js`
Expected: the run aborts with an import error naming `../format.js`, because the module does not exist yet.

- [ ] **Step 4: Write the minimal implementation**

Create `format.js`:

```js
// Pure display helpers, ported from claude_swap/menubar.py. This module must
// not import anything from gi:// — that is what lets it run under plain gjs in
// tests, outside a running shell.

/**
 * Highest 5h/7d utilization percentage, or null when unknown.
 * Spend is deliberately excluded: it is not a rate-limit window.
 */
export function tightestPct(usage) {
    if (!usage || typeof usage !== 'object')
        return null;
    const pcts = [usage.fiveHour, usage.sevenDay]
        .filter(w => w && typeof w.pct === 'number')
        .map(w => w.pct);
    return pcts.length ? Math.max(...pcts) : null;
}

/**
 * Time until a usage window resets, computed live from the absolute resetsAt.
 *
 * The JSON's own `countdown` string is frozen at fetch time, so rendering it
 * between polls shows a stale remaining time. Deriving from resetsAt keeps it
 * correct. Returns null when there is no resetsAt or it has already passed.
 */
export function liveCountdown(resetsAt, nowMs) {
    if (typeof resetsAt !== 'string')
        return null;
    const ts = Date.parse(resetsAt);
    if (Number.isNaN(ts))
        return null;

    let remaining = Math.floor((ts - nowMs) / 1000);
    if (remaining <= 0)
        return null;

    const days = Math.floor(remaining / 86400);
    remaining -= days * 86400;
    const hours = Math.floor(remaining / 3600);
    remaining -= hours * 3600;
    const minutes = Math.floor(remaining / 60);

    if (days > 0)
        return `${days}d ${hours}h`;
    if (hours > 0)
        return `${hours}h ${minutes}m`;
    return `${minutes}m`;
}
```

- [ ] **Step 5: Run tests to verify they pass**

Run: `/usr/bin/gjs -m tests/run.js; echo "exit=$?"`
Expected: all twelve format tests `ok`, `exit=0`.

- [ ] **Step 6: Commit**

```bash
git add format.js tests/test-format.js tests/run.js
git commit -m "feat: add tightestPct and liveCountdown display helpers"
```

---

### Task 3: format.js — rolledWeeklyWindow and usageSummary

`rolledWeeklyWindow` matters because weekly limits reset on a fixed 7-day cadence. Once a stored `resetsAt` is in the past, the stored percentage belongs to a window that no longer exists, and rendering it shows last cycle's number as if it were current.

**Files:**
- Modify: `format.js`
- Modify: `tests/test-format.js`

**Interfaces:**
- Consumes: `tightestPct`, `liveCountdown` from `format.js` (Task 2).
- Produces:
  - `rolledWeeklyWindow(window, nowMs) -> object | null` — returns the window unchanged when still live, a copy with `pct: 0` and an advanced `resetsAt` when it has rolled, or null for a missing window.
  - `usageSummary(account, nowMs) -> string` — the one-line summary for an account row.

- [ ] **Step 1: Write the failing tests**

Append to `tests/test-format.js`, and extend the existing `import {...} from '../format.js';` line to also import `rolledWeeklyWindow` and `usageSummary`:

```js
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
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `/usr/bin/gjs -m tests/run.js`
Expected: an import error for `rolledWeeklyWindow` / `usageSummary`, or `FAIL` lines for the twelve new tests.

- [ ] **Step 3: Write the minimal implementation**

Append to `format.js`:

```js
const WEEK_MS = 7 * 86400 * 1000;

/**
 * A weekly window whose reset has passed, advanced to its next 7-day boundary.
 *
 * Weekly limits reset on a fixed cadence, so a resetsAt in the past means the
 * window rolled over and the stored pct belongs to a cycle that is gone.
 * Returns a copy — never mutates the caller's object.
 */
export function rolledWeeklyWindow(window, nowMs) {
    if (!window || typeof window !== 'object')
        return null;
    const ts = Date.parse(window.resetsAt);
    if (Number.isNaN(ts) || ts > nowMs)
        return window;

    let next = ts;
    while (next <= nowMs)
        next += WEEK_MS;

    return {...window, pct: 0, resetsAt: new Date(next).toISOString()};
}

function segment(label, window, nowMs) {
    if (!window || typeof window.pct !== 'number')
        return null;
    let seg = `${label} ${window.pct.toFixed(0)}%`;
    if (window.aheadOfPace)
        seg += ' (ahead)';
    const countdown = liveCountdown(window.resetsAt, nowMs);
    if (countdown)
        seg += ` (${countdown})`;
    return seg;
}

/** One-line usage summary for an account row. */
export function usageSummary(account, nowMs) {
    const status = account?.usageStatus;
    if (status && status !== 'ok')
        return status;

    const usage = account?.usage;
    if (!usage || typeof usage !== 'object')
        return 'usage unavailable';

    const parts = [
        segment('5h', usage.fiveHour, nowMs),
        segment('7d', rolledWeeklyWindow(usage.sevenDay, nowMs), nowMs),
    ].filter(s => s !== null);

    return parts.length ? parts.join(' · ') : 'usage unavailable';
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `/usr/bin/gjs -m tests/run.js; echo "exit=$?"`
Expected: all format tests `ok`, `exit=0`.

- [ ] **Step 5: Commit**

```bash
git add format.js tests/test-format.js
git commit -m "feat: add weekly roll-forward and usage summary formatting"
```

---

### Task 4: format.js — accountLabel and panelText

**Files:**
- Modify: `format.js`
- Modify: `tests/test-format.js`

**Interfaces:**
- Consumes: `tightestPct`, `usageSummary` from `format.js`.
- Produces:
  - `accountLabel(account) -> string` — alias when set, else the email's local part.
  - `panelText(account, prefs, nowMs) -> string` — the panel label; `prefs` is `{panelText, showAccountName}` where `panelText` is one of `none`, `tightest`, `5h`, `7d`, `both`.
  - `iconState(account, nowMs) -> 'ok' | 'warn' | 'crit'` — colour bucket from the tightest window.

- [ ] **Step 1: Write the failing tests**

Append to `tests/test-format.js`, extending the `../format.js` import to add `accountLabel`, `panelText` and `iconState`:

```js
const P = (panelText, showAccountName = false) => ({panelText, showAccountName});

test('accountLabel prefers the alias', () => {
    assertEqual(accountLabel({email: 'a@b.com', alias: 'work'}), 'work', 'alias wins');
});

test('accountLabel falls back to the email local part', () => {
    assertEqual(accountLabel({email: 'alice@example.com'}), 'alice', 'local part');
});

test('accountLabel truncates a long local part', () => {
    assertEqual(accountLabel({email: 'averyveryverylongname@x.com'}), 'averyveryver*', 'truncated');
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

test('iconState buckets below 80 as ok', () => {
    assertEqual(iconState({usage: {fiveHour: {pct: 79.4}}}, NOW), 'ok', 'under threshold');
});

test('iconState buckets 80 as warn', () => {
    assertEqual(iconState({usage: {fiveHour: {pct: 80}}}, NOW), 'warn', 'boundary is warn');
});

test('iconState buckets 95 as warn', () => {
    assertEqual(iconState({usage: {fiveHour: {pct: 95}}}, NOW), 'warn', 'upper boundary');
});

test('iconState buckets above 95 as crit', () => {
    assertEqual(iconState({usage: {fiveHour: {pct: 95.1}}}, NOW), 'crit', 'over threshold');
});

test('iconState falls back to ok when usage is unknown', () => {
    assertEqual(iconState({usageStatus: 'auth failed'}, NOW), 'ok', 'no colour alarm without data');
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `/usr/bin/gjs -m tests/run.js`
Expected: an import error for the three new names, or `FAIL` lines for the sixteen new tests.

- [ ] **Step 3: Write the minimal implementation**

Append to `format.js`:

```js
const LOCAL_PART_LIMIT = 12;

/** Alias when set, else the email's local part, truncated with a '*' marker. */
export function accountLabel(account) {
    if (account?.alias)
        return account.alias;
    const email = account?.email;
    if (typeof email !== 'string')
        return '';
    const local = email.split('@', 1)[0];
    if (local.length > LOCAL_PART_LIMIT)
        return `${local.slice(0, LOCAL_PART_LIMIT - 1)}*`;
    return local;
}

function pctOf(window) {
    return window && typeof window.pct === 'number' ? `${window.pct.toFixed(0)}%` : null;
}

/** The panel label. Returns '' when there is nothing to show beside the icon. */
export function panelText(account, prefs, nowMs) {
    if (!account)
        return '';

    const segments = [];
    if (prefs.showAccountName) {
        const name = accountLabel(account);
        if (name)
            segments.push(name);
    }

    const usage = account.usage;
    const weekly = rolledWeeklyWindow(usage?.sevenDay, nowMs);

    switch (prefs.panelText) {
    case 'none':
        break;
    case 'tightest': {
        const p = tightestPct(usage);
        if (p !== null)
            segments.push(`${p.toFixed(0)}%`);
        break;
    }
    case '5h': {
        const s = pctOf(usage?.fiveHour);
        if (s)
            segments.push(s);
        break;
    }
    case '7d': {
        const s = pctOf(weekly);
        if (s)
            segments.push(s);
        break;
    }
    case 'both': {
        const a = pctOf(usage?.fiveHour);
        const b = pctOf(weekly);
        if (a)
            segments.push(a);
        if (b)
            segments.push(b);
        break;
    }
    }

    return segments.join(' · ');
}

/** Colour bucket for the panel icon, from the tightest window. */
export function iconState(account, nowMs) {
    const usage = account?.usage;
    if (!usage)
        return 'ok';
    const rolled = {...usage, sevenDay: rolledWeeklyWindow(usage.sevenDay, nowMs)};
    const p = tightestPct(rolled);
    if (p === null)
        return 'ok';
    if (p > 95)
        return 'crit';
    if (p >= 80)
        return 'warn';
    return 'ok';
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `/usr/bin/gjs -m tests/run.js; echo "exit=$?"`
Expected: every format test `ok`, `exit=0`.

- [ ] **Step 5: Commit**

```bash
git add format.js tests/test-format.js
git commit -m "feat: add account label, panel text and icon state formatting"
```

---

### Task 5: cswap.js — binary resolution and listAccounts

**Files:**
- Create: `cswap.js`
- Create: `tests/stub-cswap.sh`
- Create: `tests/test-cswap.js`
- Modify: `tests/run.js` (add one import line)

**Interfaces:**
- Consumes: nothing from earlier tasks.
- Produces: `class CswapClient`:
  - `new CswapClient({pathOverride = ''})`
  - `get found() -> boolean`
  - `get triedPaths() -> string[]`
  - `get binary() -> string | null`
  - `async listAccounts() -> {schemaVersion, activeAccountNumber, accounts}` — rejects on spawn failure, non-zero exit, or unparseable JSON.
  - `destroy()` — cancels anything in flight.

- [ ] **Step 1: Write the stub cswap**

Create `tests/stub-cswap.sh` and `chmod +x` it. It fakes the real binary under control of environment variables, so the client can be tested without touching real credentials:

```sh
#!/bin/sh
# Fake cswap for tests. Driven by env vars:
#   STUB_STDOUT  — text to print on stdout
#   STUB_STDERR  — text to print on stderr
#   STUB_EXIT    — exit code (default 0)
#   STUB_SLEEP   — seconds to sleep before responding (default 0)
[ -n "$STUB_SLEEP" ] && sleep "$STUB_SLEEP"
[ -n "$STUB_STDOUT" ] && printf '%s' "$STUB_STDOUT"
[ -n "$STUB_STDERR" ] && printf '%s' "$STUB_STDERR" >&2
exit "${STUB_EXIT:-0}"
```

- [ ] **Step 2: Write the failing tests**

Create `tests/test-cswap.js`:

```js
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
```

- [ ] **Step 3: Wire the module into the runner**

In `tests/run.js`, add `import './test-cswap.js';` below the `test-format.js` import.

- [ ] **Step 4: Run tests to verify they fail**

Run: `/usr/bin/gjs -m tests/run.js`
Expected: an import error naming `../cswap.js`.

- [ ] **Step 5: Write the minimal implementation**

Create `cswap.js`:

```js
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
        this.schemaWarned = false;

        const home = GLib.get_home_dir();
        this._tried = [
            pathOverride,
            GLib.find_program_in_path('cswap'),
            GLib.build_filenamev([home, '.local', 'bin', 'cswap']),
            GLib.build_filenamev([home, '.local', 'share', 'uv', 'tools',
                'claude-swap', 'bin', 'cswap']),
        ].filter(p => !!p);

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
```

- [ ] **Step 6: Run tests to verify they pass**

Run: `/usr/bin/gjs -m tests/run.js; echo "exit=$?"`
Expected: all eight cswap tests `ok`, `exit=0`.

- [ ] **Step 7: Commit**

```bash
git add cswap.js tests/stub-cswap.sh tests/test-cswap.js tests/run.js
git commit -m "feat: add CswapClient with explicit binary resolution and listAccounts"
```

---

### Task 6: cswap.js — switching, auto tick, config, and single-flight

**Files:**
- Modify: `cswap.js`
- Modify: `tests/test-cswap.js`

**Interfaces:**
- Consumes: `CswapClient._run`, `CswapClient._runJson` from Task 5.
- Produces, on `CswapClient`:
  - `async switchTo(number) -> object`
  - `async switchBy(strategy) -> object` — `strategy` is `'best'` or `'next-available'`
  - `async autoOnce({dryRun = false}) -> {code, events}` — never rejects on exit codes 1/2/3
  - `async getThreshold() -> number | null`
  - `async setThreshold(pct) -> void`
  - `get busy() -> boolean`

- [ ] **Step 1: Write the failing tests**

Append to `tests/test-cswap.js`:

```js
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
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `/usr/bin/gjs -m tests/run.js`
Expected: `FAIL` lines for the eight new tests.

- [ ] **Step 3: Add single-flight tracking and `lastArgs` to `_run`**

In `cswap.js`, replace the body of `_run` up to the `const proc = ...` line with this, keeping the rest of the method unchanged:

```js
    async _run(args) {
        if (!this.found) {
            throw new Error(
                `cswap not found; tried:\n${this._tried.join('\n')}`);
        }
        if (this._inFlight)
            throw new Error(`cswap is busy running: ${this._inFlight}`);

        this._inFlight = args.join(' ');
        this.lastArgs = [...args];
```

and wrap the existing `try { ... } finally { ... }` so the `finally` block also clears the flag:

```js
        } finally {
            if (timeoutId)
                GLib.Source.remove(timeoutId);
            this._cancellable.disconnect(parentHandler);
            this._inFlight = null;
        }
```

Then add the getter beside the others:

```js
    get busy() {
        return this._inFlight !== null;
    }
```

- [ ] **Step 4: Add the remaining commands**

Append these methods inside the `CswapClient` class:

```js
    async switchTo(number) {
        return this._runJson(['switch', String(number), '--json']);
    }

    async switchBy(strategy) {
        return this._runJson(['switch', '--strategy', strategy, '--json']);
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
```

- [ ] **Step 5: Run tests to verify they pass**

Run: `/usr/bin/gjs -m tests/run.js; echo "exit=$?"`
Expected: all cswap tests `ok`, `exit=0`.

- [ ] **Step 6: Commit**

```bash
git add cswap.js tests/test-cswap.js
git commit -m "feat: add switch, auto tick, threshold config and single-flight guard"
```

---

### Task 7: Manifest, schema, icon and stylesheet

Static scaffolding. The deliverable is a directory GNOME recognises as an installable extension, verified with `gnome-extensions info`.

**Files:**
- Create: `metadata.json`
- Create: `schemas/org.gnome.shell.extensions.claude-swap.gschema.xml`
- Create: `icons/claude-robot-symbolic.svg`
- Create: `stylesheet.css`

**Interfaces:**
- Consumes: nothing.
- Produces: the settings keys `refresh-interval`, `panel-text`, `show-account-name`, `colour-code-icon`, `auto-switch`, `notify-on-switch`, `cswap-path`; the CSS classes `cswap-ok`, `cswap-warn`, `cswap-crit`, `cswap-switched`, `cswap-stale`, `cswap-usage`; the icon name `claude-robot-symbolic`.

- [ ] **Step 1: Write the manifest**

Create `metadata.json`:

```json
{
  "uuid": "claude-swap@danieljones.net",
  "name": "Claude Swap",
  "description": "Shows the active claude-swap account's rate-limit usage in the top bar, and switches accounts without a terminal.",
  "shell-version": ["50"],
  "settings-schema": "org.gnome.shell.extensions.claude-swap",
  "version": 1
}
```

- [ ] **Step 2: Write the settings schema**

Create `schemas/org.gnome.shell.extensions.claude-swap.gschema.xml`:

```xml
<?xml version="1.0" encoding="UTF-8"?>
<schemalist>
  <enum id="org.gnome.shell.extensions.claude-swap.panel-text">
    <value nick="none" value="0"/>
    <value nick="tightest" value="1"/>
    <value nick="5h" value="2"/>
    <value nick="7d" value="3"/>
    <value nick="both" value="4"/>
  </enum>

  <schema id="org.gnome.shell.extensions.claude-swap"
          path="/org/gnome/shell/extensions/claude-swap/">
    <key name="refresh-interval" type="i">
      <default>60</default>
      <range min="30" max="600"/>
      <summary>Seconds between usage refreshes</summary>
    </key>
    <key name="panel-text" enum="org.gnome.shell.extensions.claude-swap.panel-text">
      <default>'tightest'</default>
      <summary>Which percentages appear beside the panel icon</summary>
    </key>
    <key name="show-account-name" type="b">
      <default>false</default>
      <summary>Prefix the panel text with the account name</summary>
    </key>
    <key name="colour-code-icon" type="b">
      <default>true</default>
      <summary>Tint the panel icon as the tightest window fills</summary>
    </key>
    <key name="auto-switch" type="b">
      <default>false</default>
      <summary>Run an auto-switch tick after each refresh</summary>
    </key>
    <key name="notify-on-switch" type="b">
      <default>true</default>
      <summary>Notify when an auto-switch fires</summary>
    </key>
    <key name="cswap-path" type="s">
      <default>''</default>
      <summary>Path to the cswap binary; empty means auto-detect</summary>
    </key>
  </schema>
</schemalist>
```

- [ ] **Step 3: Compile the schema**

Run: `/usr/bin/glib-compile-schemas schemas/ && ls -l schemas/gschemas.compiled`

Use the absolute path. Bare `glib-compile-schemas` resolves to Homebrew's copy on this machine.

Expected: `schemas/gschemas.compiled` exists and the command prints no errors.

- [ ] **Step 4: Write the icon**

Create `icons/claude-robot-symbolic.svg`. The `-symbolic` suffix is what makes St recolour it from the CSS `color` property:

```xml
<?xml version="1.0" encoding="UTF-8"?>
<svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 16 16">
  <g fill="#000000">
    <circle cx="8" cy="1.45" r="1.05"/>
    <rect x="7.55" y="2.2" width="0.9" height="1.7"/>
    <rect x="0.7" y="7.1" width="1.5" height="3.3" rx="0.75"/>
    <rect x="13.8" y="7.1" width="1.5" height="3.3" rx="0.75"/>
    <path fill-rule="evenodd" d="M5.1 3.75h5.8a2.7 2.7 0 0 1 2.7 2.7v5.05a2.7 2.7 0 0 1-2.7 2.7H5.1a2.7 2.7 0 0 1-2.7-2.7V6.45a2.7 2.7 0 0 1 2.7-2.7Zm0.75 3.5a1.2 1.2 0 1 0 0 2.4 1.2 1.2 0 0 0 0-2.4Zm4.3 0a1.2 1.2 0 1 0 0 2.4 1.2 1.2 0 0 0 0-2.4ZM5.55 11.35h4.9v1.15h-4.9Z"/>
  </g>
</svg>
```

- [ ] **Step 5: Write the stylesheet**

Create `stylesheet.css`:

```css
/* Panel icon colour states. The icon is a symbolic SVG, so `color` recolours it. */
.cswap-ok {
  color: inherit;
}

.cswap-warn {
  color: #f5c211;
}

.cswap-crit {
  color: #ff7b63;
}

.cswap-switched {
  color: #78aeed;
}

.cswap-stale {
  opacity: 0.5;
}

/* The dim second line of an account row. */
.cswap-usage {
  font-size: 0.85em;
  color: rgba(255, 255, 255, 0.55);
}

.cswap-error {
  color: #ff7b63;
}

/* Keep the panel label from crowding the icon. */
.cswap-label {
  padding-left: 4px;
}
```

- [ ] **Step 6: Verify GNOME recognises the extension**

Run: `/usr/bin/gnome-extensions info claude-swap@danieljones.net`

Expected: the command prints the uuid, name, description and `State: INACTIVE` (or `INITIALIZED`). It must not report the extension as missing or the metadata as invalid. There is no `extension.js` yet, so do not try to enable it.

- [ ] **Step 7: Commit**

```bash
git add metadata.json schemas/ icons/ stylesheet.css
git commit -m "feat: add manifest, settings schema, robot icon and stylesheet"
```

Note: `schemas/gschemas.compiled` is a build artifact but must ship with the extension, so it is committed deliberately.

---

### Task 8: indicator.js — the panel button

**Files:**
- Create: `indicator.js`

**Interfaces:**
- Consumes: `panelText`, `iconState` from `format.js` (Task 4); the CSS classes and icon from Task 7.
- Produces: `class ClaudeSwapIndicator extends PanelMenu.Button` with:
  - `new ClaudeSwapIndicator(extension)` — `extension` provides `.path` and `.getSettings()`
  - `render(snapshot)` — `snapshot` is `{accounts, activeAccountNumber}` or `null`
  - `setStale(isStale)`
  - `flashSwitched()`
  - `destroy()`

This task builds the panel half only; the menu is Task 9.

- [ ] **Step 1: Write the implementation**

Create `indicator.js`:

```js
import GObject from 'gi://GObject';
import Clutter from 'gi://Clutter';
import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import St from 'gi://St';

import * as PanelMenu from 'resource:///org/gnome/shell/ui/panelMenu.js';

import {panelText, iconState} from './format.js';

const SWITCH_FLASH_MS = 3000;

export const ClaudeSwapIndicator = GObject.registerClass(
class ClaudeSwapIndicator extends PanelMenu.Button {
    _init(extension) {
        super._init(0.5, 'Claude Swap');

        this._extension = extension;
        this._settings = extension.getSettings();
        this._flashId = 0;
        this._stale = false;

        const box = new St.BoxLayout({style_class: 'panel-status-menu-box'});

        this._icon = new St.Icon({
            gicon: Gio.icon_new_for_string(
                `${extension.path}/icons/claude-robot-symbolic.svg`),
            style_class: 'system-status-icon',
        });

        this._label = new St.Label({
            style_class: 'cswap-label',
            y_align: Clutter.ActorAlign.CENTER,
            text: '',
        });

        box.add_child(this._icon);
        box.add_child(this._label);
        this.add_child(box);

        this._settingsIds = [
            this._settings.connect('changed::panel-text', () => this._reRender()),
            this._settings.connect('changed::show-account-name', () => this._reRender()),
            this._settings.connect('changed::colour-code-icon', () => this._reRender()),
        ];

        this._snapshot = null;
    }

    /** Store a snapshot and redraw. Pass null to show the unknown state. */
    render(snapshot) {
        this._snapshot = snapshot;
        this._reRender();
    }

    _activeAccount() {
        const snap = this._snapshot;
        if (!snap?.accounts?.length)
            return null;
        return snap.accounts.find(a => a.active) ?? null;
    }

    _reRender() {
        const now = Date.now();
        const account = this._activeAccount();

        const prefs = {
            panelText: this._settings.get_string('panel-text'),
            showAccountName: this._settings.get_boolean('show-account-name'),
        };

        const text = panelText(account, prefs, now);
        this._label.text = text;
        this._label.visible = text !== '';

        for (const cls of ['cswap-ok', 'cswap-warn', 'cswap-crit', 'cswap-stale'])
            this._icon.remove_style_class_name(cls);

        if (this._settings.get_boolean('colour-code-icon'))
            this._icon.add_style_class_name(`cswap-${iconState(account, now)}`);

        if (this._stale)
            this._icon.add_style_class_name('cswap-stale');
    }

    setStale(isStale) {
        this._stale = isStale;
        this._reRender();
    }

    /** Tint the icon with the accent colour briefly after an auto-switch. */
    flashSwitched() {
        if (this._flashId) {
            GLib.Source.remove(this._flashId);
            this._flashId = 0;
        }
        this._icon.add_style_class_name('cswap-switched');
        this._flashId = GLib.timeout_add(
            GLib.PRIORITY_DEFAULT, SWITCH_FLASH_MS, () => {
                this._icon.remove_style_class_name('cswap-switched');
                this._flashId = 0;
                return GLib.SOURCE_REMOVE;
            });
    }

    destroy() {
        if (this._flashId) {
            GLib.Source.remove(this._flashId);
            this._flashId = 0;
        }
        for (const id of this._settingsIds)
            this._settings.disconnect(id);
        this._settingsIds = [];
        super.destroy();
    }
});
```

- [ ] **Step 2: Syntax-check the module**

`indicator.js` imports `resource:///` paths that only exist inside a running shell, so it cannot be executed by plain `gjs`. Check that it at least parses:

Run: `/usr/bin/gjs -c "new Function(imports.gi.GLib.file_get_contents('indicator.js')[1] instanceof Uint8Array ? new TextDecoder().decode(imports.gi.GLib.file_get_contents('indicator.js')[1]) : '')" 2>&1 | head -5; echo "exit=$?"`

Expected: no `SyntaxError`. A complaint about `import` statements outside a module is fine and expected — you are only checking for malformed syntax. If that is ambiguous, the real check is Task 11's live load, where a syntax error shows up in `journalctl`.

- [ ] **Step 3: Commit**

```bash
git add indicator.js
git commit -m "feat: add panel button with colour-coded icon and usage label"
```

---

### Task 9: indicator.js — the menu

**Files:**
- Modify: `indicator.js`

**Interfaces:**
- Consumes: `ClaudeSwapIndicator` from Task 8; `accountLabel`, `usageSummary` from `format.js`.
- Produces, on the indicator:
  - `setHandlers({onSwitchTo, onSwitchBy, onRefresh, onToggleAuto, onSetThreshold, onOpenPrefs})`
  - `setNotFound(triedPaths)`
  - `setThresholdChoices(current)`
  - `_rebuildMenu()` — called from `render()`

- [ ] **Step 1: Add the menu imports**

Add to the imports at the top of `indicator.js`:

```js
import * as PopupMenu from 'resource:///org/gnome/shell/ui/popupMenu.js';

import {accountLabel, usageSummary} from './format.js';
```

Merge the `format.js` names into the existing `import {panelText, iconState} from './format.js';` line instead of adding a second import from the same module.

- [ ] **Step 2: Store handlers and the not-found state**

Add to the end of `_init`, replacing the existing `this._snapshot = null;` line:

```js
        this._snapshot = null;
        this._handlers = {};
        this._notFoundPaths = null;
        this._staleAgeText = '';
        this._threshold = null;

        this.menu.connect('open-state-changed', (_menu, isOpen) => {
            if (isOpen && this._handlers.onRefresh)
                this._handlers.onRefresh();
        });
```

- [ ] **Step 3: Add the menu-building methods**

Append these methods inside the class, before `destroy()`:

```js
    setHandlers(handlers) {
        this._handlers = handlers;
    }

    /** Show the terminal "no binary" state instead of account rows. */
    setNotFound(triedPaths) {
        this._notFoundPaths = triedPaths;
        this._stale = true;
        this._reRender();
        this._rebuildMenu();
    }

    setStaleAge(text) {
        this._staleAgeText = text;
    }

    setThresholdChoices(current) {
        this._threshold = current;
        this._rebuildMenu();
    }

    _addAccountRow(account) {
        const item = new PopupMenu.PopupBaseMenuItem();
        const box = new St.BoxLayout({vertical: true, x_expand: true});

        box.add_child(new St.Label({text: accountLabel(account)}));
        box.add_child(new St.Label({
            text: usageSummary(account, Date.now()),
            style_class: 'cswap-usage',
        }));

        item.add_child(box);
        item.setOrnament(account.active
            ? PopupMenu.Ornament.DOT
            : PopupMenu.Ornament.NONE);

        item.connect('activate', () => {
            if (this._handlers.onSwitchTo)
                this._handlers.onSwitchTo(account.number);
        });

        this.menu.addMenuItem(item);
    }

    _addInsensitive(text, styleClass = null) {
        const item = new PopupMenu.PopupMenuItem(text, {reactive: false});
        if (styleClass)
            item.label.add_style_class_name(styleClass);
        this.menu.addMenuItem(item);
        return item;
    }

    _rebuildMenu() {
        this.menu.removeAll();

        if (this._notFoundPaths) {
            this._addInsensitive('cswap not found', 'cswap-error');
            for (const p of this._notFoundPaths)
                this._addInsensitive(`  ${p}`, 'cswap-usage');
            this.menu.addMenuItem(new PopupMenu.PopupSeparatorMenuItem());
            const prefs = new PopupMenu.PopupMenuItem('Set path in Settings…');
            prefs.connect('activate', () => this._handlers.onOpenPrefs?.());
            this.menu.addMenuItem(prefs);
            return;
        }

        if (this._staleAgeText)
            this._addInsensitive(this._staleAgeText, 'cswap-usage');

        const accounts = this._snapshot?.accounts ?? [];
        if (accounts.length === 0)
            this._addInsensitive('No managed accounts');
        else
            accounts.forEach(a => this._addAccountRow(a));

        this.menu.addMenuItem(new PopupMenu.PopupSeparatorMenuItem());

        for (const [label, strategy] of [
            ['Rotate to next', null],
            ['Switch to best', 'best'],
            ['Next available', 'next-available'],
        ]) {
            const item = new PopupMenu.PopupMenuItem(label);
            item.connect('activate', () => this._handlers.onSwitchBy?.(strategy));
            item.setSensitive(accounts.length > 0);
            this.menu.addMenuItem(item);
        }

        this.menu.addMenuItem(new PopupMenu.PopupSeparatorMenuItem());

        const auto = new PopupMenu.PopupSwitchMenuItem(
            'Auto-switch', this._settings.get_boolean('auto-switch'));
        auto.connect('toggled', (_item, state) =>
            this._handlers.onToggleAuto?.(state));
        this.menu.addMenuItem(auto);

        const thresholdMenu = new PopupMenu.PopupSubMenuMenuItem(
            this._threshold === null
                ? 'Threshold'
                : `Threshold — ${this._threshold}%`);
        for (const pct of [80, 90, 95, 98]) {
            const choice = new PopupMenu.PopupMenuItem(`${pct}%`);
            if (pct === this._threshold)
                choice.setOrnament(PopupMenu.Ornament.DOT);
            choice.connect('activate', () => this._handlers.onSetThreshold?.(pct));
            thresholdMenu.menu.addMenuItem(choice);
        }
        this.menu.addMenuItem(thresholdMenu);

        this.menu.addMenuItem(new PopupMenu.PopupSeparatorMenuItem());

        const refresh = new PopupMenu.PopupMenuItem('Refresh now');
        refresh.connect('activate', () => this._handlers.onRefresh?.());
        this.menu.addMenuItem(refresh);

        const settings = new PopupMenu.PopupMenuItem('Settings…');
        settings.connect('activate', () => this._handlers.onOpenPrefs?.());
        this.menu.addMenuItem(settings);
    }
```

- [ ] **Step 4: Rebuild the menu whenever a snapshot lands**

In `render()`, add the menu rebuild after the panel redraw:

```js
    render(snapshot) {
        this._snapshot = snapshot;
        this._notFoundPaths = null;
        this._reRender();
        this._rebuildMenu();
    }
```

- [ ] **Step 5: Commit**

```bash
git add indicator.js
git commit -m "feat: add account rows, switch actions and auto-switch menu"
```

---

### Task 10: indicator.js — polling, auto-switch and failure backoff

The teardown-during-poll case from Review Focus is the one to get right here: a callback that touches `this._icon` after `destroy()` has run will throw inside a GLib callback, which in GNOME Shell means an error in the journal and a half-dead extension.

**Files:**
- Modify: `indicator.js`

**Interfaces:**
- Consumes: `CswapClient` (Task 5, 6); the indicator from Tasks 8 and 9.
- Produces, on the indicator:
  - `start(client)` — resolves the binary, wires handlers, begins polling
  - `stop()` — cancels everything

- [ ] **Step 1: Add the polling state**

Add to `_init`, after `this._threshold = null;`:

```js
        this._client = null;
        this._timerId = 0;
        this._destroyed = false;
        this._failures = 0;
        this._lastGoodAt = 0;
        this._blockedNotifiedAt = 0;

        this._settingsIds.push(
            this._settings.connect('changed::refresh-interval',
                () => this._restartTimer()));
```

- [ ] **Step 2: Add the Main import for notifications**

Add to the imports at the top of `indicator.js`:

```js
import * as Main from 'resource:///org/gnome/shell/ui/main.js';
```

- [ ] **Step 3: Add the polling methods**

Append inside the class, before `destroy()`:

```js
    start(client) {
        this._client = client;

        this.setHandlers({
            onSwitchTo: n => this._doSwitch(() => client.switchTo(n)),
            onSwitchBy: strategy => this._doSwitch(() =>
                strategy === null
                    ? client.switchBy('next-available')
                    : client.switchBy(strategy)),
            onRefresh: () => this._poll(),
            onToggleAuto: state => this._settings.set_boolean('auto-switch', state),
            onSetThreshold: pct => this._doSetThreshold(pct),
            onOpenPrefs: () => this._extension.openPreferences(),
        });

        if (!client.found) {
            this.setNotFound(client.triedPaths);
            return;
        }

        this._poll();
        this._restartTimer();
    }

    stop() {
        this._destroyed = true;
        if (this._timerId) {
            GLib.Source.remove(this._timerId);
            this._timerId = 0;
        }
        this._client?.destroy();
        this._client = null;
    }

    _interval() {
        // Back off after repeated failures so a broken cswap does not spawn a
        // process every minute forever.
        return this._failures >= 3
            ? 300
            : this._settings.get_int('refresh-interval');
    }

    _restartTimer() {
        if (this._timerId) {
            GLib.Source.remove(this._timerId);
            this._timerId = 0;
        }
        if (this._destroyed || !this._client?.found)
            return;
        this._timerId = GLib.timeout_add_seconds(
            GLib.PRIORITY_DEFAULT, this._interval(), () => {
                this._poll();
                return GLib.SOURCE_CONTINUE;
            });
    }

    async _poll() {
        if (this._destroyed || !this._client || this._client.busy)
            return;

        const wasBackedOff = this._failures >= 3;

        try {
            const snapshot = await this._client.listAccounts();
            if (this._destroyed)
                return;

            this._failures = 0;
            this._lastGoodAt = Date.now();
            this.setStaleAge('');
            this._stale = false;
            this.render(snapshot);

            if (wasBackedOff)
                this._restartTimer();

            if (this._settings.get_boolean('auto-switch'))
                await this._autoTick();
        } catch (e) {
            if (this._destroyed)
                return;
            this._failures++;
            console.warn(`claude-swap: refresh failed: ${e.message}`);
            this._markStale();
            if (this._failures === 3)
                this._restartTimer();
        }
    }

    _markStale() {
        if (this._lastGoodAt) {
            const mins = Math.floor((Date.now() - this._lastGoodAt) / 60000);
            this.setStaleAge(`stale — last read ${mins}m ago`);
        } else {
            this.setStaleAge('no usage data yet');
        }
        this.setStale(true);
        this._rebuildMenu();
    }

    async _autoTick() {
        try {
            const {code, events} = await this._client.autoOnce({});
            if (this._destroyed)
                return;

            if (code === 0) {
                this.flashSwitched();
                if (this._settings.get_boolean('notify-on-switch')) {
                    const to = events.find(e => e.to !== undefined)?.to;
                    Main.notify('Claude Swap',
                        to !== undefined
                            ? `Switched to account ${to}`
                            : 'Switched account');
                }
                await this._poll();
            } else if (code === 3) {
                // Rate-limit this notification: an all-exhausted state would
                // otherwise fire one every tick.
                const now = Date.now();
                if (now - this._blockedNotifiedAt > 3600000) {
                    this._blockedNotifiedAt = now;
                    Main.notify('Claude Swap',
                        'No account has headroom to switch to');
                }
            } else if (code === 1) {
                console.warn('claude-swap: auto-switch tick reported an error');
            }
        } catch (e) {
            if (!this._destroyed)
                console.warn(`claude-swap: auto-switch failed: ${e.message}`);
        }
    }

    async _doSwitch(fn) {
        try {
            await fn();
        } catch (e) {
            if (!this._destroyed)
                Main.notifyError('Claude Swap', e.message.split('\n')[0]);
        }
        // Refresh whether it worked or not, so the panel never shows a stale
        // active account after a failed switch.
        if (!this._destroyed)
            await this._poll();
    }

    async _doSetThreshold(pct) {
        try {
            await this._client.setThreshold(pct);
            if (!this._destroyed)
                this.setThresholdChoices(pct);
        } catch (e) {
            if (!this._destroyed)
                Main.notifyError('Claude Swap', e.message.split('\n')[0]);
        }
    }
```

- [ ] **Step 4: Fetch the threshold when the menu opens**

Replace the `open-state-changed` handler added in Task 9 Step 2 with one that also refreshes the threshold, so the submenu is correct without blocking the menu:

```js
        this.menu.connect('open-state-changed', (_menu, isOpen) => {
            if (!isOpen || !this._client?.found)
                return;
            // Sequential, not concurrent: the client is single-flight, so
            // firing both at once would reject one of them as busy.
            this._poll()
                .then(() => this._client?.getThreshold())
                .then(pct => {
                    if (!this._destroyed && pct !== undefined && pct !== null)
                        this.setThresholdChoices(pct);
                })
                .catch(() => {});
        });
```

- [ ] **Step 5: Cancel everything on destroy**

Replace `destroy()` with:

```js
    destroy() {
        this.stop();
        if (this._flashId) {
            GLib.Source.remove(this._flashId);
            this._flashId = 0;
        }
        for (const id of this._settingsIds)
            this._settings.disconnect(id);
        this._settingsIds = [];
        super.destroy();
    }
```

- [ ] **Step 6: Verify the teardown-in-flight case**

This is Review Focus item 1, and it cannot be covered by the `gjs` suite because it needs a live shell. Verify it in the nested shell in Task 11 Step 6 with the stub binary configured to sleep, then toggle the extension off mid-poll and confirm the journal is clean.

For now, confirm by reading the code that every `await` in `_poll`, `_autoTick`, `_doSwitch` and `_doSetThreshold` is followed by a `this._destroyed` check before any actor is touched. There are seven such points. List them in the commit message.

- [ ] **Step 7: Commit**

```bash
git add indicator.js
git commit -m "feat: add poll timer, auto-switch tick and failure backoff"
```

---

### Task 11: extension.js, prefs.js, and live verification

**Files:**
- Create: `extension.js`
- Create: `prefs.js`

**Interfaces:**
- Consumes: `ClaudeSwapIndicator` (Tasks 8–10), `CswapClient` (Tasks 5–6).
- Produces: the extension entry point.

- [ ] **Step 1: Write the entry point**

Create `extension.js`:

```js
import {Extension} from 'resource:///org/gnome/shell/extensions/extension.js';
import * as Main from 'resource:///org/gnome/shell/ui/main.js';

import {ClaudeSwapIndicator} from './indicator.js';
import {CswapClient} from './cswap.js';

export default class ClaudeSwapExtension extends Extension {
    enable() {
        const settings = this.getSettings();

        this._indicator = new ClaudeSwapIndicator(this);
        Main.panel.addToStatusArea('claude-swap', this._indicator);

        this._client = new CswapClient({
            pathOverride: settings.get_string('cswap-path'),
        });
        this._indicator.start(this._client);

        this._pathChangedId = settings.connect('changed::cswap-path', () => {
            this._indicator.stop();
            this._client = new CswapClient({
                pathOverride: settings.get_string('cswap-path'),
            });
            this._indicator.start(this._client);
        });
        this._settings = settings;
    }

    disable() {
        if (this._pathChangedId) {
            this._settings.disconnect(this._pathChangedId);
            this._pathChangedId = null;
        }
        this._settings = null;

        this._indicator?.destroy();
        this._indicator = null;

        this._client?.destroy();
        this._client = null;
    }
}
```

- [ ] **Step 2: Write the preferences window**

Create `prefs.js`:

```js
import Adw from 'gi://Adw';
import Gio from 'gi://Gio';
import Gtk from 'gi://Gtk';

import {ExtensionPreferences} from
    'resource:///org/gnome/Shell/Extensions/js/extensions/prefs.js';

export default class ClaudeSwapPreferences extends ExtensionPreferences {
    fillPreferencesWindow(window) {
        const settings = this.getSettings();

        const page = new Adw.PreferencesPage();
        window.add(page);

        const panelGroup = new Adw.PreferencesGroup({title: 'Panel'});
        page.add(panelGroup);

        const panelTextRow = new Adw.ComboRow({
            title: 'Percentages beside the icon',
            model: Gtk.StringList.new([
                'None', 'Tightest window', '5-hour', '7-day', 'Both',
            ]),
        });
        const panelTextValues = ['none', 'tightest', '5h', '7d', 'both'];
        panelTextRow.selected =
            panelTextValues.indexOf(settings.get_string('panel-text'));
        panelTextRow.connect('notify::selected', row =>
            settings.set_string('panel-text', panelTextValues[row.selected]));
        panelGroup.add(panelTextRow);

        const nameRow = new Adw.SwitchRow({title: 'Show account name'});
        settings.bind('show-account-name', nameRow, 'active',
            Gio.SettingsBindFlags.DEFAULT);
        panelGroup.add(nameRow);

        const colourRow = new Adw.SwitchRow({
            title: 'Colour the icon by usage',
            subtitle: 'Amber above 80%, red above 95%',
        });
        settings.bind('colour-code-icon', colourRow, 'active',
            Gio.SettingsBindFlags.DEFAULT);
        panelGroup.add(colourRow);

        const behaviourGroup = new Adw.PreferencesGroup({title: 'Behaviour'});
        page.add(behaviourGroup);

        const intervalRow = new Adw.SpinRow({
            title: 'Refresh interval',
            subtitle: 'Seconds between usage reads',
            adjustment: new Gtk.Adjustment({
                lower: 30, upper: 600, step_increment: 30, page_increment: 60,
            }),
        });
        settings.bind('refresh-interval', intervalRow, 'value',
            Gio.SettingsBindFlags.DEFAULT);
        behaviourGroup.add(intervalRow);

        const notifyRow = new Adw.SwitchRow({
            title: 'Notify on auto-switch',
            subtitle: 'Manual switches are never announced',
        });
        settings.bind('notify-on-switch', notifyRow, 'active',
            Gio.SettingsBindFlags.DEFAULT);
        behaviourGroup.add(notifyRow);

        const advancedGroup = new Adw.PreferencesGroup({
            title: 'Advanced',
            description:
                'GNOME Shell does not search ~/.local/bin, so the cswap ' +
                'binary is resolved by absolute path. Leave this empty to ' +
                'auto-detect.',
        });
        page.add(advancedGroup);

        const pathRow = new Adw.EntryRow({title: 'Path to cswap'});
        settings.bind('cswap-path', pathRow, 'text',
            Gio.SettingsBindFlags.DEFAULT);
        advancedGroup.add(pathRow);
    }
}
```

- [ ] **Step 3: Confirm the whole suite still passes**

Run: `/usr/bin/gjs -m tests/run.js; echo "exit=$?"`
Expected: every test `ok`, `exit=0`.

- [ ] **Step 4: Recompile the schema and check the extension loads**

```bash
/usr/bin/glib-compile-schemas schemas/
/usr/bin/gnome-extensions info claude-swap@danieljones.net
```

Expected: no schema errors; the info output shows the extension and its version.

- [ ] **Step 5: Verify in a nested shell**

Follow the recipe in the `gnome-shell-nested-dev-loop` memory file. In outline: enable the extension in a throwaway dconf database under `dbus-run-session`, then launch `gnome-shell --devkit` against it. Do **not** pass `--virtual-monitor` — it makes the top bar look blank by rendering it at a fraction of the stage width.

Confirm by eye, in this order:

1. The robot icon appears in the panel with `70%` (or whatever your current usage is) beside it.
2. **The icon is recoloured, not black.** This is the one real technical risk in the plan: St recolours a `GFileIcon` whose basename ends in `-symbolic.svg`, but if the icon renders as a solid black or unstyled shape, the fallback is to register the icons directory with the icon theme in `enable()` and switch `St.Icon` from `gicon:` to `icon_name: 'claude-robot-symbolic'`. Decide this from what you see, not from what should happen.
3. Opening the menu shows both accounts with the dot on the active one.
4. The threshold submenu shows `90%` selected, matching `cswap config`.

- [ ] **Step 6: Verify the teardown-in-flight case (Review Focus 1)**

In the nested session, point `cswap-path` at `tests/stub-cswap.sh` with `STUB_SLEEP=5`, open the menu to start a poll, and disable the extension while that poll is in flight:

```bash
/usr/bin/gnome-extensions disable claude-swap@danieljones.net
```

Then check the log:

```bash
journalctl --user -b --since "2 minutes ago" | grep -i -E 'claude-swap|JS ERROR' | head -20
```

Expected: no `JS ERROR` mentioning claude-swap, and no complaint about an actor being destroyed or finalized. If one appears, an `await` is missing its `this._destroyed` guard.

- [ ] **Step 7: Verify the auto-switch path without mutating credentials**

```bash
~/.local/bin/cswap auto --once --dry-run --json; echo "exit=$?"
```

Expected: JSON event lines and an exit code of 0, 2 or 3 — it decides and logs but changes nothing. Confirm the account did not actually change:

```bash
~/.local/bin/cswap status --json | head -5
```

- [ ] **Step 8: Commit**

```bash
git add extension.js prefs.js
git commit -m "feat: add extension entry point and preferences window"
```

- [ ] **Step 9: Enable it live**

Enabling requires a logout and login — GNOME 50 has no live reload path on Wayland, and `ReloadExtension` is deprecated and does not work.

```bash
/usr/bin/gnome-extensions enable claude-swap@danieljones.net
```

After logging back in:

```bash
/usr/bin/gnome-extensions info claude-swap@danieljones.net | grep State
```

Expected: `State: ACTIVE`.

Disabling, unlike enabling, takes effect immediately — so rollback never needs a logout.
