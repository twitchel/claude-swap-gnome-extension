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

/**
 * The account list from a snapshot, always as an array of objects.
 *
 * claude-swap self-upgrades, so a future release could change this shape.
 * Callers render from the result directly, and `undefined.length === 0` is
 * false — which would sail past an emptiness check and throw on forEach,
 * after the menu had already been torn down.
 */
export function accountsOf(snapshot) {
    const accounts = snapshot?.accounts;
    if (!Array.isArray(accounts))
        return [];
    return accounts.filter(a => a && typeof a === 'object');
}

/**
 * A string that changes exactly when the rendered rows would change.
 *
 * Rebuilding the menu destroys and recreates every item, which closes any open
 * submenu under the user's cursor, so it is worth doing only when something
 * actually differs.
 */
export function snapshotSignature(snapshot, nowMs) {
    return accountsOf(snapshot)
        .map(a => [
            a.number,
            a.active ? '*' : '-',
            accountLabel(a),
            usageSummary(a, nowMs),
        ].join('|'))
        .join('\n');
}
