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

import type { UsageDatabase } from '../storage/database.js';

/** Minimal sessionQuery face (contract as verified in the live harness). */
export interface ReconcileSessionQuery {
  listSessions(signal?: AbortSignal): Promise<readonly { header?: { id?: string } }[]>;
  readSession(sessionId: string): Promise<{
    session?: { id?: string };
    events?: ReadonlyArray<{ type: string; seq: number; data?: unknown }>;
  }>;
}

interface UsageSums {
  requests: number;
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
  totalTokens: number;
}

export interface ReconcileDiff {
  sessionId: string;
  field: keyof UsageSums;
  ledger: number;
  expected: number;
}

export interface ReconcileReport {
  sessions: number;
  compared: number;
  mismatchedSessions: number;
  diffs: ReconcileDiff[];
  errors: Array<{ sessionId: string; error: string }>;
  ledgerTotals: UsageSums;
  expectedTotals: UsageSums;
}

const EMPTY: UsageSums = {
  requests: 0, inputTokens: 0, outputTokens: 0,
  cacheReadTokens: 0, cacheWriteTokens: 0, totalTokens: 0,
};

function addUsage(sums: UsageSums, usage: unknown): void {
  if (typeof usage !== 'object' || usage === null) return;
  const u = usage as Record<string, unknown>;
  const num = (v: unknown): number => (typeof v === 'number' && Number.isFinite(v) ? v : 0);
  sums.requests += 1;
  sums.inputTokens += num(u.inputTokens);
  sums.outputTokens += num(u.outputTokens);
  sums.cacheReadTokens += num(u.cacheReadTokens);
  sums.cacheWriteTokens += num(u.cacheWriteTokens);
  sums.totalTokens += num(u.totalTokens);
}

/** Terminal usage chunk of an embedded attempt stream, or null. */
function attemptUsage(stream: unknown): unknown {
  if (!Array.isArray(stream)) return null;
  for (let i = stream.length - 1; i >= 0; i -= 1) {
    const record = stream[i];
    if (typeof record !== 'object' || record === null) continue;
    const chunk = (record as Record<string, unknown>).chunk;
    if (typeof chunk === 'object' && chunk !== null &&
        (chunk as Record<string, unknown>).type === 'usage') {
      return (chunk as Record<string, unknown>).usage;
    }
  }
  return null;
}

function expectedSums(events: ReadonlyArray<{ type: string; data?: unknown }>): UsageSums {
  const sums = { ...EMPTY };
  for (const event of events) {
    if (typeof event !== 'object' || event === null) continue;
    const data = (event as { data?: unknown }).data;
    if (typeof data !== 'object' || data === null) continue;
    const d = data as Record<string, unknown>;
    if (event.type === 'assistant/message' || event.type === 'compaction/summary') {
      addUsage(sums, d.usage);
    } else if (event.type === 'assistant/attempt') {
      const usage = attemptUsage(d.stream);
      if (usage !== null) addUsage(sums, usage);
    }
  }
  return sums;
}

/**
 * Full reconciliation pass. Reads every session through `sessionQuery`
 * (bounded by the same worker pattern as the importer, sequentially here —
 * this is a diagnostic path, not a hot one) and diffs against the ledger.
 */
export async function reconcileAgainstLogs(
  sessionQuery: ReconcileSessionQuery,
  store: UsageDatabase,
): Promise<ReconcileReport> {
  const ledger = store.usageBySession();
  const diffs: ReconcileDiff[] = [];
  const errors: Array<{ sessionId: string; error: string }> = [];
  const mismatched = new Set<string>();
  const ledgerTotals = { ...EMPTY };
  const expectedTotals = { ...EMPTY };
  const compared = new Set<string>();

  const sessions = await sessionQuery.listSessions();
  for (const entry of sessions) {
    const sessionId = entry.header?.id;
    if (typeof sessionId !== 'string' || sessionId.length === 0 || compared.has(sessionId)) continue;
    compared.add(sessionId);
    try {
      const snapshot = await sessionQuery.readSession(sessionId);
      const expected = expectedSums(snapshot.events ?? []);
      for (const key of Object.keys(expected) as Array<keyof UsageSums>) {
        expectedTotals[key] += expected[key];
      }
      const row = ledger.get(sessionId);
      const ledgerSums: UsageSums = row ?? { ...EMPTY };
      if (row !== undefined) {
        for (const key of Object.keys(ledgerSums) as Array<keyof UsageSums>) {
          ledgerTotals[key] += ledgerSums[key];
        }
      }
      for (const key of Object.keys(expected) as Array<keyof UsageSums>) {
        if (ledgerSums[key] !== expected[key]) {
          diffs.push({ sessionId, field: key, ledger: ledgerSums[key], expected: expected[key] });
          mismatched.add(sessionId);
        }
      }
    } catch (error) {
      errors.push({ sessionId, error: String((error as Error)?.message ?? error) });
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
