/**
 * QueryService: the single query surface of dsh-usage-center.
 *
 * Every consumer (HTTP API, dashboard, future slash command or agent tool)
 * goes through this service; no consumer computes its own statistics.
 */

import type {
  BreakdownDim,
  BreakdownRow,
  SessionSummaryRow,
  TrendPoint,
  UsageTotals,
} from '../domain/types.js';
import type { UsageDatabase } from '../storage/database.js';

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
    const ledgerRow = this.store.db
      .prepare('SELECT COUNT(*) AS c, MIN(timestamp) AS first, MAX(timestamp) AS last FROM usage_records')
      .get() as { c: number; first: number | null; last: number | null };
    const kinds = this.store.db
      .prepare(
        'SELECT kind, COUNT(*) AS requests, SUM(total_tokens) AS total_tokens ' +
          'FROM usage_records GROUP BY kind ORDER BY requests DESC',
      )
      .all() as Array<{ kind: string; requests: number; total_tokens: number | null }>;
    return {
      totals: this.store.totals(filters),
      today: this.store.totals({ ...filters, from: todayStart }),
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
}
