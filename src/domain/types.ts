/**
 * Core domain types for dsh-usage-center.
 *
 * Design rules:
 * - The usage record is a fact derived from the durable session log; it is
 *   never rewritten when prices change.
 * - Missing values are `null`, never `0`. "Unknown" and "zero" are different
 *   facts and must stay distinguishable at every layer.
 */

/** Token counts: `null` means the provider/harness did not report the value. */
export type TokenCount = number | null;

/** Where the recorded LLM call came from. */
export type RequestKind = 'chat' | 'compaction' | 'attempt' | 'other';

/**
 * One settled LLM request, normalized from one durable session event.
 * Identity: `requestId = sessionId:seq` — stable, idempotent, replay-safe.
 */
export interface UsageRecord {
  requestId: string;
  sessionId: string;
  /** Event sequence number inside the session log (watermark key). */
  seq: number;
  turn: number | null;
  step: number | null;

  /** Subagent/fork lineage from the session header, when present. */
  parentSessionId: string | null;
  origin: string | null;
  /** 1 when the event lies inside the fork-inherited seed prefix. */
  isSeed: 0 | 1;

  /** Session working directory. */
  cwd: string | null;

  provider: string | null;
  model: string | null;
  kind: RequestKind;

  /** Event `time` (ms epoch). */
  timestamp: number;

  inputTokens: TokenCount;
  outputTokens: TokenCount;
  cacheReadTokens: TokenCount;
  cacheWriteTokens: TokenCount;
  reasoningTokens: TokenCount;
  totalTokens: TokenCount;

  /** step/start → event time. */
  durationMs: number | null;
  /** First output-token time (official isTokenDelta semantics) − step/start. */
  firstTokenLatencyMs: number | null;

  finishReason: string | null;
  errorCode: string | null;
  errorStatus: number | null;
  errorMessage: string | null;

  /** Verbatim `usage` object as JSON, for future re-parsing. */
  rawUsage: string | null;
  /** Durable event type this record was derived from. */
  sourceEvent: string;
}

/** Per-session import/lineage bookkeeping (the `sessions` table row). */
export interface SessionRow {
  sessionId: string;
  createdAt: number | null;
  cwd: string | null;
  parentSessionId: string | null;
  origin: string | null;
  seedLength: number | null;
  /** Highest event seq ingested for this session. */
  lastSeq: number | null;
  /** Human title from `session/title` events, when observed. */
  title: string | null;
  updatedAt: number;
}

/** Result classification of one idempotent upsert. */
export type UpsertOutcome = 'inserted' | 'updated' | 'unchanged';

export interface UpsertStats {
  inserted: number;
  updated: number;
  unchanged: number;
}

export interface UsageTotals {
  requests: number;
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
  reasoningTokens: number;
  totalTokens: number;
  /** cacheRead / (input + cacheRead + cacheWrite); null when denominator unknown. */
  cacheHitRate: number | null;
  durationMsTotal: number;
  durationMsCount: number;
  firstTokenMsTotal: number;
  firstTokenMsCount: number;
}

// ---------------------------------------------------------------------------
// Statistics shapes (materialized daily cache + dashboard views).

/**
 * One row of the `daily_stats` cache: a local-time day × provider × model
 * bucket. The table is a derived cache, fully rebuildable from
 * `usage_records` (the session log stays the only source of truth).
 * `provider`/`model` use `''` (not NULL) for "unknown" so they can form the
 * primary key.
 */
export interface DailyStatRow {
  /** Local-time calendar day, `YYYY-MM-DD`. */
  day: string;
  provider: string;
  model: string;
  requests: number;
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
  reasoningTokens: number;
  totalTokens: number;
  durationMsTotal: number;
  durationCount: number;
  firstTokenMsTotal: number;
  firstTokenCount: number;
  errorCount: number;
}

/** One day aggregated over all models, zero-filled across the range. */
export interface TrendPoint {
  day: string;
  requests: number;
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
  reasoningTokens: number;
  totalTokens: number;
  cacheHitRate: number | null;
  avgFirstTokenMs: number | null;
  avgDurationMs: number | null;
  errorCount: number;
}

/** Grouping dimension of `breakdown`. */
export type BreakdownDim = 'model' | 'provider' | 'kind';

/** One grouped row of the requests breakdown. */
export interface BreakdownRow {
  /** Stable display key of the group (provider, `provider/model`, or kind). */
  key: string;
  provider: string | null;
  model: string | null;
  kind: string | null;
  requests: number;
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
  reasoningTokens: number;
  totalTokens: number;
  cacheHitRate: number | null;
  avgFirstTokenMs: number | null;
  errorCount: number;
  lastTimestamp: number | null;
}

/** Per-session usage summary (ledger view). */
export interface SessionSummaryRow {
  sessionId: string;
  title: string | null;
  createdAt: number | null;
  cwd: string | null;
  origin: string | null;
  parentSessionId: string | null;
  requests: number;
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
  totalTokens: number;
  errorCount: number;
  firstTimestamp: number | null;
  lastTimestamp: number | null;
}

// ---------------------------------------------------------------------------
// Estimated costs (prices are user configuration; results are estimates, in
// integer micro currency units — never presented as billing).

/** Estimated cost totals for one currency. */
export interface CostByCurrency {
  currency: string;
  requests: number;
  /** Sum in micro units (1e-6 currency). */
  totalMicro: number;
  /** Requests with at least one unpriced token category. */
  missingCount: number;
}

/** Estimated cost for one provider/model (one currency). */
export interface CostByModelRow {
  provider: string | null;
  model: string | null;
  key: string;
  currency: string;
  requests: number;
  totalTokens: number;
  totalMicro: number;
  missingCount: number;
  /** Prices of the newest effective list for this model, when configured. */
  price: { input?: number; output?: number; cacheRead?: number; cacheWrite?: number } | null;
}

/** Estimated cost for one local day (one currency). */
export interface CostByDayRow {
  day: string;
  currency: string;
  totalMicro: number;
}

/** One `request/context` sample (the request's window declaration). */
export interface ContextSampleInput {
  sessionId: string;
  seq: number;
  timestamp: number;
  provider: string | null;
  model: string | null;
  contextWindow: number | null;
}
