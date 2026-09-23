# Claude Swap indicator — design

Date: 2026-09-23
Status: approved for planning
UUID: `claude-swap@danieljones.net`

## Purpose

`cswap menubar` is a macOS-only menu bar app (`claude_swap/menubar.py`, built on
`rumps`) that surfaces claude-swap's multi-account state and lets the user switch
accounts without dropping to a terminal. On Fedora Silverblue with GNOME 50 it
does not run at all. This extension ports that role to the GNOME top bar.

Success means: the active Claude account and how close it is to its rate limits
are legible at a glance from the panel, switching accounts takes two clicks, and
auto-switching can be turned on and tuned without opening a terminal.

### Scope

In scope — monitor and switch:

- panel indicator showing the active account's usage
- account rows with live 5h/7d utilisation, click to switch
- the three switch actions (rotate to next, switch to best, next available)
- auto-switch on/off and its threshold
- display preferences

Out of scope, deliberately — these stay in the CLI and TUI, which already have
better affordances for them than a panel menu does:

- adding accounts (needs an OAuth browser flow and a setup-token text entry)
- removing accounts (destructive, needs a confirmation dialog)
- disabling/enabling accounts
- refreshing credentials
- switch history (`claude-swap.log` parsing)

Per-model weekly limits ("scoped" windows, e.g. Fable) are not rendered: neither
managed account currently returns any. The formatter must tolerate them
appearing later without throwing, but nothing displays them.

## Constraints discovered during design

These are measured facts about this machine, not assumptions. Each one changes
the design.

1. **GNOME Shell cannot see `cswap` on PATH.** The systemd user environment's
   PATH is `/usr/local/sbin:/usr/local/bin:/usr/bin`. `cswap` lives at
   `~/.local/bin/cswap` (a symlink into the uv tool venv). A plain
   `Gio.Subprocess(['cswap', ...])` fails with ENOENT inside the shell while
   working in every terminal test. The binary must be resolved explicitly.
2. **`cswap list --json` costs ~140ms warm and ~30MB RSS**, and respects
   claude-swap's own poll policy (`nextPollAt`, `pollIntervalS` in
   `cache/usage.json`), so repeated invocations do not hit the network on every
   call. Polling on a 60s timer is acceptable.
3. **`cswap auto --once` reports its outcome in the exit code**: 0 switched,
   1 error, 2 no action needed, 3 blocked (no viable target / all exhausted).
   With `--json` it emits one JSON event per line. `--dry-run` decides and logs
   without mutating credentials.
4. **Schema-v1 JSON already contains pace analysis** (`aheadOfPace`,
   `expectedPct`, `projectedExhaustionAt`, `willLastToReset`), so
   `claude_swap/pace.py` does not need porting.
5. **Adwaita ships no robot icon.** A symbolic SVG must be bundled.

## Architecture

The extension is a thin GJS shell over the `cswap` CLI, mirroring the way
`menubar.py` is a thin shell over the Python API — it re-implements no account,
usage, or auto-switch logic. All data comes from the documented schema-v1 JSON
(`cswap list --json`, `cswap status --json`); no internal cache file is read, so
the extension is not coupled to claude-swap's private on-disk formats.

```
extension.js     enable/disable only
  └─ indicator.js    all St / PanelMenu / PopupMenu; owns timer + last-good state
       ├─ cswap.js   async Gio.Subprocess wrapper; the only file that knows cswap exists
       └─ format.js  pure display functions; imports nothing from GNOME
prefs.js         GTK4/Adwaita preferences window
```

### `cswap.js` — `CswapClient`

The process boundary. Knows nothing about St or the panel.

- Resolves the binary once at construction, in order:
  1. the `cswap-path` GSettings key, when non-empty
  2. `GLib.find_program_in_path('cswap')`
  3. `~/.local/bin/cswap`
  4. `~/.local/share/uv/tools/claude-swap/bin/cswap`

  If none is executable, the client enters a permanent `notFound` state carrying
  the list of paths tried, and every call rejects with it.
- `listAccounts()` → parsed `cswap list --json`
- `switchTo(number)` → `cswap switch <n> --json`
- `switchBy(strategy)` → `cswap switch --strategy best|next-available --json`
- `autoOnce({dryRun})` → runs `cswap auto --once --json`, resolves
  `{code, events}` rather than rejecting on non-zero, because 2 and 3 are
  normal outcomes rather than errors
- `getConfig()` / `setConfig(key, value)` → `cswap config`, `cswap config set`

`listAccounts()` and `switchTo`/`switchBy` check the payload's `schemaVersion`
and log a warning once per session when it is not 1, rather than assuming the
shape (see Risks).

