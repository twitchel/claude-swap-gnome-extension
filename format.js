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
