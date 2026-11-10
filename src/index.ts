/**
 * dsh-usage-center — Host plugin entry.
 *
 * Scope: live collection (`session/event`), history import
 * (`ctx.sessionQuery`), the idempotent SQLite ledger, and a read-only HTTP
 * query surface (`ctx.webServer`, optional). Failure of any part must never
 * affect model calls: every collector path is exception-isolated and the
 * plugin has zero hard service dependencies.
 */

import { homedir } from 'node:os';
import { join } from 'node:path';
import type { SessionRow, UpsertOutcome, UsageRecord } from './domain/types.js';
import { SessionNormalizer, type SessionHeaderLike } from './collector/normalizer.js';
import { importHistory, type RecordSink } from './collector/history-importer.js';
import { reconcileAgainstLogs, type ReconcileSessionQuery } from './collector/reconciler.js';
import { UsageDatabase } from './storage/database.js';
import { QueryService } from './query/query-service.js';

export interface UsageCenterConfig {
  /** Absolute SQLite path. Default: $DSH_HOME/dsh-usage-center/usage-center.db */
  databasePath?: string;
  /** History import worker count (1–8). Default 2. */
  importConcurrency?: number;
  /** Run the history import once at startup. Default true. */
  historyImport?: boolean;
  /** HTTP prefix for the read-only query API. Default /dsh-usage-center/v1 */
  apiPath?: string;
  /**
   * Estimated-cost price lists. Each list: `{ name?, currency, effectiveFrom,
   * models: [{ provider?, model, input?, output?, cacheRead?, cacheWrite? }] }`
   * with per-1M-token prices. Append-only and deduplicated by content hash.
   */
  prices?: unknown[];
}

// ---------------------------------------------------------------------------
// Minimal structural typing for the Host context (contracts verified against
// the installed harness).

interface HostSession {
  id: string;
  header?: SessionHeaderLike | undefined;
}

interface HostContext {
  on(event: 'session/event', listener: (session: HostSession, event: {
    type: string;
    seq: number;
    time: number;
    data?: unknown;
  }) => void): () => void;
  on(event: 'session/disposed', listener: (session: HostSession) => void): () => void;
  effect<T>(setup: () => Generator<() => void, T, unknown>): void;
  get<K extends string>(name: K): unknown;
  logger: {
    info(...args: unknown[]): void;
    warn(...args: unknown[]): void;
  };
}

interface NodeRequestLike {
  method?: string | undefined;
  url?: string | undefined;
}

interface NodeResponseLike {
  writeHead(status: number, headers?: Record<string, string | number>): NodeResponseLike;
  end(body?: string | undefined): void;
}

interface WebServerLike {
  register(route: {
    kind: 'prefix';
    path: string;
    handler: (req: NodeRequestLike, res: NodeResponseLike) => void;
  }): () => void;
}

interface SessionQueryLike {
  listSessions(signal?: AbortSignal): Promise<readonly { header?: SessionHeaderLike & { id?: string } }[]>;
  readSession(sessionId: string): Promise<{
    session?: SessionHeaderLike & { id?: string };
    header?: SessionHeaderLike & { id?: string };
    events?: ReadonlyArray<{ type: string; seq: number; time: number; data?: unknown }>;
  }>;
}

// The plugin declares no hard dependencies; optional services are resolved
// through ctx.get() so it stays active in profiles without them.
export const inject: string[] = [];

export function defaultDatabasePath(): string {
  const dshHome = process.env.DSH_HOME ?? join(homedir(), '.dsh');
  return join(dshHome, 'dsh-usage-center', 'usage-center.db');
}