Every call runs through `Gio.Subprocess.communicate_utf8_async` with a
`Gio.Cancellable`, a 10-second `GLib.timeout` that cancels and rejects, and a
single-flight guard so a slow tick cannot overlap the next one. The cancellable
is cancelled in `disable()`.

### `format.js` — pure display functions

No GNOME imports, so it runs under plain `gjs` for tests. Ported from
`menubar.py` but consuming schema-v1 camelCase rather than the internal
snake_case shape.

| Function | Ported from | Notes |
|---|---|---|
| `tightestPct(usage)` | `tightest_pct` | max of 5h/7d pct; spend excluded — it is not a rate-limit window |
| `liveCountdown(resetsAt, now)` | `_live_countdown` | recomputed from the absolute `resetsAt`; the JSON's own `countdown` string is frozen at fetch time and goes wrong between polls |
| `rolledWeeklyWindow(window, now)` | `_rolled_weekly_window` | a 7d window whose `resetsAt` has passed rolls to the next 7-day boundary with pct 0 |
| `usageSummary(usage, now)` | `usage_summary` | `5h 70% (3h 41m) · 7d 45% (3d 8h)`, appends `(ahead)` when `aheadOfPace` |
| `accountLabel(account, now)` | `format_account_label` | alias when set, else email local part |
| `panelText(account, prefs, now)` | `format_title` | drives the panel label |

`liveCountdown` and `rolledWeeklyWindow` are the two that must not be skipped:
without them a panel rendering cached data between polls shows a countdown that
is minutes-to-days stale, and a weekly percentage belonging to a window that has
already reset.

### `indicator.js` — `ClaudeSwapIndicator extends PanelMenu.Button`

Owns the refresh timer, the last-good snapshot, the failure counter, and menu
construction. Added to the right cluster via
`Main.panel.addToStatusArea('claude-swap', indicator)`.

## Panel presentation

A bundled symbolic icon plus, by default, the tightest percentage.

`icons/claude-robot-symbolic.svg` — the `-symbolic` suffix is what makes St
recolour the icon from the CSS `color` property, which is what makes
colour-coding possible; a non-symbolic name renders at a fixed colour.

Colour is driven by a single CSS class swapped on the `St.Icon`:

| Class | Condition | Colour |
|---|---|---|
| `cswap-ok` | tightest < 80% | inherits panel foreground |
| `cswap-warn` | 80% ≤ tightest ≤ 95% | amber |
| `cswap-crit` | tightest > 95% | red |
| `cswap-switched` | 3s after an auto-switch fires | GNOME accent colour |
| `cswap-stale` | last poll failed, or `notFound` | 50% opacity |

`cswap-switched` is applied for 3 seconds then reverted; its timeout is tracked
and removed on disable.

## Menu

```
  ● alice                                  active row carries the ornament
    5h 70% (3h 41m) · 7d 45% (3d 8h)       dim sub-label
    bob
    5h  0% · 7d 67% (7h 21m)
  ─────────────────────────────
    Rotate to next
    Switch to best
    Next available
  ─────────────────────────────
    Auto-switch                  [ off ]
      Threshold      80 · 90 · 95 · 98
  ─────────────────────────────
    Refresh now
    Settings…
```

`Refresh now` runs the same `listAccounts()` as a timer tick; claude-swap's own
poll policy still decides whether that reaches the network, so the item is a
re-read rather than a forced API call.

Account rows are `PopupBaseMenuItem`s containing a vertical `St.BoxLayout` with
the label and a `.cswap-usage` sub-label; the active row uses
`PopupMenu.Ornament.DOT`. Clicking a row switches to that account. Opening the
menu triggers an immediate refresh so the numbers are never stale on inspection.

When the account list is empty the rows are replaced by a single insensitive
`No managed accounts` item. When the client is in `notFound` state they are
replaced by `cswap not found` plus the paths tried.

## Settings

Split deliberately, following the same reasoning as `MenuBarSettings`' docstring.

**Extension-local**, in `org.gnome.shell.extensions.claude-swap`:

| Key | Type | Default | Meaning |
|---|---|---|---|
| `refresh-interval` | `i` | 60 | seconds; 30, 60 or 300 |
| `panel-text` | `s` | `tightest` | `none`, `tightest`, `5h`, `7d`, `both` |
| `show-account-name` | `b` | `false` | prefix the panel text with alias/local part |
| `colour-code-icon` | `b` | `true` | when false the icon stays panel foreground |
| `auto-switch` | `b` | `false` | run an auto tick after each poll |
| `notify-on-switch` | `b` | `true` | notify when an *auto*-switch fires; manual switches are never notified, the user just made them |
| `cswap-path` | `s` | `""` | override; empty means auto-detect |

