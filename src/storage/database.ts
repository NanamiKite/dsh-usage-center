/**
 * UsageDatabase: the plugin-owned SQLite ledger.
 *
 * Driver: Node's built-in `node:sqlite` (DatabaseSync) -- the same choice the
 * official `dsh-session-query-sqlite` backend and the community prior art
 * (y2zyyr/dsh-token-usage-sidebar) independently made. Zero npm runtime
 * dependencies, no native build step.
 *
 * Safety model:
 * - `PRAGMA application_id` guards against opening an unrelated database.
 * - `PRAGMA user_version` drives stepwise migrations; a newer schema version
 *   than this code refuses to open instead of guessing.
 * - WAL + busy_timeout so dashboard reads never block the collector.
 * - Writes are idempotent upserts keyed by `request_id`.
 */

import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { DatabaseSync, type SQLInputValue } from 'node:sqlite';
import type {
  BreakdownDim,
  BreakdownRow,
  CostByCurrency,
  CostByModelRow,
  CostByDayRow,
  DailyStatRow,
  SessionRow,
  SessionSummaryRow,
  TrendPoint,
  UpsertOutcome,
  UsageRecord,
  UsageTotals,
} from '../domain/types.js';
import {
  MISSING_CACHE_READ,
  MISSING_CACHE_WRITE,
  MISSING_INPUT,
  MISSING_OUTPUT,
  MISSING_RETRO,
  categoryMicro,
  normalizePriceList,
  resolvePrice,
  windowMultiplier,
  type ModelPriceConfig,
  type RateWindows,
} from '../domain/pricing.js';

/** 'dshu' -- dsh-usage-center's SQLite application id. */
export const APPLICATION_ID = 0x6473_6875;
export const SCHEMA_VERSION = 7;

const CREATE_V1 = `
CREATE TABLE IF NOT EXISTS usage_records (
  request_id     TEXT PRIMARY KEY,
  session_id     TEXT NOT NULL,
  seq            INTEGER NOT NULL,
  turn           INTEGER,
  step           INTEGER,
  parent_session_id TEXT,
  origin         TEXT,
  is_seed        INTEGER NOT NULL DEFAULT 0,
  cwd            TEXT,
  provider       TEXT,
  model          TEXT,
  kind           TEXT NOT NULL,
  timestamp      INTEGER NOT NULL,
  input_tokens   INTEGER,
  output_tokens  INTEGER,
  cache_read_tokens  INTEGER,
  cache_write_tokens INTEGER,
  reasoning_tokens   INTEGER,
  total_tokens   INTEGER,
  duration_ms    INTEGER,
  first_token_latency_ms INTEGER,
  finish_reason  TEXT,
  error_code     TEXT,
  error_status   INTEGER,
  error_message  TEXT,
  raw_usage      TEXT,
  source_event   TEXT NOT NULL,
  imported_at    INTEGER NOT NULL,
  updated_at     INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_records_ts ON usage_records (timestamp);
CREATE INDEX IF NOT EXISTS idx_records_session ON usage_records (session_id, seq);
CREATE INDEX IF NOT EXISTS idx_records_model ON usage_records (provider, model);
CREATE INDEX IF NOT EXISTS idx_records_kind ON usage_records (kind);

CREATE TABLE IF NOT EXISTS sessions (
  session_id        TEXT PRIMARY KEY,
  created_at        INTEGER,
  cwd               TEXT,
  parent_session_id TEXT,
  origin            TEXT,
  seed_length       INTEGER,
  last_seq          INTEGER,
  title             TEXT,
  updated_at        INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS meta (
  key   TEXT PRIMARY KEY,
  value TEXT NOT NULL
);
`;

/**
 * v2: the materialized daily cache. Pure derived data —
 * `provider`/`model` use '' for "unknown" so both can join the primary key.
 */
const CREATE_V2 = `
CREATE TABLE IF NOT EXISTS daily_stats (
  day            TEXT NOT NULL,
  provider       TEXT NOT NULL DEFAULT '',
  model          TEXT NOT NULL DEFAULT '',
  requests       INTEGER NOT NULL,
  input_tokens   INTEGER NOT NULL,
  output_tokens  INTEGER NOT NULL,
  cache_read_tokens  INTEGER NOT NULL,
  cache_write_tokens INTEGER NOT NULL,
  reasoning_tokens   INTEGER NOT NULL,
  total_tokens       INTEGER NOT NULL,
  duration_ms        INTEGER NOT NULL,
  duration_count     INTEGER NOT NULL,
  first_token_ms     INTEGER NOT NULL,
  first_token_count  INTEGER NOT NULL,
  error_count        INTEGER NOT NULL,
  PRIMARY KEY (day, provider, model)
) WITHOUT ROWID;
CREATE INDEX IF NOT EXISTS idx_daily_stats_day ON daily_stats (day);
`;

/**
 * v3: estimated-cost engine. `price_lists` are versioned snapshots synced
 * from plugin config (append-only, deduplicated by content hash); the
 * applicable list for a timestamp is the newest one already in effect.
 * `cost_entries` are a derived cache like `daily_stats`: per-request
 * estimated costs in integer micro currency units (1e-6), fully rebuildable
 * from `usage_records` + `price_lists`.
 */
const CREATE_V3 = `
CREATE TABLE IF NOT EXISTS price_lists (
  id             INTEGER PRIMARY KEY,
  name           TEXT NOT NULL,
  currency       TEXT NOT NULL,
  effective_from INTEGER NOT NULL,
  source_hash    TEXT NOT NULL UNIQUE,
  created_at     INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS prices (
  price_list_id     INTEGER NOT NULL REFERENCES price_lists(id) ON DELETE CASCADE,
  provider          TEXT NOT NULL DEFAULT '',
  model             TEXT NOT NULL,
  input_per_m       REAL,
  output_per_m      REAL,
  cache_read_per_m  REAL,
  cache_write_per_m REAL,
  PRIMARY KEY (price_list_id, provider, model)
) WITHOUT ROWID;
CREATE TABLE IF NOT EXISTS cost_entries (
  request_id        TEXT PRIMARY KEY,
  price_list_id     INTEGER NOT NULL REFERENCES price_lists(id),
  currency          TEXT NOT NULL,
  input_micro       INTEGER NOT NULL,
  output_micro      INTEGER NOT NULL,
  cache_read_micro  INTEGER NOT NULL,
  cache_write_micro INTEGER NOT NULL,
  total_micro       INTEGER NOT NULL,
  missing_mask      INTEGER NOT NULL,
  computed_at       INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_cost_list ON cost_entries (price_list_id);
`;

/**
 * v4: context monitor. One row per `request/context` event (a request's
 * window declaration); `context_tokens` is derived later from the first
 * following usage record (input + cacheRead + cacheWrite ≈ the context the
 * model was fed), attributed to every still-open sample of that request.
 */
const CREATE_V4 = `
CREATE TABLE IF NOT EXISTS context_samples (
  session_id     TEXT NOT NULL,
  seq            INTEGER NOT NULL,
  timestamp      INTEGER NOT NULL,
  provider       TEXT,
  model          TEXT,
  context_window INTEGER,
  context_tokens INTEGER,
  request_id     TEXT,
  PRIMARY KEY (session_id, seq)
);
CREATE INDEX IF NOT EXISTS idx_context_session ON context_samples (session_id, timestamp);
`;

/** v5: session titles (from `session/title` events) shown instead of raw ids. */
const MIGRATE_V5 = 'ALTER TABLE sessions ADD COLUMN title TEXT;';

/**
 * v7: optional per-list daily rate windows (peak/off-peak discounts), stored
 * as validated JSON on the price list row. `price_lists`/`cost_entries` are
 * rebuildable caches, so a plain column add is the whole migration.
 */
const MIGRATE_V7 = 'ALTER TABLE price_lists ADD COLUMN windows TEXT;';

/**
 * v6: per-request context observations — a DERIVED cache (same pattern as
 * daily_stats/cost_entries), rebuilt from usage_records × the window
 * declarations in context_samples. One row per request that has any valid
 * input usage (plus every compaction record as a marker, input nullable).
 * `missing_mask` marks input-side categories that were NULL (bit 1 input,
 * bit 2 cacheRead, bit 4 cacheWrite) so partial data is never read as exact.
 * `context_window` is the declaration at/before this seq (order-based
 * association; no future declaration ever backfills earlier requests).
 */
const CREATE_V6 = `
CREATE TABLE IF NOT EXISTS context_observations (
  request_id     TEXT PRIMARY KEY,
  session_id     TEXT NOT NULL,
  seq            INTEGER NOT NULL,
  timestamp      INTEGER NOT NULL,
  provider       TEXT,
  model          TEXT,
  kind           TEXT NOT NULL,
  input_tokens   INTEGER,
  missing_mask   INTEGER NOT NULL DEFAULT 0,
  context_window INTEGER,
  computed_at    INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_context_obs_session ON context_observations (session_id, seq);
`;

const RECORD_COLUMNS = `
  request_id, session_id, seq, turn, step, parent_session_id, origin, is_seed,
  cwd, provider, model, kind, timestamp,
  input_tokens, output_tokens, cache_read_tokens, cache_write_tokens,
  reasoning_tokens, total_tokens,
  duration_ms, first_token_latency_ms,
  finish_reason, error_code, error_status, error_message,
  raw_usage, source_event
` as const;

function now(): number {
  return Date.now();
}

/**
 * Windows JSON stored on a price_lists row (`{ tz, entries }`) → validated
 * value, or undefined. Corrupt or shapeless stored JSON degrades to
 * base-rate pricing; a rebuild must never crash over a bad column.
 */
function parseStoredWindows(value: unknown): RateWindows | undefined {
  if (typeof value !== 'string' || value.length === 0) return undefined;
  try {
    const parsed = JSON.parse(value) as { tz?: unknown; entries?: unknown };
    if (typeof parsed.tz !== 'string' || parsed.tz.length === 0
      || !Array.isArray(parsed.entries)) {
      return undefined;
    }
    return parsed as unknown as RateWindows;
  } catch {
    return undefined;
  }
}

/** Compare two ledger rows on the fact columns an update may change.
 *  Includes lineage/metadata columns: a metadata-only correction (e.g. a late
 *  isSeed/cwd fix) must still count as a change, or the row can never heal. */
