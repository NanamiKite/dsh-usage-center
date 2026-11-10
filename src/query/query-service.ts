/**
 * QueryService: the single query surface of dsh-usage-center.
 *
 * Every consumer (HTTP API, dashboard, future slash command or agent tool)
 * goes through this service; no consumer computes its own statistics.
 */

import type {
  BreakdownDim,
  BreakdownRow,
  CostByCurrency,
  SessionSummaryRow,
  TrendPoint,
  UsageTotals,
} from '../domain/types.js';
import { UsageDatabase } from '../storage/database.js';
import { toCsv } from '../domain/csv.js';

export interface UsageFilters {
  sessionId?: string;
  provider?: string;
  model?: string;
  kind?: string;
  from?: number;
  to?: number;
  includeSeed?: boolean;
}

export interface RequestQuery extends UsageFilters {
  limit?: number;
  offset?: number;
  order?: 'asc' | 'desc';
}

export interface SummaryResult {
  totals: UsageTotals;
  today: UsageTotals;
  byModel: Array<{
    provider: string | null;
    model: string | null;
    requests: number;
    totalTokens: number;
  }>;
  byKind: Array<{ kind: string; requests: number; totalTokens: number }>;
  sessions: Array<{
    sessionId: string;
    createdAt: number | null;
    cwd: string | null;
    origin: string | null;
    parentSessionId: string | null;
    recordCount: number;
  }>;
  ledger: { records: number; firstTimestamp: number | null; lastTimestamp: number | null };
  /** Estimated totals per currency, or null when no price list is synced. */
  costs: CostByCurrency[] | null;
}

function startOfLocalDay(epochMs: number): number {
  const d = new Date(epochMs);
  d.setHours(0, 0, 0, 0);
  return d.getTime();
}

export class QueryService {
  constructor(private readonly store: UsageDatabase) {}

  summary(filters: UsageFilters = {}): SummaryResult {
    const todayStart = startOfLocalDay(Date.now());
    // "Today" intersects the caller's window instead of overriding it: with
    // from/to set, the today figures stay inside the requested range.
    const todayFrom = Math.max(todayStart, filters.from ?? todayStart);
    const todayTo = filters.to !== undefined && filters.to < todayStart
      ? filters.to // range ends before today: keep it, totals will be empty
      : filters.to;
    const ledgerRow = this.store.db
      .prepare('SELECT COUNT(*) AS c, MIN(timestamp) AS first, MAX(timestamp) AS last FROM usage_records')
      .get() as { c: number; first: number | null; last: number | null };
    const { clause, params } = UsageDatabase.WHERE(filters);
    const kinds = this.store.db
      .prepare(
        'SELECT kind, COUNT(*) AS requests, SUM(total_tokens) AS total_tokens ' +
          `FROM usage_records${clause} GROUP BY kind ORDER BY requests DESC`,
      )
      .all(...params) as Array<{ kind: string; requests: number; total_tokens: number | null }>;
    return {
      totals: this.store.totals(filters),
      today: this.store.totals({ ...filters, from: todayFrom, to: todayTo }),
      byModel: this.store.byModel(filters),
      byKind: kinds.map((k) => ({
        kind: k.kind,
        requests: Number(k.requests),
        totalTokens: Number(k.total_tokens ?? 0),
      })),
      sessions: this.store.listSessions().map((s) => ({
        sessionId: s.sessionId,
        createdAt: s.createdAt,
        cwd: s.cwd,
        origin: s.origin,
        parentSessionId: s.parentSessionId,
        recordCount: s.recordCount,
      })),
      ledger: {
        records: Number(ledgerRow.c ?? 0),
        firstTimestamp: ledgerRow.first ?? null,
        lastTimestamp: ledgerRow.last ?? null,
      },
      costs: this.store.listPriceLists().length > 0
        ? this.store.costAggregates(filters).byCurrency
        : null,
    };
  }

  listRequests(query: RequestQuery = {}) {
    return this.store.listRecords(query);
  }

  sessionSummary(sessionId: string) {
    return {
      session: this.store.getSession(sessionId) ?? null,
      totals: this.store.totals({ sessionId }),
      records: this.store.listRecords({ sessionId, limit: 1000, order: 'asc' }),
    };
  }

  // -------------------------------------------------------------------------
  // Dashboard surfaces. All statistics flow through this service — the HTTP
  // API and the client dashboard are both thin consumers.

  /** Daily trend over the last `days` local days (zero-filled). */
  trend(days?: number): TrendPoint[] {
    return this.store.trend(days ?? 30);
  }