`show-account-name` defaults to false and `panel-text` to `tightest` because the
top bar on this machine is already dense — the macOS default of name plus two
percentages is roughly 190px.

**Not duplicated** — auto-switch policy is core configuration, read and written
through `cswap config` / `cswap config set autoswitch.*`. The threshold submenu
writes `autoswitch.threshold`, so the panel, `cswap auto` in a terminal, and the
TUI share one source of truth. The cost is that the submenu depends on a
subprocess call. It is seeded from the last known value and refreshed by a
`getConfig()` issued when the menu opens, so it renders immediately and corrects
itself a moment later rather than blocking the menu.

The `auto-switch` toggle itself is extension-local, because it controls whether
*this process* ticks — matching macOS, where the engine lives and dies with the
GUI.

## Polling and auto-switch

A single `GLib.timeout_add_seconds` at `refresh-interval`. Each tick:

1. `listAccounts()`. On success, store the snapshot, reset the failure counter,
   rebuild the menu and panel label.
2. If `auto-switch` is on, `autoOnce()`. Map the exit code:
   - `0` — a switch happened. Notify when `notify-on-switch`, apply the
     `cswap-switched` class, and refresh immediately rather than waiting a tick.
   - `2` — no action needed. Silent.
   - `3` — blocked, nothing viable. Notify at most once per hour, so an
     all-accounts-exhausted state does not produce a notification every minute.
   - `1` — error. Log to the extension's logger, count as a failure.

The timer is recreated when `refresh-interval` changes and removed in `disable()`.

## Failure handling

No failure is allowed to blank the panel or throw out of a callback.

- **Any poll failure** keeps the last-good snapshot. The menu gains a
  `stale (4m)` header — an insensitive item inserted above the account rows,
  present only while stale — derived from the last successful fetch time, and
  the icon takes `cswap-stale`. This mirrors claude-swap's own last-good semantics.
- **Three consecutive failures** back the interval off to 300s until one
  succeeds, then it returns to the configured value.
- **`notFound`** is a distinct terminal state, not a generic error: polling
  never starts, and the menu names the paths that were tried. Given constraint 1
  this is the single most likely first-run failure, so it must be self-
  explanatory rather than silent.
- **A failed switch** raises `Main.notifyError` with the first line of stderr.
- **Malformed JSON** is treated as a poll failure; the parse is wrapped and the
  raw output logged once per occurrence.

## Testing

- `format.js` is developed test-first under plain `gjs`, against fixtures
  captured from real `cswap list --json` output and hand-edited variants:
  an expired weekly window (exercises `rolledWeeklyWindow`), a missing
  `resetsAt`, `usageStatus` other than `ok`, an empty account list, and a
  `scoped` array present. No shell restart in this loop.
- `CswapClient` is exercised against a stub script on `cswap-path` that emits
  canned stdout and exit codes, covering 0/1/2/3, a timeout, and malformed JSON.
- The auto-switch path is exercised live with `cswap auto --once --dry-run`,
  which decides and logs without mutating credentials.
- Live verification uses the nested-shell loop recorded in memory: `gnome-shell
  --devkit` with the layered `mutter-devkit` package, a throwaway dconf database
  under `dbus-run-session`, and the in-process `Shell.Screenshot` trick. A real
  switch is tested only once, deliberately, at the end.

## Files

```
claude-swap@danieljones.net/
├── metadata.json
├── extension.js
├── indicator.js
├── cswap.js
├── format.js
├── prefs.js
├── stylesheet.css
├── icons/claude-robot-symbolic.svg
├── schemas/org.gnome.shell.extensions.claude-swap.gschema.xml
├── tests/            gjs-run unit tests + JSON fixtures
└── docs/superpowers/specs/
```

`metadata.json` declares `shell-version: ["50"]` and
`settings-schema: org.gnome.shell.extensions.claude-swap`.

## Risks

- **claude-swap is a moving target** (0.26.0 today, with a self-upgrade
  command). The extension depends on `schemaVersion: 1` for list/status and on
  the documented `auto --once` exit codes. The client should log a warning when
  `schemaVersion` is not 1 rather than assuming the shape.
- **A switch rewrites `~/.claude/.credentials.json` under a lock.** Switching
  while Claude Code is running is claude-swap's problem, not the extension's,
  but a failed switch must surface clearly rather than leaving the panel showing
  a stale active account — hence the immediate refresh after any switch attempt,
  success or failure.