function factsDiffer(a: Record<string, unknown>, r: UsageRecord): boolean {
  return (
    a.turn !== r.turn ||
    a.step !== r.step ||
    a.parent_session_id !== r.parentSessionId ||
    a.origin !== r.origin ||
    a.is_seed !== (r.isSeed ? 1 : 0) ||
    a.cwd !== r.cwd ||
    a.provider !== r.provider ||
    a.model !== r.model ||
    a.kind !== r.kind ||
    a.timestamp !== r.timestamp ||
    a.input_tokens !== r.inputTokens ||
    a.output_tokens !== r.outputTokens ||
    a.cache_read_tokens !== r.cacheReadTokens ||
    a.cache_write_tokens !== r.cacheWriteTokens ||
    a.reasoning_tokens !== r.reasoningTokens ||
    a.total_tokens !== r.totalTokens ||
    a.duration_ms !== r.durationMs ||
    a.first_token_latency_ms !== r.firstTokenLatencyMs ||
    a.finish_reason !== r.finishReason ||
    a.error_code !== r.errorCode ||
    a.error_status !== r.errorStatus ||
    a.error_message !== r.errorMessage ||
    a.raw_usage !== r.rawUsage ||
    a.source_event !== r.sourceEvent
  );
}

export class UsageDatabase {
  readonly db: DatabaseSync;
  private readonly readOnly: boolean;

  constructor(path: string, options: { readOnly?: boolean } = {}) {
    this.readOnly = options.readOnly === true;
    if (this.readOnly) {
      // Read-only consumers (CLI): open as-is, no mkdir/PRAGMA writes/migrations.
      this.db = new DatabaseSync(path, { readOnly: true });
      this.db.exec('PRAGMA busy_timeout = 10000;');
      return;
    }
    if (path !== ':memory:') {
      mkdirSync(dirname(path), { recursive: true });
    }
    this.db = new DatabaseSync(path);
    this.configure();
    this.migrate(path);
  }

  private configure(): void {
    this.db.exec('PRAGMA journal_mode = WAL;');
    this.db.exec('PRAGMA synchronous = NORMAL;');
    this.db.exec('PRAGMA busy_timeout = 10000;');
    this.db.exec('PRAGMA temp_store = MEMORY;');
  }

  private migrate(path: string): void {
    const app = this.db.prepare('PRAGMA application_id').get() as
      | { application_id: number }
      | undefined;
    const appId = app?.application_id ?? 0;
    if (appId !== 0 && appId !== APPLICATION_ID) {
      throw new Error(
        `dsh-usage-center: database at "${path}" belongs to another application ` +
          `(application_id=${appId}); refusing to touch it`,
      );
    }
    const ver = this.db.prepare('PRAGMA user_version').get() as
      | { user_version: number }
      | undefined;
    let version = ver?.user_version ?? 0;
    if (version > SCHEMA_VERSION) {
      throw new Error(
        `dsh-usage-center: database at "${path}" uses schema v${version}, ` +
          `newer than this code (v${SCHEMA_VERSION}); upgrade the plugin first`,
      );
    }
    if (version < 1) {
      this.db.exec(CREATE_V1);
      version = 1;
    }
    if (version < 2) {
      this.db.exec(CREATE_V2);
      version = 2;
    }
    if (version < 3) {
      this.db.exec(CREATE_V3);
      version = 3;
    }
    if (version < 4) {
      this.db.exec(CREATE_V4);
      version = 4;
    }
    if (version < 5) {
      try {
        this.db.exec(MIGRATE_V5);
      } catch {
        // column already present (fresh DBs re-running V1 with the column)
      }
      version = 5;
    }
    if (version < 6) {
      this.db.exec(CREATE_V6);
      version = 6;
    }
    if (version < 7) {
      try {
        this.db.exec(MIGRATE_V7);
      } catch {
        // column already present (fresh DBs re-running V3 with the column)
      }
      version = 7;
    }
    this.db.exec(`PRAGMA application_id = ${APPLICATION_ID};`);
    this.db.exec(`PRAGMA user_version = ${SCHEMA_VERSION};`);
    this.setMeta('schema_version', String(SCHEMA_VERSION));
  }

  setMeta(key: string, value: string): void {    this.db
      .prepare(
        'INSERT INTO meta (key, value) VALUES (?, ?) ' +
          'ON CONFLICT(key) DO UPDATE SET value = excluded.value',
      )
      .run(key, value);
  }

  getMeta(key: string): string | null {
    const row = this.db
      .prepare('SELECT value FROM meta WHERE key = ?')
      .get(key) as { value: string } | undefined;
    return row?.value ?? null;
  }

  /**
   * Idempotent write of one usage record. The ledger key (`request_id`) makes
   * replays safe; a conflicting re-delivery updates the fact columns (the
   * session log is the source of truth, last write wins).
   */
  upsertRecord(record: UsageRecord): UpsertOutcome {
    const existing = this.db
      .prepare('SELECT * FROM usage_records WHERE request_id = ?')
      .get(record.requestId) as Record<string, unknown> | undefined;
    if (existing !== undefined && !factsDiffer(existing, record)) {
      return 'unchanged';
    }
    const ts = now();
    if (existing === undefined) {
      this.pendingStatsWrites = true;
      this.pendingCostWrites = true;
      this.pendingObsWrites = true;
      this.db
        .prepare(
          `INSERT INTO usage_records (
             request_id, session_id, seq, turn, step, parent_session_id, origin,
             is_seed, cwd, provider, model, kind, timestamp,
             input_tokens, output_tokens, cache_read_tokens, cache_write_tokens,
             reasoning_tokens, total_tokens,
             duration_ms, first_token_latency_ms,
             finish_reason, error_code, error_status, error_message,
             raw_usage, source_event, imported_at, updated_at
           ) VALUES (
             :requestId, :sessionId, :seq, :turn, :step, :parentSessionId, :origin,
             :isSeed, :cwd, :provider, :model, :kind, :timestamp,
             :inputTokens, :outputTokens, :cacheReadTokens, :cacheWriteTokens,
             :reasoningTokens, :totalTokens,
             :durationMs, :firstTokenLatencyMs,
             :finishReason, :errorCode, :errorStatus, :errorMessage,
             :rawUsage, :sourceEvent, :importedAt, :updatedAt
           )`,
        )
        .run({
          requestId: record.requestId,
          sessionId: record.sessionId,
          seq: record.seq,
          turn: record.turn,
          step: record.step,
          parentSessionId: record.parentSessionId,
          origin: record.origin,
          isSeed: record.isSeed,
          cwd: record.cwd,
          provider: record.provider,
          model: record.model,
          kind: record.kind,
          timestamp: record.timestamp,
          inputTokens: record.inputTokens,
          outputTokens: record.outputTokens,
          cacheReadTokens: record.cacheReadTokens,
          cacheWriteTokens: record.cacheWriteTokens,
          reasoningTokens: record.reasoningTokens,
          totalTokens: record.totalTokens,
          durationMs: record.durationMs,
          firstTokenLatencyMs: record.firstTokenLatencyMs,
          finishReason: record.finishReason,
          errorCode: record.errorCode,
          errorStatus: record.errorStatus,
          errorMessage: record.errorMessage,
          rawUsage: record.rawUsage,
          sourceEvent: record.sourceEvent,
          importedAt: ts,
          updatedAt: ts,
        });
      this.purgeOrphanRetryRows(record);
      return 'inserted';
    }
    this.pendingStatsWrites = true;
    this.pendingCostWrites = true;
    this.pendingObsWrites = true;
    this.db
      .prepare(
        `UPDATE usage_records SET
           turn = ?, step = ?, parent_session_id = ?, origin = ?, is_seed = ?, cwd = ?,
           provider = ?, model = ?, kind = ?, timestamp = ?,
           input_tokens = ?, output_tokens = ?, cache_read_tokens = ?, cache_write_tokens = ?,
           reasoning_tokens = ?, total_tokens = ?,
           duration_ms = ?, first_token_latency_ms = ?,
           finish_reason = ?, error_code = ?, error_status = ?, error_message = ?,
           raw_usage = ?, source_event = ?, updated_at = ?
         WHERE request_id = ?`,
      )
      .run(
        record.turn,
        record.step,
        record.parentSessionId,
        record.origin,
        record.isSeed,
        record.cwd,
        record.provider,
        record.model,
        record.kind,
        record.timestamp,
        record.inputTokens,
        record.outputTokens,
        record.cacheReadTokens,
        record.cacheWriteTokens,
        record.reasoningTokens,
        record.totalTokens,
        record.durationMs,
        record.firstTokenLatencyMs,
        record.finishReason,
        record.errorCode,
        record.errorStatus,
        record.errorMessage,
        record.rawUsage,
        record.sourceEvent,
        ts,
        record.requestId,
      );
    this.purgeOrphanRetryRows(record);
    return 'updated';
  }

  /**
   * Startup-boundary healing: a live `llm/retry` whose attempt predates the
   * plugin boot is recorded as a standalone fallback row (source_event
   * 'llm/retry'). Once the real attempt row for the same (turn, step) lands —
   * from live settlement or history import — the fallback is a permanent
   * double count, so delete it. Fallback rows are never amendment targets
   * (amendments keep the attempt's request id), so the discriminator is safe.
   */
  private purgeOrphanRetryRows(record: UsageRecord): void {
    if (record.sourceEvent === 'llm/retry') return;
    if (typeof record.turn !== 'number' || typeof record.step !== 'number') return;
    const purged = this.db
      .prepare(
        `DELETE FROM usage_records
          WHERE session_id = ? AND turn IS ? AND step IS ?
            AND source_event = 'llm/retry' AND request_id != ?`,
      )
      .run(record.sessionId, record.turn, record.step, record.requestId);
    if (purged.changes > 0) {
      this.pendingStatsWrites = true;
      this.pendingCostWrites = true;
      this.pendingObsWrites = true;
    }
  }

  /** Idempotent session bookkeeping; advances the watermark. */
  upsertSession(row: SessionRow): void {
    this.db
      .prepare(
        `INSERT INTO sessions
           (session_id, created_at, cwd, parent_session_id, origin, seed_length, last_seq, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(session_id) DO UPDATE SET
           created_at = COALESCE(excluded.created_at, sessions.created_at),
           cwd = COALESCE(excluded.cwd, sessions.cwd),
           parent_session_id = COALESCE(excluded.parent_session_id, sessions.parent_session_id),
           origin = COALESCE(excluded.origin, sessions.origin),
           seed_length = COALESCE(excluded.seed_length, sessions.seed_length),
           last_seq = MAX(COALESCE(sessions.last_seq, 0), COALESCE(excluded.last_seq, 0)),
           updated_at = excluded.updated_at`,
      )
      .run(
        row.sessionId,
        row.createdAt,
        row.cwd,
        row.parentSessionId,
        row.origin,
        row.seedLength,
        row.lastSeq,
        row.updatedAt,
      );
  }

