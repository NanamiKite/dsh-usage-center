/**
 * QueryService: the single query surface of dsh-usage-center.
 *
 * Every consumer (HTTP API, dashboard, future slash command or agent tool)
 * goes through this service; no consumer computes its own statistics.
 */
import { UsageDatabase } from '../storage/database.js';
import { toCsv } from '../domain/csv.js';
function startOfLocalDay(epochMs) {
    const d = new Date(epochMs);
    d.setHours(0, 0, 0, 0);
    return d.getTime();
}
export class QueryService {
    store;
    constructor(store) {
        this.store = store;
    }
    summary(filters = {}) {
        const todayStart = startOfLocalDay(Date.now());
        // "Today" intersects the caller's window instead of overriding it: with
        // from/to set, the today figures stay inside the requested range.
        const todayFrom = Math.max(todayStart, filters.from ?? todayStart);
        const todayTo = filters.to !== undefined && filters.to < todayStart
            ? filters.to // range ends before today: keep it, totals will be empty
            : filters.to;
        const ledgerRow = this.store.db
            .prepare('SELECT COUNT(*) AS c, MIN(timestamp) AS first, MAX(timestamp) AS last FROM usage_records')
            .get();
        const { clause, params } = UsageDatabase.WHERE(filters);
        const kinds = this.store.db
            .prepare('SELECT kind, COUNT(*) AS requests, SUM(total_tokens) AS total_tokens ' +
            `FROM usage_records${clause} GROUP BY kind ORDER BY requests DESC`)
            .all(...params);
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
    listRequests(query = {}) {
        return this.store.listRecords(query);
    }
    sessionSummary(sessionId) {
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
    trend(days) {
        return this.store.trend(days ?? 30);
    }
    /** Per-series daily trend grouped by provider or model (top keys + rest). */
    trendSeries(by, days) {
        return this.store.trendSeries(by, days ?? 30);
    }
    /** Requests grouped by `model` | `provider` | `kind`. */
    breakdown(dim, filters = {}) {
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
    sessions(query = {}) {
        return this.store.sessionSummaries(query);
    }
    // -------------------------------------------------------------------------
    // Estimated costs and exports.
    /** Configured price lists (read-only view) + the retroactive-mode state. */
    prices() {
        const lists = this.store.listPriceLists();
        return { configured: lists.length > 0, retroactive: this.store.retroactivePricing(), lists };
    }
    // -------------------------------------------------------------------------
    // Context monitor.
    /** Per-session observation aggregates, or one session's observation series. */
    context(sessionId) {
        if (sessionId !== undefined && sessionId.length > 0) {
            return {
                sessionId,
                totalRequests: this.store.sessionRecordCount(sessionId),
                observations: this.store.contextObservations(sessionId),
            };
        }
        return { sessions: this.store.contextOverview() };
    }
    /** Compact multi-line usage summary (slash command / agent tool). */
    usageText(scope = 'summary') {
        const compact = (n) => new Intl.NumberFormat('en', { notation: 'compact', maximumFractionDigits: 1 }).format(n);
        const lines = [];
        if (scope === 'context') {
            const rows = this.store.contextOverview().slice(0, 8);
            lines.push('context observations (per session, latest first):');
            for (const row of rows) {
                const window = row.lastInput !== null && row.contextWindow !== null
                    ? ` of ${compact(row.contextWindow)} (${Math.round((row.lastInput / row.contextWindow) * 100)}%)`
                    : '';
                const delta = row.delta === null ? '' : row.delta >= 0 ? ` (+${compact(row.delta)})` : ` (${compact(row.delta)})`;
                lines.push(`- ${(row.title ?? row.sessionId.slice(0, 16)).slice(0, 40)} ${row.model ?? '?'}: ` +
                    `last input ${row.lastInput === null ? 'unknown' : compact(row.lastInput)}${window}${delta}` +
                    ` · max ${row.maxInput === null ? '?' : compact(row.maxInput)}` +
                    ` · ${row.observedRequests} observed / ${row.totalRequests} requests` +
                    (row.compactions > 0 ? ` · ${row.compactions} compaction(s)` : ''));
            }
            if (rows.length === 0)
                lines.push('- no observations yet');
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
        lines.push(`usage ${label}: ${source.requests} requests · ${compact(source.totalTokens)} tokens` +
            (source.cacheHitRate !== null ? ` · cache hit ${(source.cacheHitRate * 100).toFixed(1)}%` : ''));
        lines.push(`tokens: in ${compact(source.inputTokens)} / out ${compact(source.outputTokens)} / ` +
            `cache read ${compact(source.cacheReadTokens)} / cache write ${compact(source.cacheWriteTokens)}`);
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
    costs(filters = {}) {
        const lists = this.store.listPriceLists();
        if (lists.length === 0)
            return { configured: false };
        const aggregates = this.store.costAggregates(filters);
        const newest = lists[lists.length - 1];
        return {
            configured: true,
            effectiveFrom: newest === undefined ? null : newest.effectiveFrom,
            ...aggregates,
        };
    }
    /** Row shaping shared by the CSV and JSON exports. */
    exportData(what, filters = {}) {
        const iso = (ts) => typeof ts === 'number' ? new Date(ts).toISOString() : null;
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
            const cell = (value) => typeof value === 'string' || typeof value === 'number' || value === null ? value : null;
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
    exportCsv(what, filters) {
        const { headers, rows } = this.exportData(what, filters);
        return toCsv(headers, rows);
    }
    /** JSON documents for an export. */
    exportJson(what, filters) {
        const { headers, rows } = this.exportData(what, filters);
        return rows.map((row) => {
            const object = {};
            headers.forEach((header, index) => { object[header] = row[index] ?? null; });
            return object;
        });
    }
}