  /** Per-series daily trend grouped by provider or model (top keys + rest). */
  trendSeries(by: 'provider' | 'model', days?: number): Array<{ key: string; points: Array<{ day: string; totalTokens: number }> }> {
    return this.store.trendSeries(by, days ?? 30);
  }

  /** Requests grouped by `model` | `provider` | `kind`. */
  breakdown(dim: BreakdownDim, filters: UsageFilters = {}): BreakdownRow[] {
    if (dim !== 'model' && dim !== 'provider' && dim !== 'kind') {
      throw new Error(`dsh-usage-center: unknown breakdown dimension "${String(dim)}"`);
    }
    return this.store.breakdown(dim, {
      from: filters.from,
      to: filters.to,
      includeSeed: filters.includeSeed,
    });
  }

  /** Per-session usage summaries (ledger view). */
  sessions(query: { limit?: number; offset?: number } = {}): {
    items: SessionSummaryRow[];
    total: number;
  } {
    return this.store.sessionSummaries(query);
  }

  // -------------------------------------------------------------------------
  // Estimated costs and exports.

  /** Configured price lists (read-only view of the synced config). */
  prices(): { configured: boolean; lists: ReturnType<UsageDatabase['listPriceLists']> } {
    const lists = this.store.listPriceLists();
    return { configured: lists.length > 0, lists };
  }

  // -------------------------------------------------------------------------
  // Context monitor.

  /** Latest context state per session, or one session's sample series. */
  context(sessionId?: string): {
    sessions?: ReturnType<UsageDatabase['contextSessions']>;
    sessionId?: string;
    samples?: ReturnType<UsageDatabase['contextSamples']>;
  } {
    if (sessionId !== undefined && sessionId.length > 0) {
      return { sessionId, samples: this.store.contextSamples(sessionId) };
    }
    return { sessions: this.store.contextSessions() };
  }

  /** Compact multi-line usage summary (slash command / agent tool). */
  usageText(scope: 'summary' | 'today' | 'models' | 'context' = 'summary'): string {
    const compact = (n: number): string =>
      new Intl.NumberFormat('en', { notation: 'compact', maximumFractionDigits: 1 }).format(n);
    const lines: string[] = [];
    if (scope === 'context') {
      const rows = this.store.contextSessions().slice(0, 8);
      lines.push('context monitor (latest per session):');
      for (const row of rows) {
        const pct = row.contextTokens !== null && row.contextWindow
          ? ` (${Math.round((row.contextTokens / row.contextWindow) * 100)}% of ${compact(row.contextWindow)})`
          : '';
        lines.push(
          `- ${row.sessionId.slice(0, 16)}… ${row.provider ?? '?'}/${row.model ?? '?'}: ` +
            `${row.contextTokens === null ? 'unknown' : compact(row.contextTokens)} tokens${pct}` +
            (row.compactions > 0 ? ` · ${row.compactions} compaction(s)` : ''),
        );
      }
      if (rows.length === 0) lines.push('- no context samples yet');
      return lines.join('\n');
    }
    const summary = this.summary();
    if (scope === 'models') {
      lines.push('usage by model (all time):');
      for (const row of summary.byModel.slice(0, 8)) {
        lines.push(`- ${row.provider ?? '?'}/${row.model ?? '?'}: ${row.requests} requests · ${compact(row.totalTokens)} tokens`);
      }
      return lines.join('\n');
    }
    const source = scope === 'today' ? summary.today : summary.totals;
    const label = scope === 'today' ? 'today' : 'all time';
    lines.push(
      `usage ${label}: ${source.requests} requests · ${compact(source.totalTokens)} tokens` +
        (source.cacheHitRate !== null ? ` · cache hit ${(source.cacheHitRate * 100).toFixed(1)}%` : ''),
    );
    lines.push(
      `tokens: in ${compact(source.inputTokens)} / out ${compact(source.outputTokens)} / ` +
        `cache read ${compact(source.cacheReadTokens)} / cache write ${compact(source.cacheWriteTokens)}`,
    );
    if (scope !== 'today') {
      for (const row of summary.byModel.slice(0, 3)) {
        lines.push(`- ${row.provider ?? '?'}/${row.model ?? '?'}: ${compact(row.totalTokens)} tokens`);
      }
      if (summary.costs !== null) {
        for (const cost of summary.costs) {
          lines.push(`- estimated cost: ${(cost.totalMicro / 1e6).toFixed(4)} ${cost.currency} (estimate, not a bill)`);
        }
      }
    }
    return lines.join('\n');
  }