  /** Record a session title from a `session/title` event (non-null wins). */
  setSessionTitle(sessionId: string, title: string): void {
    this.db
      .prepare(
        `INSERT INTO sessions (session_id, title, updated_at) VALUES (?, ?, ?)
         ON CONFLICT(session_id) DO UPDATE SET
           title = COALESCE(excluded.title, sessions.title),
           updated_at = excluded.updated_at`,
      )
      .run(sessionId, title, now());
  }

  getSession(sessionId: string): SessionRow | undefined {
    const row = this.db
      .prepare('SELECT * FROM sessions WHERE session_id = ?')
      .get(sessionId) as Record<string, unknown> | undefined;
    if (row === undefined) return undefined;
    return {
      sessionId: String(row.session_id),
      createdAt: typeof row.created_at === 'number' ? row.created_at : null,
      cwd: typeof row.cwd === 'string' ? row.cwd : null,
      parentSessionId:
        typeof row.parent_session_id === 'string' ? row.parent_session_id : null,
      origin: typeof row.origin === 'string' ? row.origin : null,
      seedLength: typeof row.seed_length === 'number' ? row.seed_length : null,
      lastSeq: typeof row.last_seq === 'number' ? row.last_seq : null,
      title: typeof row.title === 'string' && row.title.length > 0 ? row.title : null,
      updatedAt: typeof row.updated_at === 'number' ? row.updatedAt as number : now(),
    };
  }

  listSessions(): Array<SessionRow & { recordCount: number }> {
    const rows = this.db
      .prepare(
        `SELECT s.*, (SELECT COUNT(*) FROM usage_records r WHERE r.session_id = s.session_id) AS record_count
         FROM sessions s ORDER BY s.created_at ASC`,
      )
      .all() as Array<Record<string, unknown>>;
    return rows.map((row) => ({
      sessionId: String(row.session_id),
      createdAt: typeof row.created_at === 'number' ? row.created_at : null,
      cwd: typeof row.cwd === 'string' ? row.cwd : null,
      parentSessionId:
        typeof row.parent_session_id === 'string' ? row.parent_session_id : null,
      origin: typeof row.origin === 'string' ? row.origin : null,
      seedLength: typeof row.seed_length === 'number' ? row.seed_length : null,
      lastSeq: typeof row.last_seq === 'number' ? row.last_seq : null,
      title: typeof row.title === 'string' && row.title.length > 0 ? row.title : null,
      updatedAt: typeof row.updated_at === 'number' ? (row.updated_at as number) : now(),
      recordCount: Number(row.record_count ?? 0),
    }));
  }

  private static recordFromRow(row: Record<string, unknown>): UsageRecord {
    const num = (v: unknown): number | null =>
      typeof v === 'number' && Number.isFinite(v) ? v : null;
    const str = (v: unknown): string | null =>
      typeof v === 'string' && v.length > 0 ? v : null;
    return {
      requestId: String(row.request_id),
      sessionId: String(row.session_id),
      seq: Number(row.seq),
      turn: num(row.turn),
      step: num(row.step),
      parentSessionId: str(row.parent_session_id),
      origin: str(row.origin),
      isSeed: row.is_seed === 1 ? 1 : 0,
      cwd: str(row.cwd),
      provider: str(row.provider),
      model: str(row.model),
      kind: String(row.kind) as UsageRecord['kind'],
      timestamp: Number(row.timestamp),
      inputTokens: num(row.input_tokens),
      outputTokens: num(row.output_tokens),
      cacheReadTokens: num(row.cache_read_tokens),
      cacheWriteTokens: num(row.cache_write_tokens),
      reasoningTokens: num(row.reasoning_tokens),
      totalTokens: num(row.total_tokens),
      durationMs: num(row.duration_ms),
      firstTokenLatencyMs: num(row.first_token_latency_ms),
      finishReason: str(row.finish_reason),
      errorCode: str(row.error_code),
      errorStatus: num(row.error_status),
      errorMessage: str(row.error_message),
      rawUsage: typeof row.raw_usage === 'string' ? row.raw_usage : null,
      sourceEvent: String(row.source_event),
    };
  }

  static WHERE(
    filters: { sessionId?: string; provider?: string; model?: string; kind?: string; from?: number; to?: number; includeSeed?: boolean },
  ): { clause: string; params: SQLInputValue[] } {
    const parts: string[] = [];
    const params: SQLInputValue[] = [];
    if (filters.sessionId !== undefined) {
      parts.push('session_id = ?');
      params.push(filters.sessionId);
    }
    if (filters.provider !== undefined) {
      parts.push('provider = ?');
      params.push(filters.provider);
    }
    if (filters.model !== undefined) {
      parts.push('model = ?');
      params.push(filters.model);
    }
    if (filters.kind !== undefined) {
      parts.push('kind = ?');
      params.push(filters.kind);
    }
    if (filters.from !== undefined) {
      parts.push('timestamp >= ?');
      params.push(filters.from);
    }
    if (filters.to !== undefined) {
      parts.push('timestamp <= ?');
      params.push(filters.to);
    }
    if (filters.includeSeed === false) {
      parts.push('is_seed = 0');
    }
    const clause = parts.length > 0 ? ` WHERE ${parts.join(' AND ')}` : '';
    return { clause, params };
  }

  listRecords(
    filters: {
      sessionId?: string;
      provider?: string;
      model?: string;
      kind?: string;
      from?: number;
      to?: number;
      includeSeed?: boolean;
      limit?: number;
      offset?: number;
      order?: 'asc' | 'desc';
    } = {},
  ): { items: UsageRecord[]; total: number } {
    const { clause, params } = UsageDatabase.WHERE(filters);
    const total = (
      this.db
        .prepare(`SELECT COUNT(*) AS c FROM usage_records${clause}`)
        .get(...params) as { c: number }
    ).c;
    const limit = Math.min(Math.max(filters.limit ?? 50, 1), 1000);
    const offset = Math.max(filters.offset ?? 0, 0);
    const order = filters.order === 'asc' ? 'ASC' : 'DESC';
    const rows = this.db
      .prepare(
        `SELECT * FROM usage_records${clause} ORDER BY timestamp ${order}, seq ${order} LIMIT ? OFFSET ?`,
      )
      .all(...params, limit, offset) as Array<Record<string, unknown>>;
    return { items: rows.map(UsageDatabase.recordFromRow), total };
  }

  totals(
    filters: {
      sessionId?: string;
      provider?: string;
      model?: string;
      kind?: string;
      from?: number;
      to?: number;
      includeSeed?: boolean;
    } = {},
  ): UsageTotals {
    const { clause, params } = UsageDatabase.WHERE(filters);
    const row = this.db
      .prepare(
        `SELECT COUNT(*) AS requests,
           SUM(input_tokens) AS input_tokens,
           SUM(output_tokens) AS output_tokens,
           SUM(cache_read_tokens) AS cache_read_tokens,
           SUM(cache_write_tokens) AS cache_write_tokens,
           SUM(reasoning_tokens) AS reasoning_tokens,
           SUM(total_tokens) AS total_tokens,
           SUM(duration_ms) AS duration_ms,
           SUM(CASE WHEN duration_ms IS NOT NULL THEN 1 ELSE 0 END) AS duration_count,
           SUM(first_token_latency_ms) AS first_token_ms,
           SUM(CASE WHEN first_token_latency_ms IS NOT NULL THEN 1 ELSE 0 END) AS first_token_count
         FROM usage_records${clause}`,
      )
      .get(...params) as Record<string, unknown>;
    const n = (v: unknown): number => (typeof v === 'number' ? v : 0);
    const input = n(row.input_tokens);
    const cacheRead = n(row.cache_read_tokens);
    const cacheWrite = n(row.cache_write_tokens);
    const denominator = input + cacheRead + cacheWrite;
    return {
      requests: n(row.requests),
      inputTokens: input,
      outputTokens: n(row.output_tokens),
      cacheReadTokens: cacheRead,
      cacheWriteTokens: cacheWrite,
      reasoningTokens: n(row.reasoning_tokens),
      totalTokens: n(row.total_tokens),
      cacheHitRate: denominator > 0 ? cacheRead / denominator : null,
      durationMsTotal: n(row.duration_ms),
      durationMsCount: n(row.duration_count),
      firstTokenMsTotal: n(row.first_token_ms),
      firstTokenMsCount: n(row.first_token_count),
    };
  }

  byModel(
    filters: {
      sessionId?: string;
      kind?: string;
      from?: number;
      to?: number;
      includeSeed?: boolean;
    } = {},
  ): Array<{ provider: string | null; model: string | null; requests: number; totalTokens: number }> {
    const { clause, params } = UsageDatabase.WHERE(filters);
    const rows = this.db
      .prepare(
        `SELECT provider, model, COUNT(*) AS requests, SUM(total_tokens) AS total_tokens
         FROM usage_records${clause}
         GROUP BY provider, model
         ORDER BY total_tokens DESC`,
      )
      .all(...params) as Array<Record<string, unknown>>;
    return rows.map((row) => ({
      provider: typeof row.provider === 'string' ? row.provider : null,
      model: typeof row.model === 'string' ? row.model : null,
      requests: Number(row.requests ?? 0),
      totalTokens: Number(row.total_tokens ?? 0),
    }));
  }

  // -------------------------------------------------------------------------
  // Materialized daily statistics.
  //
  // `daily_stats` is a derived cache, never a second source of truth: any
  // change to `usage_records` bumps `MAX(updated_at)`, which is compared
  // against the `stats_stamp` meta key. Day buckets are folded in **JS local
  // time** on purpose — SQLite's `localtime` modifier falls back to UTC on
  // Windows, and the ledger's "today" semantics (`startOfLocalDay`) must stay
  // identical everywhere.

  /** Meta key holding the `MAX(updated_at)` covered by the last rebuild. */
  private static readonly STATS_STAMP = 'stats_stamp';
  /**
   * Set by every mutating upsert, cleared by each rebuild. `updated_at` has
   * millisecond resolution, so a same-millisecond write after a rebuild would
   * be invisible to the stamp comparison alone; this flag closes that gap
   * within one process lifetime, and the stamp covers restarts.
   */
  private pendingStatsWrites = false;
  private pendingCostWrites = false;
  private lastRebuildAt = 0;
  private lastCostRebuildAt = 0;

