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