  /** Aggregated estimated costs, or `configured: false` with no prices. */
  costs(filters: { from?: number; to?: number } = {}): {
    configured: boolean;
    byCurrency?: CostByCurrency[];
    byModel?: ReturnType<UsageDatabase['costAggregates']>['byModel'];
    byDay?: ReturnType<UsageDatabase['costAggregates']>['byDay'];
    coverage?: { totalRequests: number; pricedRequests: number };
  } {
    if (this.store.listPriceLists().length === 0) return { configured: false };
    const aggregates = this.store.costAggregates(filters);
    return { configured: true, ...aggregates };
  }

  /** Row shaping shared by the CSV and JSON exports. */
  exportData(
    what: 'records' | 'costs' | 'sessions',
    filters: { sessionId?: string; provider?: string; model?: string; kind?: string; from?: number; to?: number } = {},
  ): { headers: string[]; rows: Array<Array<string | number | null>> } {
    const iso = (ts: number | null): string | null =>
      typeof ts === 'number' ? new Date(ts).toISOString() : null;
    if (what === 'records') {
      const items = this.store.exportRecords(filters);
      return {
        headers: [
          'request_id', 'session_id', 'timestamp_iso', 'provider', 'model', 'kind',
          'turn', 'step', 'origin', 'input_tokens', 'output_tokens',
          'cache_read_tokens', 'cache_write_tokens', 'reasoning_tokens', 'total_tokens',
          'duration_ms', 'first_token_latency_ms', 'finish_reason', 'error_code',
        ],
        rows: items.map((r) => [
          r.requestId, r.sessionId, iso(r.timestamp), r.provider, r.model, r.kind,
          r.turn, r.step, r.origin, r.inputTokens, r.outputTokens,
          r.cacheReadTokens, r.cacheWriteTokens, r.reasoningTokens, r.totalTokens,
          r.durationMs, r.firstTokenLatencyMs, r.finishReason, r.errorCode,
        ]),
      };
    }
    if (what === 'costs') {
      const items = this.store.costRows(filters);
      const cell = (value: unknown): string | number | null =>
        typeof value === 'string' || typeof value === 'number' || value === null ? value : null;
      return {
        headers: [
          'request_id', 'session_id', 'timestamp_iso', 'provider', 'model', 'kind',
          'currency', 'input_tokens', 'output_tokens', 'cache_read_tokens',
          'cache_write_tokens', 'total_tokens', 'input_cost_micro',
          'output_cost_micro', 'cache_read_cost_micro', 'cache_write_cost_micro',
          'total_cost_micro', 'missing_mask',
        ],
        rows: items.map((r) => [
          cell(r.request_id), cell(r.session_id), iso(typeof r.timestamp === 'number' ? r.timestamp : null),
          cell(r.provider), cell(r.model), cell(r.kind), cell(r.currency),
          cell(r.input_tokens), cell(r.output_tokens), cell(r.cache_read_tokens),
          cell(r.cache_write_tokens), cell(r.total_tokens), cell(r.input_micro),
          cell(r.output_micro), cell(r.cache_read_micro), cell(r.cache_write_micro),
          cell(r.total_micro), cell(r.missing_mask),
        ]),
      };
    }
    const items = this.store.exportSessions();
    return {
      headers: [
        'session_id', 'created_at_iso', 'cwd', 'origin', 'parent_session_id',
        'requests', 'input_tokens', 'output_tokens', 'cache_read_tokens',
        'cache_write_tokens', 'total_tokens', 'errors',
        'first_timestamp_iso', 'last_timestamp_iso',
      ],
      rows: items.map((s) => [
        s.sessionId, iso(s.createdAt), s.cwd, s.origin, s.parentSessionId,
        s.requests, s.inputTokens, s.outputTokens, s.cacheReadTokens,
        s.cacheWriteTokens, s.totalTokens, s.errorCount,
        iso(s.firstTimestamp), iso(s.lastTimestamp),
      ]),
    };
  }

  /** CSV body for an export (BOM is added by the HTTP layer). */
  exportCsv(what: 'records' | 'costs' | 'sessions', filters: Parameters<QueryService['exportData']>[1]): string {
    const { headers, rows } = this.exportData(what, filters);
    return toCsv(headers, rows);
  }

  /** JSON documents for an export. */
  exportJson(what: 'records' | 'costs' | 'sessions', filters: Parameters<QueryService['exportData']>[1]): unknown[] {
    const { headers, rows } = this.exportData(what, filters);
    return rows.map((row) => {
      const object: Record<string, string | number | null> = {};
      headers.forEach((header, index) => { object[header] = row[index] ?? null; });
      return object;
    });
  }
}