  /** Local-time calendar day `YYYY-MM-DD` of an epoch-ms timestamp. */
  static dayOf(timestamp: number): string {
    const d = new Date(timestamp);
    const mm = String(d.getMonth() + 1).padStart(2, '0');
    const dd = String(d.getDate()).padStart(2, '0');
    return `${d.getFullYear()}-${mm}-${dd}`;
  }

  private maxUpdatedAt(): number {
    const row = this.db
      .prepare('SELECT MAX(updated_at) AS m FROM usage_records')
      .get() as { m: number | null };
    return row?.m ?? 0;
  }

  /** True when records changed after the last rebuild. */
  statsDirty(): boolean {
    if (this.pendingStatsWrites) return true;
    const stamp = this.getMeta(UsageDatabase.STATS_STAMP);
    const covered = stamp !== null ? Number(stamp) : NaN;
    if (!Number.isFinite(covered)) return this.maxUpdatedAt() > 0;
    return this.maxUpdatedAt() > covered;
  }

  /**
   * Full recompute of `daily_stats` from `usage_records` in one transaction.
   * A full fold (instead of per-write deltas) makes the cache converge after
   * every amend path — including `llm/retry` rewrites under the same key —
   * and stays drift-proof by construction.
   */
  rebuildDailyStats(): number {
    const rows = this.db
      .prepare(
        'SELECT provider, model, kind, timestamp, input_tokens, output_tokens, ' +
          'cache_read_tokens, cache_write_tokens, reasoning_tokens, total_tokens, ' +
          'duration_ms, first_token_latency_ms, error_code FROM usage_records',
      )
      .all() as Array<Record<string, unknown>>;
    const buckets = new Map<string, DailyStatRow>();
    for (const row of rows) {
      const day = UsageDatabase.dayOf(Number(row.timestamp));
      const provider = typeof row.provider === 'string' ? row.provider : '';
      const model = typeof row.model === 'string' ? row.model : '';
      const key = `${day}\u0000${provider}\u0000${model}`;
      let bucket = buckets.get(key);
      if (bucket === undefined) {
        bucket = {
          day,
          provider,
          model,
          requests: 0,
          inputTokens: 0,
          outputTokens: 0,
          cacheReadTokens: 0,
          cacheWriteTokens: 0,
          reasoningTokens: 0,
          totalTokens: 0,
          durationMsTotal: 0,
          durationCount: 0,
          firstTokenMsTotal: 0,
          firstTokenCount: 0,
          errorCount: 0,
        };
        buckets.set(key, bucket);
      }
      const num = (v: unknown): number => (typeof v === 'number' && v !== null ? v : 0);
      bucket.requests += 1;
      bucket.inputTokens += num(row.input_tokens);
      bucket.outputTokens += num(row.output_tokens);
      bucket.cacheReadTokens += num(row.cache_read_tokens);
      bucket.cacheWriteTokens += num(row.cache_write_tokens);
      bucket.reasoningTokens += num(row.reasoning_tokens);
      bucket.totalTokens += num(row.total_tokens);
      if (typeof row.duration_ms === 'number') {
        bucket.durationMsTotal += row.duration_ms;
        bucket.durationCount += 1;
      }
      if (typeof row.first_token_latency_ms === 'number') {
        bucket.firstTokenMsTotal += row.first_token_latency_ms;
        bucket.firstTokenCount += 1;
      }
      if (typeof row.error_code === 'string' && row.error_code.length > 0) bucket.errorCount += 1;
    }
    const stamp = this.maxUpdatedAt();
    const insert = this.db.prepare(
      `INSERT INTO daily_stats (
         day, provider, model, requests,
         input_tokens, output_tokens, cache_read_tokens, cache_write_tokens,
         reasoning_tokens, total_tokens,
         duration_ms, duration_count, first_token_ms, first_token_count, error_count
       ) VALUES (
         :day, :provider, :model, :requests,
         :inputTokens, :outputTokens, :cacheReadTokens, :cacheWriteTokens,
         :reasoningTokens, :totalTokens,
         :durationMsTotal, :durationCount, :firstTokenMsTotal, :firstTokenCount, :errorCount
       )`,
    );
    this.db.exec('BEGIN IMMEDIATE');
    try {
      this.db.exec('DELETE FROM daily_stats');
      for (const bucket of buckets.values()) insert.run({ ...bucket });
      this.setMeta(UsageDatabase.STATS_STAMP, String(stamp));
      this.db.exec('COMMIT');
    } catch (error) {
      this.db.exec('ROLLBACK');
      throw error;
    }
    this.lastRebuildAt = Date.now();
    this.pendingStatsWrites = false;
    return buckets.size;
  }

  /**
   * Rebuild the cache when stale, at most once per `maxAgeMs` so a dashboard
   * poll never amplifies into one GROUP BY per request.
   */
  ensureDailyStatsFresh(maxAgeMs = 2000): void {
    if (this.readOnly) return;
    if (!this.statsDirty()) return;
    if (Date.now() - this.lastRebuildAt < maxAgeMs) return;
    this.rebuildDailyStats();
  }

  /**
   * Daily trend over the last `days` local days (today included), aggregated
   * over all models and zero-filled so charts get a continuous axis.
   */
  trend(days: number): TrendPoint[] {
    this.ensureDailyStatsFresh();
    const span = Math.min(Math.max(Math.trunc(days) || 30, 1), 366);
    const today = new Date();
    today.setHours(0, 0, 0, 0);
    const start = new Date(today.getTime());
    start.setDate(start.getDate() - (span - 1));
    const startDay = UsageDatabase.dayOf(start.getTime());
    const rows = this.db
      .prepare(
        `SELECT day,
            SUM(requests) AS requests,
            SUM(input_tokens) AS input_tokens,
            SUM(output_tokens) AS output_tokens,
            SUM(cache_read_tokens) AS cache_read_tokens,
            SUM(cache_write_tokens) AS cache_write_tokens,
            SUM(reasoning_tokens) AS reasoning_tokens,
            SUM(total_tokens) AS total_tokens,
            SUM(duration_ms) AS duration_ms,
            SUM(duration_count) AS duration_count,
            SUM(first_token_ms) AS first_token_ms,
            SUM(first_token_count) AS first_token_count,
            SUM(error_count) AS error_count
          FROM daily_stats WHERE day >= ? GROUP BY day ORDER BY day`,
      )
      .all(startDay) as Array<Record<string, unknown>>;
    const byDay = new Map<string, Record<string, unknown>>();
    for (const row of rows) byDay.set(String(row.day), row);
    const points: TrendPoint[] = [];
    const cursor = new Date(start.getTime());
    for (let i = 0; i < span; i += 1) {
      // Calendar-day stepping (not +86_400_000) keeps the axis continuous
      // across DST transitions.
      const day = UsageDatabase.dayOf(cursor.getTime());
      cursor.setDate(cursor.getDate() + 1);
      const row = byDay.get(day);
      const n = (key: string): number =>
        row === undefined ? 0 : Number(row[key] ?? 0);
      const input = n('input_tokens');
      const cacheRead = n('cache_read_tokens');
      const cacheWrite = n('cache_write_tokens');
      const denominator = input + cacheRead + cacheWrite;
      const firstCount = n('first_token_count');
      const durationCount = n('duration_count');
      points.push({
        day,
        requests: n('requests'),
        inputTokens: input,
        outputTokens: n('output_tokens'),
        cacheReadTokens: cacheRead,
        cacheWriteTokens: cacheWrite,
        reasoningTokens: n('reasoning_tokens'),
        totalTokens: n('total_tokens'),
        cacheHitRate: denominator > 0 ? cacheRead / denominator : null,
        avgFirstTokenMs: firstCount > 0 ? n('first_token_ms') / firstCount : null,
        avgDurationMs: durationCount > 0 ? n('duration_ms') / durationCount : null,
        errorCount: n('error_count'),
      });
    }
    return points;
  }

  /**
   * Per-series daily trend grouped by dimension (`provider` or `model`,
   * where a model key is `provider/model`): top 6 keys by total tokens plus
   * an aggregated "其他/other" bucket, each zero-filled across the range.
   */
  trendSeries(by: 'provider' | 'model', days: number): Array<{ key: string; points: Array<{ day: string; totalTokens: number }> }> {
    this.ensureDailyStatsFresh();
    const span = Math.min(Math.max(Math.trunc(days) || 30, 1), 366);
    const today = new Date();
    today.setHours(0, 0, 0, 0);
    const start = new Date(today.getTime());
    start.setDate(start.getDate() - (span - 1));
    const startDay = UsageDatabase.dayOf(start.getTime());
    const keyExpr = by === 'provider' ? "COALESCE(provider, '?')" : "COALESCE(provider, '?') || '/' || COALESCE(model, '?')";
    const rows = this.db
      .prepare(
        `SELECT day, ${keyExpr} AS k, SUM(total_tokens) AS total_tokens
          FROM daily_stats WHERE day >= ? GROUP BY day, k`,
      )
      .all(startDay) as Array<Record<string, unknown>>;
    const totals = new Map<string, number>();
    const byDayKey = new Map<string, number>();
    for (const row of rows) {
      const key = String(row.k);
      const value = Number(row.total_tokens ?? 0);
      totals.set(key, (totals.get(key) ?? 0) + value);
      byDayKey.set(`${row.day}|${key}`, value);
    }
    const ranked = [...totals.entries()].sort((a, b) => b[1] - a[1]);
    const top = ranked.slice(0, 6).map(([key]) => key);
    const topSet = new Set(top);
    const keys = [...top];
    const otherTotal = ranked.slice(6).reduce((acc, [, value]) => acc + value, 0);
    const hasOther = otherTotal > 0 && ranked.length > 6;
    if (hasOther) keys.push('other');
    const cursor = new Date(start.getTime());
    const days_list: string[] = [];
    for (let i = 0; i < span; i += 1) {
      days_list.push(UsageDatabase.dayOf(cursor.getTime()));
      cursor.setDate(cursor.getDate() + 1);
    }
    return keys.map((key) => ({
      key,
      points: days_list.map((day) => {
        if (key === 'other') {
          let sum = 0;
          for (const [mapKey, value] of byDayKey) {
            if (mapKey.startsWith(`${day}|`) && !topSet.has(mapKey.slice(day.length + 1))) {
              sum += value;
            }
          }
          return { day, totalTokens: sum };
        }
        return { day, totalTokens: byDayKey.get(`${day}|${key}`) ?? 0 };
      }),
    }));
  }

