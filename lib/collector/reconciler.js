/**
 * Reconciliation: recompute expected per-session usage totals directly from
 * the session logs and compare them with the ledger.
 *
 * The extraction here is deliberately simpler than the collector's
 * normalizer — it only sums token fields from the three usage-bearing event
 * types — so a shared normalizer bug cannot hide behind itself. Attempt
 * streams are read from their terminal `usage` chunk; anything unexpected is
 * skipped rather than guessed.
 */
const EMPTY = {
    requests: 0, inputTokens: 0, outputTokens: 0,
    cacheReadTokens: 0, cacheWriteTokens: 0, totalTokens: 0,
};
function addUsage(sums, usage) {
    if (typeof usage !== 'object' || usage === null)
        return;
    const u = usage;
    const num = (v) => (typeof v === 'number' && Number.isFinite(v) ? v : 0);
    sums.requests += 1;
    sums.inputTokens += num(u.inputTokens);
    sums.outputTokens += num(u.outputTokens);
    sums.cacheReadTokens += num(u.cacheReadTokens);
    sums.cacheWriteTokens += num(u.cacheWriteTokens);
    sums.totalTokens += num(u.totalTokens);
}
/** Terminal usage chunk of an embedded attempt stream, or null. */
function attemptUsage(stream) {
    if (!Array.isArray(stream))
        return null;
    for (let i = stream.length - 1; i >= 0; i -= 1) {
        const record = stream[i];
        if (typeof record !== 'object' || record === null)
            continue;
        const chunk = record.chunk;
        if (typeof chunk === 'object' && chunk !== null &&
            chunk.type === 'usage') {
            return chunk.usage;
        }
    }
    return null;
}
function expectedSums(events) {
    const sums = { ...EMPTY };
    for (const event of events) {
        if (typeof event !== 'object' || event === null)
            continue;
        const data = event.data;
        if (typeof data !== 'object' || data === null)
            continue;
        const d = data;
        if (event.type === 'assistant/message' || event.type === 'compaction/summary') {
            addUsage(sums, d.usage);
        }
        else if (event.type === 'assistant/attempt') {
            const usage = attemptUsage(d.stream);
            if (usage !== null)
                addUsage(sums, usage);
        }
    }
    return sums;
}
/**
 * Full reconciliation pass. Reads every session through `sessionQuery`
 * (bounded by the same worker pattern as the importer, sequentially here —
 * this is a diagnostic path, not a hot one) and diffs against the ledger.
 */
export async function reconcileAgainstLogs(sessionQuery, store) {
    const ledger = store.usageBySession();
    const diffs = [];
    const errors = [];
    const mismatched = new Set();
    const ledgerTotals = { ...EMPTY };
    const expectedTotals = { ...EMPTY };
    const compared = new Set();
    const sessions = await sessionQuery.listSessions();
    for (const entry of sessions) {
        const sessionId = entry.header?.id;
        if (typeof sessionId !== 'string' || sessionId.length === 0 || compared.has(sessionId))
            continue;
        compared.add(sessionId);
        try {
            const snapshot = await sessionQuery.readSession(sessionId);
            const expected = expectedSums(snapshot.events ?? []);
            for (const key of Object.keys(expected)) {
                expectedTotals[key] += expected[key];
            }
            const row = ledger.get(sessionId);
            const ledgerSums = row ?? { ...EMPTY };
            if (row !== undefined) {
                for (const key of Object.keys(ledgerSums)) {
                    ledgerTotals[key] += ledgerSums[key];
                }
            }
            for (const key of Object.keys(expected)) {
                if (ledgerSums[key] !== expected[key]) {
                    diffs.push({ sessionId, field: key, ledger: ledgerSums[key], expected: expected[key] });
                    mismatched.add(sessionId);
                }
            }
        }
        catch (error) {
            errors.push({ sessionId, error: String(error?.message ?? error) });
        }
    }
    // Sessions present in the ledger but missing from the listing.
    for (const sessionId of ledger.keys()) {
        if (!compared.has(sessionId)) {
            errors.push({ sessionId, error: 'present in ledger but not listed by sessionQuery' });
        }
    }
    return {
        sessions: compared.size,
        compared: compared.size,
        mismatchedSessions: mismatched.size,
        diffs,
        errors,
        ledgerTotals,
        expectedTotals,
    };
}