export function apply(ctx: HostContext, config: UsageCenterConfig = {}): void {
  const dbPath = config.databasePath ?? defaultDatabasePath();
  const apiPath = config.apiPath ?? '/dsh-usage-center/v1';

  ctx.effect(function* () {
    const store = new UsageDatabase(dbPath);
    const query = new QueryService(store);

    // ----- price lists from config (append-only, hash-deduplicated) -------
    if (config.prices !== undefined) {
      try {
        const sync = store.syncPriceLists(config.prices);
        if (sync.synced > 0) {
          ctx.logger.info(`dsh-usage-center: synced ${sync.synced} price list(s) from config`);
        }
        if (sync.skipped > 0) {
          ctx.logger.warn(`dsh-usage-center: skipped ${sync.skipped} malformed price list(s)`);
        }
      } catch (error) {
        ctx.logger.warn('dsh-usage-center: price list sync failed', error);
      }
    }

    const sessionQuery = ctx.get('sessionQuery') as SessionQueryLike | undefined;

    const sink: RecordSink = {
      writeRecord(record: UsageRecord): UpsertOutcome {
        return store.upsertRecord(record);
      },
      writeSessionRow(row: SessionRow): void {
        store.upsertSession(row);
      },
    };

    // ----- live collection -------------------------------------------------
    const trackers = new Map<string, SessionNormalizer>();
    const sessionRowCache = new Map<string, boolean>();

    const ensureTracker = (session: HostSession): SessionNormalizer | undefined => {
      const existing = trackers.get(session.id);
      if (existing !== undefined) return existing;
      const tracker = new SessionNormalizer(session.id, session.header ?? {});
      trackers.set(session.id, tracker);
      if (!sessionRowCache.has(session.id)) {
        const header = session.header ?? {};
        store.upsertSession({
          sessionId: session.id,
          createdAt: typeof header.createdAt === 'number' ? header.createdAt : null,
          cwd: typeof header.cwd === 'string' ? header.cwd : null,
          parentSessionId:
            typeof header.parentSession === 'string' ? header.parentSession : null,
          origin: typeof header.origin === 'string' ? header.origin : null,
          seedLength: typeof header.seedLength === 'number' ? header.seedLength : null,
          lastSeq: null,
          updatedAt: Date.now(),
        });
        sessionRowCache.set(session.id, true);
      }
      return tracker;
    };

    const offEvent = ctx.on('session/event', (session, event) => {
      try {
        const tracker = ensureTracker(session);
        if (tracker === undefined) return;
        const record = tracker.process(event);
        if (record !== null) sink.writeRecord(record);
        if (typeof event.seq === 'number') {
          sink.writeSessionRow({
            sessionId: session.id,
            createdAt: null,
            cwd: null,
            parentSessionId: null,
            origin: null,
            seedLength: null,
            lastSeq: event.seq,
            updatedAt: Date.now(),
          });
        }
      } catch (error) {
        ctx.logger.warn('dsh-usage-center: live event ingest failed', error);
      }
    });

    const offDisposed = ctx.on('session/disposed', (session) => {
      trackers.delete(session.id);
    });

    // ----- history import ---------------------------------------------------
    if (config.historyImport !== false) {
      if (sessionQuery !== undefined && typeof sessionQuery.listSessions === 'function') {
        void importHistory(sessionQuery, sink, {
          concurrency: config.importConcurrency ?? 2,
        })
          .then((result) => {
            ctx.logger.info(
              `dsh-usage-center: history import done — ${result.sessions} sessions, ` +
                `${result.events} events, records +${result.records.inserted}` +
                `/~${result.records.updated}/=${result.records.unchanged}` +
                (result.errors.length > 0 ? `, ${result.errors.length} errors` : ''),
            );
            for (const error of result.errors.slice(0, 5)) {
              ctx.logger.warn(`dsh-usage-center: import error in ${error.sessionId}: ${error.error}`);
            }
          })
          .catch((error: unknown) => {
            ctx.logger.warn('dsh-usage-center: history import failed', error);
          });
      } else {
        ctx.logger.warn('dsh-usage-center: sessionQuery unavailable; history import skipped');
      }
    }

    // ----- optional read-only HTTP surface (Node req/res style, verified
    // against the webServer contract used by community plugins) ---------------
    let offRoute: (() => void) | undefined;
    try {
      const webServer = ctx.get('webServer') as WebServerLike | undefined;
      if (webServer !== undefined && typeof webServer.register === 'function') {
        const send = (res: NodeResponseLike, status: number, payload: unknown): void => {
          const body = JSON.stringify(payload, null, 1);
          res.writeHead(status, {
            'content-type': 'application/json; charset=utf-8',
            'cache-control': 'no-store',
          });
          res.end(body);
        };
        offRoute = webServer.register({
          kind: 'prefix',
          path: apiPath,
          handler: (req, res) => {
            try {
              if (req.method !== 'GET' && req.method !== 'HEAD') {
                res.writeHead(405, { allow: 'GET, HEAD' });
                res.end();
                return;
              }
              const url = new URL(req.url ?? '/', 'http://localhost');
              const sub = url.pathname
                .slice(url.pathname.indexOf(apiPath) + apiPath.length)
                .replace(/^\/+/, '')
                .split('/')[0];
              const q = url.searchParams;
              const str = (key: string): string | undefined => {
                const value = q.get(key);
                return value !== null && value.length > 0 ? value : undefined;
              };
              const num = (key: string): number | undefined => {
                const value = q.get(key);
                if (value === null) return undefined;
                const parsed = Number(value);
                return Number.isFinite(parsed) ? parsed : undefined;
              };
              switch (sub) {
                case 'health':
                  send(res, 200, { ok: true, database: dbPath });
                  return;
                case 'summary': {
                  send(res, 200, query.summary({
                    sessionId: str('sessionId'),
                    provider: str('provider'),
                    model: str('model'),
                    kind: str('kind'),
                    from: num('from'),
                    to: num('to'),
                    includeSeed:
                      q.get('includeSeed') === '0' || q.get('includeSeed') === 'false'
                        ? false
                        : undefined,
                  }));
                  return;
                }
                case 'records': {
                  send(res, 200, query.listRequests({
                    sessionId: str('sessionId'),
                    provider: str('provider'),
                    model: str('model'),
                    kind: str('kind'),
                    from: num('from'),
                    to: num('to'),
                    limit: num('limit'),
                    offset: num('offset'),
                    order: str('order') === 'asc' ? 'asc' : 'desc',
                  }));
                  return;
                }
                case 'trend': {
                  send(res, 200, { points: query.trend(num('days')) });
                  return;
                }
                case 'breakdown': {
                  const dim = str('by') ?? 'model';
                  try {
                    send(res, 200, { dim, rows: query.breakdown(dim as 'model' | 'provider' | 'kind', {
                      from: num('from'),
                      to: num('to'),
                    }) });
                  } catch {
                    send(res, 400, { error: `unknown breakdown dimension "${dim}"` });
                  }
                  return;
                }
                case 'sessions': {
                  send(res, 200, query.sessions({
                    limit: num('limit'),
                    offset: num('offset'),
                  }));
                  return;
                }
                case 'prices': {
                  send(res, 200, query.prices());
                  return;
                }
                case 'costs': {
                  send(res, 200, query.costs({
                    from: num('from'),
                    to: num('to'),
                  }));
                  return;
                }
                case 'export': {
                  const what = str('what') ?? 'records';
                  if (what !== 'records' && what !== 'costs' && what !== 'sessions') {
                    send(res, 400, { error: `unknown export "${what}"` });
                    return;
                  }
                  const filters = {
                    sessionId: str('sessionId'),
                    provider: str('provider'),
                    model: str('model'),
                    kind: str('kind'),
                    from: num('from'),
                    to: num('to'),
                  };
                  const stamp = new Date().toISOString().slice(0, 10);
                  if (str('format') === 'json') {
                    const body = JSON.stringify(query.exportJson(what, filters));
                    res.writeHead(200, {
                      'content-type': 'application/json; charset=utf-8',
                      'content-disposition': `attachment; filename="usage-center-${what}-${stamp}.json"`,
                      'cache-control': 'no-store',
                    });
                    res.end(body);
                    return;
                  }
                  const csv = `\uFEFF${query.exportCsv(what, filters)}`;
                  res.writeHead(200, {
                    'content-type': 'text/csv; charset=utf-8',
                    'content-disposition': `attachment; filename="usage-center-${what}-${stamp}.csv"`,
                    'cache-control': 'no-store',
                  });
                  res.end(csv);
                  return;
                }
                case 'report': {
                  const subReport = url.pathname.split('/').pop();
                  if (subReport !== 'reconcile') {
                    send(res, 404, { error: 'not found' });
                    return;
                  }
                  if (sessionQuery === undefined || typeof sessionQuery.listSessions !== 'function') {
                    send(res, 503, { error: 'sessionQuery unavailable' });
                    return;
                  }
                  void reconcileAgainstLogs(sessionQuery as ReconcileSessionQuery, store)
                    .then((report) => send(res, 200, report))
                    .catch((error: unknown) => {
                      ctx.logger.warn('dsh-usage-center: reconcile failed', error);
                      try {
                        send(res, 500, { error: 'reconcile failed' });
                      } catch {
                        // response already started
                      }
                    });
                  return;
                }
                default:
                  send(res, 404, { error: 'not found' });
              }
            } catch (error) {
              ctx.logger.warn('dsh-usage-center: query route failed', error);
              try {
                send(res, 500, { error: 'internal error' });
              } catch {
                // response already started; nothing more we can do
              }
            }
          },
        });
      }
    } catch (error) {
      ctx.logger.warn('dsh-usage-center: webServer route registration skipped', error);
    }

    yield () => {
      offEvent();
      offDisposed();
      offRoute?.();
      try {
        store.close();
      } catch {
        // closing is best-effort during teardown
      }
    };
  });
}