  /** Requests grouped by model / provider / kind over a time range. */
  breakdown(
    dim: BreakdownDim,
    filters: { from?: number; to?: number; includeSeed?: boolean } = {},
  ): BreakdownRow[] {
    const { clause, params } = UsageDatabase.WHERE(filters);
    const rows = this.db
      .prepare(
        `SELECT provider, model, kind,
            COUNT(*) AS requests,
            SUM(input_tokens) AS input_tokens,
            SUM(output_tokens) AS output_tokens,
            SUM(cache_read_tokens) AS cache_read_tokens,
            SUM(cache_write_tokens) AS cache_write_tokens,
            SUM(reasoning_tokens) AS reasoning_tokens,
            SUM(total_tokens) AS total_tokens,
            SUM(first_token_latency_ms) AS first_token_ms,
            SUM(CASE WHEN first_token_latency_ms IS NOT NULL THEN 1 ELSE 0 END) AS first_token_count,
            SUM(CASE WHEN error_code IS NOT NULL AND error_code != '' THEN 1 ELSE 0 END) AS error_count,
            MAX(timestamp) AS last_ts
          FROM usage_records${clause}
          GROUP BY ${dim === 'model' ? 'provider, model' : dim}
          ORDER BY total_tokens DESC`,
      )
      .all(...params) as Array<Record<string, unknown>>;
    return rows.map((row) => {
      const provider = typeof row.provider === 'string' ? row.provider : null;
      const model = typeof row.model === 'string' ? row.model : null;
      const kind = typeof row.kind === 'string' ? row.kind : null;
      const key =
        dim === 'provider'
          ? (provider ?? '?')
          : dim === 'kind'
            ? (kind ?? '?')
            : `${provider ?? '?'}/${model ?? '?'}`;
      const input = Number(row.input_tokens ?? 0);
      const cacheRead = Number(row.cache_read_tokens ?? 0);
      const cacheWrite = Number(row.cache_write_tokens ?? 0);
      const denominator = input + cacheRead + cacheWrite;
      const firstCount = Number(row.first_token_count ?? 0);
      return {
        key,
        provider,
        model,
        kind,
        requests: Number(row.requests ?? 0),
        inputTokens: input,
        outputTokens: Number(row.output_tokens ?? 0),
        cacheReadTokens: cacheRead,
        cacheWriteTokens: cacheWrite,
        reasoningTokens: Number(row.reasoning_tokens ?? 0),
        totalTokens: Number(row.total_tokens ?? 0),
        cacheHitRate: denominator > 0 ? cacheRead / denominator : null,
        avgFirstTokenMs: firstCount > 0 ? Number(row.first_token_ms ?? 0) / firstCount : null,
        errorCount: Number(row.error_count ?? 0),
        lastTimestamp: typeof row.last_ts === 'number' ? row.last_ts : null,
      };
    });
  }

  /** Per-session usage summaries for the ledger view. */
  sessionSummaries(
    query: { limit?: number; offset?: number; unpaged?: boolean } = {},
  ): { items: SessionSummaryRow[]; total: number } {
    // Paged UI surface: keep requests cheap with a hard page ceiling. Exports
    // bypass the ceiling via `unpaged` so they never silently truncate.
    const limit = query.unpaged === true
      ? Math.max(query.limit ?? 50, 1)
      : Math.min(Math.max(query.limit ?? 50, 1), 200);
    const offset = Math.max(query.offset ?? 0, 0);
    const total = (
      this.db.prepare('SELECT COUNT(*) AS c FROM sessions').get() as { c: number }
    ).c;
    const rows = this.db
      .prepare(
        `SELECT s.session_id, s.title, s.created_at, s.cwd, s.origin, s.parent_session_id,
            COUNT(r.request_id) AS requests,
            COALESCE(SUM(r.input_tokens), 0) AS input_tokens,
            COALESCE(SUM(r.output_tokens), 0) AS output_tokens,
            COALESCE(SUM(r.cache_read_tokens), 0) AS cache_read_tokens,
            COALESCE(SUM(r.cache_write_tokens), 0) AS cache_write_tokens,
            COALESCE(SUM(r.total_tokens), 0) AS total_tokens,
            COALESCE(SUM(CASE WHEN r.error_code IS NOT NULL AND r.error_code != '' THEN 1 ELSE 0 END), 0) AS error_count,
            MIN(r.timestamp) AS first_ts,
            MAX(r.timestamp) AS last_ts
          FROM sessions s
          LEFT JOIN usage_records r ON r.session_id = s.session_id
          GROUP BY s.session_id
          ORDER BY last_ts DESC
          LIMIT ? OFFSET ?`,
      )
      .all(limit, offset) as Array<Record<string, unknown>>;
    const items = rows.map((row) => ({
      sessionId: String(row.session_id),
      title: typeof row.title === 'string' && row.title.length > 0 ? row.title : null,
      createdAt: typeof row.created_at === 'number' ? row.created_at : null,
      cwd: typeof row.cwd === 'string' ? row.cwd : null,
      origin: typeof row.origin === 'string' ? row.origin : null,
      parentSessionId: typeof row.parent_session_id === 'string' ? row.parent_session_id : null,
      requests: Number(row.requests ?? 0),
      inputTokens: Number(row.input_tokens ?? 0),
      outputTokens: Number(row.output_tokens ?? 0),
      cacheReadTokens: Number(row.cache_read_tokens ?? 0),
      cacheWriteTokens: Number(row.cache_write_tokens ?? 0),
      totalTokens: Number(row.total_tokens ?? 0),
      errorCount: Number(row.error_count ?? 0),
      firstTimestamp: typeof row.first_ts === 'number' ? row.first_ts : null,
      lastTimestamp: typeof row.last_ts === 'number' ? row.last_ts : null,
    }));
    return { items, total };
  }

  // -------------------------------------------------------------------------
  // Estimated costs (v3). `cost_entries` is a derived cache over
  // `usage_records` × `price_lists`; prices come from plugin config and are
  // synced append-only by content hash. All arithmetic uses integer micro
  // currency units so aggregations stay exact.

  private static readonly COST_STAMP = 'cost_stamp';

  private priceStamp(): string {
    const row = this.db
      .prepare('SELECT COUNT(*) AS c, COALESCE(MAX(id), 0) AS m FROM price_lists')
      .get() as { c: number; m: number };
    // The retroactive-pricing mode changes what a rebuild WOULD produce for
    // pre-history rows, so it belongs to the stamp: toggling it re-prices.
    return `${row.c}:${row.m}:${this.getMeta('cost_retro') ?? '0'}`;
  }

  /** Opt-in: price requests older than the first list at that list's rates. */
  setRetroactivePricing(enabled: boolean): void {
    if (this.readOnly) return;
    const value = enabled ? '1' : '0';
    if ((this.getMeta('cost_retro') ?? '0') === value) return;
    this.setMeta('cost_retro', value);
    // The stamp change covers cross-restart; the pending flag makes the new
    // mode take effect on the very next read in THIS process too.
    this.pendingCostWrites = true;
  }

  /**
   * Sync configured price lists into the database (append-only, idempotent
   * by content hash). Malformed entries are skipped and counted.
   */
  syncPriceLists(configs: unknown): { synced: number; skipped: number } {
    const list = Array.isArray(configs) ? configs : [];
    let synced = 0;
    let skipped = 0;
    const insert = this.db.prepare(
      `INSERT OR IGNORE INTO price_lists (name, currency, effective_from, windows, source_hash, created_at)
       VALUES (?, ?, ?, ?, ?, ?)`,
    );
    const insertPrice = this.db.prepare(
      `INSERT OR IGNORE INTO prices (price_list_id, provider, model, input_per_m, output_per_m, cache_read_per_m, cache_write_per_m)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
    );
    for (const raw of list) {
      const normalized = normalizePriceList(raw);
      if (normalized === null) {
        skipped += 1;
        continue;
      }
      const result = insert.run(
        normalized.name, normalized.currency, normalized.effectiveFrom,
        normalized.windows === undefined ? null : JSON.stringify(normalized.windows),
        normalized.hash, now(),
      );
      if (result.changes > 0) {
        const id = (
          this.db
            .prepare('SELECT id FROM price_lists WHERE source_hash = ?')
            .get(normalized.hash) as { id: number }
        ).id;
        for (const model of normalized.models) {
          insertPrice.run(
            id, model.provider ?? '', model.model,
            model.input ?? null, model.output ?? null,
            model.cacheRead ?? null, model.cacheWrite ?? null,
          );
        }
        synced += 1;
      }
    }
    return { synced, skipped };
  }

  /** Configured price lists with their model counts (read-only view). */
  listPriceLists(): Array<{
    id: number; name: string; currency: string; effectiveFrom: number; models: number;
    windows: RateWindows | null;
  }> {
    return (this.db
      .prepare(
        `SELECT l.id, l.name, l.currency, l.effective_from, l.windows,
                (SELECT COUNT(*) FROM prices p WHERE p.price_list_id = l.id) AS models
          FROM price_lists l ORDER BY l.effective_from ASC, l.id ASC`,
      )
      .all() as Array<Record<string, unknown>>).map((row) => ({
      id: Number(row.id),
      name: String(row.name),
      currency: String(row.currency),
      effectiveFrom: Number(row.effective_from),
      models: Number(row.models),
      windows: parseStoredWindows(row.windows) ?? null,
    }));
  }

  /** Whether the opt-in retroactive pricing mode is active. */
  retroactivePricing(): boolean {
    return this.getMeta('cost_retro') === '1';
  }

  costsDirty(): boolean {
    if (this.pendingCostWrites) return true;
    const stamp = this.getMeta(UsageDatabase.COST_STAMP);
    const expected = `${this.maxUpdatedAt()}|${this.priceStamp()}`;
    return stamp !== expected;
  }

  /** Full recompute of `cost_entries` in one transaction. */
  rebuildCosts(): number {
    const listsRaw = this.db
      .prepare(
        `SELECT l.id, l.currency, l.effective_from, l.windows, p.provider, p.model,
                p.input_per_m, p.output_per_m, p.cache_read_per_m, p.cache_write_per_m
          FROM price_lists l JOIN prices p ON p.price_list_id = l.id
          ORDER BY l.effective_from ASC, l.id ASC`,
      )
      .all() as Array<Record<string, unknown>>;
    const lists = new Map<
      number,
      { effectiveFrom: number; currency: string; models: ModelPriceConfig[]; windows?: RateWindows }
    >();
    for (const row of listsRaw) {
      const id = Number(row.id);
      let list = lists.get(id);
      if (list === undefined) {
        const windows = parseStoredWindows(row.windows);
        list = {
          effectiveFrom: Number(row.effective_from),
          currency: String(row.currency),
          models: [],
          ...(windows !== undefined ? { windows } : {}),
        };
        lists.set(id, list);
      }
      const entry: ModelPriceConfig = { model: String(row.model) };
      const provider = typeof row.provider === 'string' && row.provider.length > 0 ? row.provider : undefined;
      if (provider !== undefined) entry.provider = provider;
      const price = (value: unknown): number | undefined =>
        typeof value === 'number' && Number.isFinite(value) ? value : undefined;
      const inputPrice = price(row.input_per_m);
      const outputPrice = price(row.output_per_m);
      const cacheReadPrice = price(row.cache_read_per_m);
      const cacheWritePrice = price(row.cache_write_per_m);
      if (inputPrice !== undefined) entry.input = inputPrice;
      if (outputPrice !== undefined) entry.output = outputPrice;
      if (cacheReadPrice !== undefined) entry.cacheRead = cacheReadPrice;
      if (cacheWritePrice !== undefined) entry.cacheWrite = cacheWritePrice;
      list.models.push(entry);
    }
    const priceLists = [...lists.entries()].map(([id, list]) => ({ id, ...list }));
    // Ordered by effective_from ASC above, so [0] is the earliest list. The
    // opt-in retroactive mode prices pre-history rows with THAT list — the
    // temporally nearest price basis — and flags them (MISSING_RETRO) so the
    // UI can label the approximation instead of hiding it.
    const retroActive = this.getMeta('cost_retro') === '1';
    const earliestList = priceLists[0];
    const records = this.db
      .prepare(
        'SELECT request_id, provider, model, timestamp, input_tokens, output_tokens, ' +
          'cache_read_tokens, cache_write_tokens FROM usage_records',
      )
      .all() as Array<Record<string, unknown>>;
    const insert = this.db.prepare(
      `INSERT INTO cost_entries (
         request_id, price_list_id, currency,
         input_micro, output_micro, cache_read_micro, cache_write_micro,
         total_micro, missing_mask, computed_at
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    );
    const stamp = `${this.maxUpdatedAt()}|${this.priceStamp()}`;
    let rows = 0;
    this.db.exec('BEGIN IMMEDIATE');
    try {
      this.db.exec('DELETE FROM cost_entries');
      for (const record of records) {
        const provider = typeof record.provider === 'string' ? record.provider : null;
        const model = typeof record.model === 'string' ? record.model : null;
        const timestamp = Number(record.timestamp);
        let resolved = resolvePrice(priceLists, timestamp, provider, model);
        let retroList: (typeof priceLists)[number] | undefined;
        if (resolved === null && retroActive && earliestList !== undefined) {
          const candidate = resolvePrice(priceLists, earliestList.effectiveFrom, provider, model);
          if (candidate !== null) {
            resolved = candidate;
            retroList = earliestList;
          }
        }
        if (resolved === null) continue;
        const tokens = {
          input: typeof record.input_tokens === 'number' ? record.input_tokens : null,
          output: typeof record.output_tokens === 'number' ? record.output_tokens : null,
          cacheRead: typeof record.cache_read_tokens === 'number' ? record.cache_read_tokens : null,
          cacheWrite: typeof record.cache_write_tokens === 'number' ? record.cache_write_tokens : null,
        };
        const multiplier = windowMultiplier(
          (retroList ?? resolved.list).windows, timestamp,
        );
        const inputMicro = Math.round(categoryMicro(tokens.input, resolved.entry.input) * multiplier);
        const outputMicro = Math.round(categoryMicro(tokens.output, resolved.entry.output) * multiplier);
        const cacheReadMicro = Math.round(categoryMicro(tokens.cacheRead, resolved.entry.cacheRead) * multiplier);
        const cacheWriteMicro = Math.round(categoryMicro(tokens.cacheWrite, resolved.entry.cacheWrite) * multiplier);
        let missing = 0;
        if ((tokens.input ?? 0) > 0 && resolved.entry.input === undefined) missing |= MISSING_INPUT;
        if ((tokens.output ?? 0) > 0 && resolved.entry.output === undefined) missing |= MISSING_OUTPUT;
        if ((tokens.cacheRead ?? 0) > 0 && resolved.entry.cacheRead === undefined) missing |= MISSING_CACHE_READ;
        if ((tokens.cacheWrite ?? 0) > 0 && resolved.entry.cacheWrite === undefined) missing |= MISSING_CACHE_WRITE;
        if (retroList !== undefined) missing |= MISSING_RETRO;
        insert.run(
          String(record.request_id), resolved.list.id, resolved.list.currency,
          inputMicro, outputMicro, cacheReadMicro, cacheWriteMicro,
          inputMicro + outputMicro + cacheReadMicro + cacheWriteMicro,
          missing, now(),
        );
        rows += 1;
      }
      this.setMeta(UsageDatabase.COST_STAMP, stamp);
      this.db.exec('COMMIT');
    } catch (error) {
      this.db.exec('ROLLBACK');
      throw error;
    }
    this.lastCostRebuildAt = Date.now();
    this.pendingCostWrites = false;
    return rows;
  }

  ensureCostsFresh(maxAgeMs = 2000): void {
    if (this.readOnly) return;
    if (!this.costsDirty()) return;
    // Same read-after-write bypass as the observations cache: an in-process
    // write flag must beat the throttle, or a read right after a write (new
    // request, usage amendment) joins stale cost rows.
    if (!this.pendingCostWrites && Date.now() - this.lastCostRebuildAt < maxAgeMs) return;
    this.rebuildCosts();
  }

  /** Aggregated estimated costs over a time range (per currency / model / day). */
  costAggregates(filters: {
    sessionId?: string;
    provider?: string;
    model?: string;
    kind?: string;
    from?: number;
    to?: number;
    includeSeed?: boolean;
  } = {}): {
    byCurrency: CostByCurrency[];
    byModel: CostByModelRow[];
    byDay: CostByDayRow[];
    coverage: { totalRequests: number; pricedRequests: number; retroPriced: number };
  } {
    this.ensureCostsFresh();
    const { clause, params } = UsageDatabase.WHERE(filters);
    const totalRequests = (
      this.db
        .prepare(`SELECT COUNT(*) AS c FROM usage_records${clause}`)
        .get(...params) as { c: number }
    ).c;
    const currencyRows = this.db
      .prepare(
        `SELECT c.currency,
                COUNT(*) AS requests,
                SUM(c.total_micro) AS total_micro,
                SUM(CASE WHEN c.missing_mask != 0 THEN 1 ELSE 0 END) AS missing
          FROM cost_entries c JOIN usage_records r ON r.request_id = c.request_id${clause}
          GROUP BY c.currency ORDER BY total_micro DESC`,
      )
      .all(...params) as Array<Record<string, unknown>>;
    const modelRows = this.db
      .prepare(
        `SELECT r.provider, r.model, c.currency,
                COUNT(*) AS requests,
                SUM(r.total_tokens) AS tokens,
                SUM(c.total_micro) AS total_micro,
                SUM(CASE WHEN c.missing_mask != 0 THEN 1 ELSE 0 END) AS missing
          FROM cost_entries c JOIN usage_records r ON r.request_id = c.request_id${clause}
          GROUP BY r.provider, r.model, c.currency
          ORDER BY total_micro DESC`,
      )
      .all(...params) as Array<Record<string, unknown>>;
    // Day buckets are folded in JS local time (same rule as daily_stats).
    const dayRows = this.db
      .prepare(
        `SELECT r.timestamp, c.currency, c.total_micro
          FROM cost_entries c JOIN usage_records r ON r.request_id = c.request_id${clause}`,
      )
      .all(...params) as Array<Record<string, unknown>>;
    const dayMap = new Map<string, CostByDayRow>();
    for (const row of dayRows) {
      const day = UsageDatabase.dayOf(Number(row.timestamp));
      const currency = String(row.currency);
      const key = `${day}|${currency}`;
      let bucket = dayMap.get(key);
      if (bucket === undefined) {
        bucket = { day, currency, totalMicro: 0 };
        dayMap.set(key, bucket);
      }
      bucket.totalMicro += Number(row.total_micro ?? 0);
    }
    const str = (v: unknown): string | null => (typeof v === 'string' ? v : null);
    // Attach the prices of the newest effective list so the table can show
    // price × usage per model.
    const priceRows = this.db
      .prepare(
        `SELECT p.provider, p.model, p.input_per_m, p.output_per_m, p.cache_read_per_m, p.cache_write_per_m
          FROM prices p
          WHERE p.price_list_id = (SELECT id FROM price_lists ORDER BY effective_from DESC, id DESC LIMIT 1)`,
      )
      .all() as Array<Record<string, unknown>>;
    const priceMap = new Map<string, { input?: number; output?: number; cacheRead?: number; cacheWrite?: number }>();
    for (const row of priceRows) {
      const entry: { input?: number; output?: number; cacheRead?: number; cacheWrite?: number } = {};
      const num = (v: unknown) => (typeof v === 'number' && Number.isFinite(v) ? v : undefined);
      const input = num(row.input_per_m);
      const output = num(row.output_per_m);
      const cacheRead = num(row.cache_read_per_m);
      const cacheWrite = num(row.cache_write_per_m);
      if (input !== undefined) entry.input = input;
      if (output !== undefined) entry.output = output;
      if (cacheRead !== undefined) entry.cacheRead = cacheRead;
      if (cacheWrite !== undefined) entry.cacheWrite = cacheWrite;
      priceMap.set(`${str(row.provider) ?? ''}/${String(row.model)}`, entry);
    }
    return {
      byCurrency: currencyRows.map((row) => ({
        currency: String(row.currency),
        requests: Number(row.requests ?? 0),
        totalMicro: Number(row.total_micro ?? 0),
        missingCount: Number(row.missing ?? 0),
      })),
      byModel: modelRows.map((row) => ({
        provider: str(row.provider),
        model: str(row.model),
        key: `${str(row.provider) ?? '?'}/${str(row.model) ?? '?'}`,
        currency: String(row.currency),
        requests: Number(row.requests ?? 0),
        totalTokens: Number(row.tokens ?? 0),
        totalMicro: Number(row.total_micro ?? 0),
        missingCount: Number(row.missing ?? 0),
        price: priceMap.get(`${str(row.provider) ?? ''}/${str(row.model) ?? ''}`)
          ?? priceMap.get(`/${str(row.model) ?? ''}`)
          ?? null,
      })),
      byDay: [...dayMap.values()].sort((a, b) => (a.day < b.day ? -1 : a.day > b.day ? 1 : a.currency < b.currency ? -1 : 1)),
      coverage: {
        totalRequests,
        pricedRequests: currencyRows.reduce((acc, row) => acc + Number(row.requests ?? 0), 0),
        retroPriced: Number(
          (this.db
            .prepare(
              `SELECT COUNT(*) AS c FROM cost_entries c
                 JOIN usage_records r ON r.request_id = c.request_id${clause}
                 ${clause.length > 0 ? 'AND' : 'WHERE'} (c.missing_mask & ${MISSING_RETRO}) != 0`,
            )
            .get(...params) as { c: number }).c,
        ),
      },
    };
  }

  /** Per-request rows joined with the ledger facts (export / audit). */
  costRows(filters: { from?: number; to?: number } = {}, limit = 100_000): Array<Record<string, unknown>> {
    this.ensureCostsFresh();
    const { clause, params } = UsageDatabase.WHERE(filters);
    return this.db
      .prepare(
        `SELECT r.request_id, r.session_id, r.timestamp, r.provider, r.model, r.kind,
                r.input_tokens, r.output_tokens, r.cache_read_tokens, r.cache_write_tokens,
                r.total_tokens, c.currency, c.input_micro, c.output_micro,
                c.cache_read_micro, c.cache_write_micro, c.total_micro, c.missing_mask
          FROM cost_entries c JOIN usage_records r ON r.request_id = c.request_id${clause}
          ORDER BY r.timestamp DESC LIMIT ?`,
      )
      .all(...params, Math.min(Math.max(limit, 1), 100_000)) as Array<Record<string, unknown>>;
  }

  /** Per-session usage sums for reconciliation (no pagination cap). */
  usageBySession(): Map<string, {
    requests: number; inputTokens: number; outputTokens: number;
    cacheReadTokens: number; cacheWriteTokens: number; totalTokens: number;
  }> {
    const rows = this.db
      .prepare(
        `SELECT session_id, COUNT(*) AS requests,
                COALESCE(SUM(input_tokens), 0) AS input_tokens,
                COALESCE(SUM(output_tokens), 0) AS output_tokens,
                COALESCE(SUM(cache_read_tokens), 0) AS cache_read_tokens,
                COALESCE(SUM(cache_write_tokens), 0) AS cache_write_tokens,
                COALESCE(SUM(total_tokens), 0) AS total_tokens
          FROM usage_records GROUP BY session_id`,
      )
      .all() as Array<Record<string, unknown>>;
    const map = new Map<string, {
      requests: number; inputTokens: number; outputTokens: number;
      cacheReadTokens: number; cacheWriteTokens: number; totalTokens: number;
    }>();
    for (const row of rows) {
      map.set(String(row.session_id), {
        requests: Number(row.requests ?? 0),
        inputTokens: Number(row.input_tokens ?? 0),
        outputTokens: Number(row.output_tokens ?? 0),
        cacheReadTokens: Number(row.cache_read_tokens ?? 0),
        cacheWriteTokens: Number(row.cache_write_tokens ?? 0),
        totalTokens: Number(row.total_tokens ?? 0),
      });
    }
    return map;
  }

  /** Export-sized record listing (single bounded scan, ascending). */
  exportRecords(filters: {
    sessionId?: string; provider?: string; model?: string; kind?: string;
    from?: number; to?: number; includeSeed?: boolean;
  } = {}): UsageRecord[] {
    const { clause, params } = UsageDatabase.WHERE(filters);
    const rows = this.db
      .prepare(`SELECT * FROM usage_records${clause} ORDER BY timestamp ASC, seq ASC LIMIT 100000`)
      .all(...params) as Array<Record<string, unknown>>;
    return rows.map(UsageDatabase.recordFromRow);
  }

  /** Export-sized session summaries. */
  exportSessions(): SessionSummaryRow[] {
    return this.sessionSummaries({ limit: 100_000, offset: 0, unpaged: true }).items;
  }

  // -------------------------------------------------------------------------
  // Context monitor (v4).

  /** Idempotent write of one `request/context` sample. */
  upsertContextSample(sample: {
    sessionId: string; seq: number; timestamp: number;
    provider: string | null; model: string | null; contextWindow: number | null;
  }): void {
    this.db
      .prepare(
        `INSERT INTO context_samples (session_id, seq, timestamp, provider, model, context_window)
         VALUES (?, ?, ?, ?, ?, ?)
         ON CONFLICT(session_id, seq) DO UPDATE SET
           timestamp = excluded.timestamp,
           provider = COALESCE(excluded.provider, context_samples.provider),
           model = COALESCE(excluded.model, context_samples.model),
           context_window = COALESCE(excluded.context_window, context_samples.context_window)`,
      )
      .run(sample.sessionId, sample.seq, sample.timestamp, sample.provider, sample.model, sample.contextWindow);
    // A new/corrected window declaration changes the order-based window
    // association of observations at/below its seq — mark the cache dirty.
    this.pendingObsWrites = true;
    this.setMeta(UsageDatabase.OBS_DECL_REV, String(this.declRevision() + 1));
  }

  /** Distinct (provider, model) pairs with request/token totals, busiest first. */
  providerModelPairs(): Array<{
    provider: string | null; model: string | null;
    requests: number; tokens: number | null;
  }> {
    interface Row {
      provider: string | null; model: string | null;
      requests: number; tokens: number | null;
    }
    const rows = this.db
      .prepare(
        `SELECT provider, model, COUNT(*) AS requests,
                SUM(input_tokens + output_tokens + cache_read_tokens + cache_write_tokens) AS tokens
           FROM usage_records
          GROUP BY provider, model
          ORDER BY tokens IS NULL, tokens DESC, requests DESC`,
      )
      .all() as unknown as Row[];
    return rows.map((row) => ({
      provider: typeof row.provider === 'string' ? row.provider : null,
      model: typeof row.model === 'string' ? row.model : null,
      requests: Number(row.requests ?? 0),
      tokens: row.tokens === null || row.tokens === undefined ? null : Number(row.tokens),
    }));
  }

  // ---- Context observations (derived, schema v6) ----
  // `context_observations` is rebuilt from usage_records × the window
  // declarations in context_samples. Sampling rule: one row per request with
  // any valid input usage (input/cacheRead/cacheWrite), plus every compaction
  // record as a marker even without usage. Windows associate by event order —
  // the latest declaration at/before the record's seq — and never backfill.

  private static readonly OBS_STAMP = 'observations_stamp';
  private static readonly OBS_DECL_REV = 'context_decl_rev';
  private pendingObsWrites = false;
  private lastObsRebuildAt = 0;

  private declRevision(): number {
    return Number(this.getMeta(UsageDatabase.OBS_DECL_REV) ?? '0');
  }

  observationsDirty(): boolean {
    if (this.pendingObsWrites) return true;
    const stamp = this.getMeta(UsageDatabase.OBS_STAMP);
    const covered = stamp !== null ? Number(stamp) : NaN;
    const current = this.maxUpdatedAt();
    if (!Number.isFinite(covered)) {
      if (current > 0) return true;
    } else if (current > covered) {
      return true;
    }
    return this.declRevision() > Number(this.getMeta('observations_decl_covered') ?? '0');
  }

  /**
   * Pure derivation of observation rows (no writes) — shared by the rebuild
   * and read-only consumers like the CLI.
   */
  deriveObservationRows(): Array<{
    requestId: string; sessionId: string; seq: number; timestamp: number;
    provider: string | null; model: string | null; kind: string;
    inputTokens: number | null; missingMask: number; contextWindow: number | null;
  }> {
    interface RecordRow {
      request_id: string; session_id: string; seq: number; timestamp: number;
      provider: string | null; model: string | null; kind: string;
      input_tokens: number | null; cache_read_tokens: number | null; cache_write_tokens: number | null;
    }
    interface DeclRow { session_id: string; seq: number; context_window: number }
    const records = this.db
      .prepare(
        `SELECT request_id, session_id, seq, timestamp, provider, model, kind,
                input_tokens, cache_read_tokens, cache_write_tokens
           FROM usage_records ORDER BY session_id, seq`,
      )
      .all() as unknown as RecordRow[];
    const decls = this.db
      .prepare(
        // ALL declarations, including ones without a window value: a later
        // null-window declaration must END the carry-over from an earlier
        // one (model switched, window unknown), not be invisible to it.
        `SELECT session_id, seq, context_window FROM context_samples
          ORDER BY session_id, seq`,
      )
      .all() as unknown as DeclRow[];
    const declsBySession = new Map<string, DeclRow[]>();
    for (const decl of decls) {
      const list = declsBySession.get(decl.session_id) ?? [];
      list.push(decl);
      declsBySession.set(decl.session_id, list);
    }
    const out: Array<{
      requestId: string; sessionId: string; seq: number; timestamp: number;
      provider: string | null; model: string | null; kind: string;
      inputTokens: number | null; missingMask: number; contextWindow: number | null;
    }> = [];
    let currentSession = '';
    let windowList: DeclRow[] = [];
    let windowIdx = 0;
    let carried: DeclRow | undefined;
    for (const record of records) {
      if (record.session_id !== currentSession) {
        currentSession = record.session_id;
        windowList = declsBySession.get(currentSession) ?? [];
        windowIdx = 0;
        carried = undefined;
      }
      for (;;) {
        const next = windowList[windowIdx];
        if (next === undefined || next.seq > record.seq) break;
        carried = next;
        windowIdx += 1;
      }
      const contextWindow = carried === undefined ? null : carried.context_window;
      const input = record.input_tokens;
      const cacheRead = record.cache_read_tokens;
      const cacheWrite = record.cache_write_tokens;
      const hasUsage = input !== null || cacheRead !== null || cacheWrite !== null;
      if (record.kind !== 'compaction' && !hasUsage) continue;
      let inputTokens: number | null = null;
      let missingMask = 0;
      if (hasUsage) {
        inputTokens = (input ?? 0) + (cacheRead ?? 0) + (cacheWrite ?? 0);
        if (input === null) missingMask |= 1;
        if (cacheRead === null) missingMask |= 2;
        if (cacheWrite === null) missingMask |= 4;
      }
      out.push({
        requestId: record.request_id,
        sessionId: record.session_id,
        seq: Number(record.seq),
        timestamp: Number(record.timestamp),
        provider: record.provider,
        model: record.model,
        kind: record.kind,
        inputTokens,
        missingMask,
        contextWindow,
      });
    }
    return out;
  }

  /** Full recompute of `context_observations` in one transaction. */
  rebuildContextObservations(): number {
    const rows = this.deriveObservationRows();
    const stamp = this.maxUpdatedAt();
    const declRev = this.declRevision();
    const insert = this.db.prepare(
      `INSERT INTO context_observations (
         request_id, session_id, seq, timestamp, provider, model, kind,
         input_tokens, missing_mask, context_window, computed_at
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    );
    const ts = Date.now();
    this.db.exec('BEGIN IMMEDIATE');
    try {
      this.db.exec('DELETE FROM context_observations');
      for (const row of rows) {
        insert.run(
          row.requestId, row.sessionId, row.seq, row.timestamp, row.provider,
          row.model, row.kind, row.inputTokens, row.missingMask, row.contextWindow, ts,
        );
      }
      this.setMeta(UsageDatabase.OBS_STAMP, String(stamp));
      this.setMeta('observations_decl_covered', String(declRev));
      this.db.exec('COMMIT');
    } catch (error) {
      this.db.exec('ROLLBACK');
      throw error;
    }
    this.lastObsRebuildAt = Date.now();
    this.pendingObsWrites = false;
    return rows.length;
  }

  /** Rebuild when stale; throttled like the other derived caches — except
   *  that the in-process dirty flag bypasses the throttle so a read right
   *  after a write (tests, amend-then-query) sees converged data. */
  ensureObservationsFresh(maxAgeMs = 2000): void {
    if (this.readOnly) return;
    if (!this.observationsDirty()) return;
    if (!this.pendingObsWrites && Date.now() - this.lastObsRebuildAt < maxAgeMs) return;
    this.rebuildContextObservations();
  }

  /** Per-session aggregates for the context overview. */
  contextOverview(): Array<{
    sessionId: string; title: string | null; cwd: string | null;
    origin: string | null; parentSessionId: string | null;
    model: string | null;
    lastInput: number | null; lastInputAt: number | null; lastRequestId: string | null;
    prevInput: number | null; delta: number | null; modelSwitched: boolean;
    maxInput: number | null; observedRequests: number; totalRequests: number;
    compactions: number; contextWindow: number | null; lastObsAt: number | null;
  }> {
    this.ensureObservationsFresh();
    interface ObsRow {
      session_id: string; request_id: string; seq: number; timestamp: number;
      provider: string | null; model: string | null; kind: string;
      input_tokens: number | null; context_window: number | null;
    }
    const obsRows = this.db
      .prepare(
        `SELECT session_id, request_id, seq, timestamp, provider, model, kind,
                input_tokens, context_window
           FROM context_observations ORDER BY session_id, seq`,
      )
      .all() as unknown as ObsRow[];
    const metaRows = this.db
      .prepare('SELECT session_id, title, cwd, origin, parent_session_id FROM sessions')
      .all() as unknown as Array<{
        session_id: string; title: string | null; cwd: string | null;
        origin: string | null; parent_session_id: string | null;
      }>;
    const countRows = this.db
      .prepare(
        `SELECT session_id, COUNT(*) AS total,
                SUM(CASE WHEN kind = 'compaction' THEN 1 ELSE 0 END) AS compactions
           FROM usage_records GROUP BY session_id`,
      )
      .all() as unknown as Array<{ session_id: string; total: number; compactions: number }>;
    const counts = new Map(countRows.map((r) => [r.session_id, r]));

    const sessions = new Map<string, {
      last: ObsRow | null; prev: ObsRow | null; max: number | null; chatCount: number;
      window: number | null; lastObsAt: number | null; model: string | null;
    }>();
    for (const row of obsRows) {
      const bucket = sessions.get(row.session_id) ?? {
        last: null, prev: null, max: null, chatCount: 0, window: null, lastObsAt: null, model: null,
      };
      bucket.lastObsAt = row.timestamp;
      // Latest observation wins, including null: if the most recent
      // declaration has no window, the session's window is unknown.
      bucket.window = row.context_window;
      if (row.kind === 'chat' && row.input_tokens !== null) {
        bucket.prev = bucket.last;
        bucket.last = row;
        bucket.model = row.model;
        bucket.chatCount += 1;
        bucket.max = bucket.max === null ? row.input_tokens : Math.max(bucket.max, row.input_tokens);
      }
      sessions.set(row.session_id, bucket);
    }

    const out: Array<{
      sessionId: string; title: string | null; cwd: string | null;
      origin: string | null; parentSessionId: string | null;
      model: string | null;
      lastInput: number | null; lastInputAt: number | null; lastRequestId: string | null;
      prevInput: number | null; delta: number | null; modelSwitched: boolean;
      maxInput: number | null; observedRequests: number; totalRequests: number;
      compactions: number; contextWindow: number | null; lastObsAt: number | null;
    }> = [];
    for (const meta of metaRows) {
      const bucket = sessions.get(meta.session_id);
      const countsRow = counts.get(meta.session_id);
      const last = bucket?.last ?? null;
      const prev = bucket?.prev ?? null;
      out.push({
        sessionId: meta.session_id,
        title: typeof meta.title === 'string' && meta.title.length > 0 ? meta.title : null,
        cwd: meta.cwd ?? null,
        origin: meta.origin ?? null,
        parentSessionId: meta.parent_session_id ?? null,
        model: bucket?.model ?? null,
        lastInput: last?.input_tokens ?? null,
        lastInputAt: last?.timestamp ?? null,
        lastRequestId: last?.request_id ?? null,
        prevInput: prev?.input_tokens ?? null,
        delta: last !== null && prev !== null && last.input_tokens !== null && prev.input_tokens !== null
          ? last.input_tokens - prev.input_tokens
          : null,
        modelSwitched: last !== null && prev !== null
          && last.model !== null && prev.model !== null
          && last.model !== prev.model,
        maxInput: bucket?.max ?? null,
        observedRequests: bucket?.chatCount ?? 0,
        totalRequests: countsRow ? Number(countsRow.total) : 0,
        compactions: countsRow ? Number(countsRow.compactions ?? 0) : 0,
        contextWindow: bucket?.window ?? null,
        lastObsAt: bucket?.lastObsAt ?? null,
      });
    }
    out.sort((a, b) => (b.lastObsAt ?? 0) - (a.lastObsAt ?? 0));
    return out;
  }

  /**
   * Observation series of one session, ascending by seq. Beyond the stored
   * observation columns the rows are enriched at read time with the ledger's
   * per-request detail (raw token categories, duration, latency, error) and
   * the per-request cost estimate when one exists — both joined 1:1 on the
   * `usage_records` primary key, so the detail drill-down needs no second
   * fetch. Cost fields stay null when no price list covers the request.
   */
  /** Indexed record count of one session — records without observable usage
   *  are not observations, so the panel summary cannot derive it alone. */
  sessionRecordCount(sessionId: string): number {
    return Number(
      (this.db
        .prepare('SELECT COUNT(*) AS c FROM usage_records WHERE session_id = ?')
        .get(sessionId) as { c: number }).c,
    );
  }

  /** Facts for the import choice: how many requests predate a boundary
   *  (today's local midnight) and the earliest of them. */
  historyBefore(boundary: number): { count: number; first: number | null } {
    const row = this.db
      .prepare('SELECT COUNT(*) AS c, MIN(timestamp) AS f FROM usage_records WHERE timestamp < ?')
      .get(boundary) as { c: number; f: number | null };
    return { count: Number(row.c), first: row.f === null ? null : Number(row.f) };
  }

  contextObservations(sessionId: string): Array<{
    requestId: string; seq: number; timestamp: number;
    provider: string | null; model: string | null; kind: string;
    inputTokens: number | null; missingMask: number; contextWindow: number | null;
    inputRaw: number | null; cacheRead: number | null; cacheWrite: number | null;
    outputTokens: number | null; durationMs: number | null; firstTokenLatencyMs: number | null;
    errorCode: string | null;
    costMicro: number | null; costCurrency: string | null;
  }> {
    this.ensureObservationsFresh();
    // The cost join must see estimates for writes that just landed — without
    // this, a fresh request shows null cost and an amended one keeps its old
    // estimate until some other view happens to rebuild the cache.
    this.ensureCostsFresh();
    interface ObsRow {
      request_id: string; seq: number; timestamp: number;
      provider: string | null; model: string | null; kind: string;
      input_tokens: number | null; missing_mask: number; context_window: number | null;
      raw_input: number | null; cache_read_tokens: number | null; cache_write_tokens: number | null;
      output_tokens: number | null; duration_ms: number | null; first_token_latency_ms: number | null;
      error_code: string | null; total_micro: number | null; currency: string | null;
    }
    const rows = this.db
      .prepare(
        `SELECT o.request_id, o.seq, o.timestamp, o.provider, o.model, o.kind,
                o.input_tokens, o.missing_mask, o.context_window,
                r.input_tokens AS raw_input, r.cache_read_tokens, r.cache_write_tokens,
                r.output_tokens, r.duration_ms, r.first_token_latency_ms, r.error_code,
                c.total_micro, c.currency
           FROM context_observations o
           LEFT JOIN usage_records r ON r.request_id = o.request_id
           LEFT JOIN cost_entries c ON c.request_id = o.request_id
          WHERE o.session_id = ?
          ORDER BY o.seq ASC`,
      )
      .all(sessionId) as unknown as ObsRow[];
    return rows.map((row) => ({
      requestId: row.request_id,
      seq: Number(row.seq),
      timestamp: Number(row.timestamp),
      provider: row.provider,
      model: row.model,
      kind: row.kind,
      inputTokens: row.input_tokens,
      missingMask: Number(row.missing_mask ?? 0),
      contextWindow: row.context_window,
      inputRaw: row.raw_input,
      cacheRead: row.cache_read_tokens,
      cacheWrite: row.cache_write_tokens,
      outputTokens: row.output_tokens,
      durationMs: row.duration_ms,
      firstTokenLatencyMs: row.first_token_latency_ms,
      errorCode: row.error_code,
      costMicro: row.total_micro,
      costCurrency: row.currency,
    }));
  }

  close(): void {
    if (this.readOnly) {
      this.db.close();
      return;
    }
    try {
      this.db.exec('PRAGMA wal_checkpoint(TRUNCATE);');
    } catch {
      // checkpoint is best-effort on close
    }
    this.db.close();
  }
}
