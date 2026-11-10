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
import type { ContextSampleInput, SessionRow, UpsertOutcome, UsageRecord } from './domain/types.js';
import { SessionNormalizer, sessionTitleOf, type SessionHeaderLike } from './collector/normalizer.js';
import { importHistory, type RecordSink } from './collector/history-importer.js';
import { reconcileAgainstLogs, type ReconcileSessionQuery } from './collector/reconciler.js';
import { UsageDatabase } from './storage/database.js';
import { QueryService } from './query/query-service.js';
import { buildSuggestions, type OpenRouterModel } from './domain/openrouter.js';

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

interface CommandsLike {
  register(definition: {
    name: string;
    description: string;
    handler: () => { kind: string; text: string };
  }): () => void;
}

interface ToolsLike {
  register(definition: {
    name: string;
    description: string;
    output: {
      schema: Record<string, unknown>;
      render(args: unknown, value: unknown): unknown;
    };
    parameters: Record<string, unknown>;
    execute(args: unknown): Promise<unknown>;
  }): () => void;
}

interface InjectedContext {
  commands?: CommandsLike;
  tools?: ToolsLike;
  webServer?: WebServerLike;
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
  /** Declare service dependencies; the callback runs once they are available. */
  inject(deps: string[], callback: (ctx: InjectedContext) => void | (() => void)): void;
  get<K extends string>(name: K): unknown;
  logger: {
    info(...args: unknown[]): void;
    warn(...args: unknown[]): void;
  };
}

interface NodeRequestLike {
  method?: string | undefined;
  url?: string | undefined;
  on(event: 'data', listener: (chunk: Buffer) => void): void;
  on(event: 'end', listener: () => void): void;
  on(event: 'error', listener: (error: Error) => void): void;
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

interface ConfigEditorLike {
  edit(
    entry: unknown,
    change: (
      current: Record<string, unknown>,
      inherited: Record<string, unknown>,
    ) => Record<string, unknown> | Promise<Record<string, unknown>>,
  ): Promise<void>;
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
        const outcome = store.upsertRecord(record);
        // Always try to fill: on replays the UPDATE matches no open samples
        // (cheap no-op), while gating on the outcome would leave historical
        // sessions unfilled forever.
        store.fillContextTokens(record);
        return outcome;
      },
      writeSessionRow(row: SessionRow): void {
        store.upsertSession(row);
      },
      writeContextSample(sample: ContextSampleInput): void {
        store.upsertContextSample(sample);
      },
      writeSessionTitle(sessionId: string, title: string): void {
        store.setSessionTitle(sessionId, title);
      },
    };

    // ----- live collection -------------------------------------------------
    const trackers = new Map<string, SessionNormalizer>();
    const sessionRowCache = new Map<string, boolean>();

    const ensureTracker = (session: HostSession): SessionNormalizer | undefined => {
      const existing = trackers.get(session.id);
      if (existing !== undefined) return existing;
      const tracker = new SessionNormalizer(session.id, session.header ?? {}, {
        // A live orphan retry points at a pre-boot attempt owned by history
        // import; recording it here would double-count the call for good.
        orphanRetry: 'ignore',
      });
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
          title: null,
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
        const sample = tracker.processContext(event);
        if (sample !== null) sink.writeContextSample?.(sample);
        const title = sessionTitleOf(event);
        if (title !== null) sink.writeSessionTitle?.(session.id, title);
        if (typeof event.seq === 'number') {
          sink.writeSessionRow({
            sessionId: session.id,
            createdAt: null,
            cwd: null,
            parentSessionId: null,
            origin: null,
            seedLength: null,
            lastSeq: event.seq,
            title: null,
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
    // Declarative injection, NOT ctx.get(): on a cold boot this plugin row can
    // activate before the webServer service exists, and a plain get() would
    // silently miss it (panel then 404s). The injected callback runs whenever
    // webServer becomes available, and its disposer unregisters the route.
    let offRoute: (() => void) | undefined;
    ctx.inject(['webServer'], (webCtx) => {
      const webServer = webCtx.webServer;
      if (webServer === undefined || typeof webServer.register !== 'function') return;
      try {
        const send = (res: NodeResponseLike, status: number, payload: unknown): void => {
          const body = JSON.stringify(payload, null, 1);
          res.writeHead(status, {
            'content-type': 'application/json; charset=utf-8',
            'cache-control': 'no-store',
          });
          res.end(body);
        };
        const methodNotAllowed = (res: NodeResponseLike): void => {
          res.writeHead(405, { allow: 'GET, HEAD' });
          res.end();
        };
        const readJsonBody = (req: NodeRequestLike, limit = 65536): Promise<unknown> =>
          new Promise((resolve, reject) => {
            const chunks: Buffer[] = [];
            let size = 0;
            let failed = false;
            req.on('data', (chunk: Buffer) => {
              if (failed) return;
              size += chunk.length;
              if (size > limit) {
                failed = true;
                reject(new Error('request body too large'));
                return;
              }
              chunks.push(chunk);
            });
            req.on('end', () => {
              if (failed) return;
              try {
                resolve(chunks.length === 0 ? {} : JSON.parse(Buffer.concat(chunks).toString('utf8')));
              } catch (error) {
                reject(error instanceof Error ? error : new Error('invalid JSON body'));
              }
            });
            req.on('error', (error: Error) => {
              if (!failed) reject(error);
            });
          });
        const localDateISO = (): string => {
          const d = new Date();
          const p = (n: number): string => String(n).padStart(2, '0');
          return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
        };

        // Manual reference-price import: POST-only, user-confirmed write path.
        // Nothing here runs unless the costs tab explicitly asks for it.
        const handleSuggest = async (req: NodeRequestLike, res: NodeResponseLike): Promise<void> => {
          try {
            const response = await fetch('https://openrouter.ai/api/v1/models', {
              headers: { accept: 'application/json' },
              signal: AbortSignal.timeout(20000),
            });
            if (!response.ok) throw new Error(`openrouter responded ${response.status}`);
            const payload = (await response.json()) as { data?: unknown };
            const list = Array.isArray(payload.data) ? payload.data : [];
            const orModels: OpenRouterModel[] = [];
            for (const item of list) {
              if (item === null || typeof item !== 'object') continue;
              const record = item as Record<string, unknown>;
              if (typeof record.id !== 'string' || record.id.length === 0) continue;
              orModels.push({
                id: record.id,
                name: typeof record.name === 'string' ? record.name : null,
                pricing:
                  record.pricing !== null && typeof record.pricing === 'object'
                    ? (record.pricing as Record<string, unknown>)
                    : null,
              });
            }
            send(res, 200, {
              source: 'openrouter',
              fetchedAt: Date.now(),
              suggestions: buildSuggestions(store.providerModelPairs(), orModels),
            });
          } catch (error) {
            send(res, 502, { error: error instanceof Error ? error.message : String(error) });
          }
        };
        const handleImport = async (req: NodeRequestLike, res: NodeResponseLike): Promise<void> => {
          try {
            const body = (await readJsonBody(req)) as {
              effectiveFrom?: unknown; name?: unknown; models?: unknown;
            };
            const rawModels = Array.isArray(body.models) ? body.models : [];
            if (rawModels.length === 0 || rawModels.length > 500) {
              send(res, 400, { error: 'models must contain 1–500 entries' });
              return;
            }
            const rows: Array<{
              provider?: string; model: string;
              input?: number; output?: number; cacheRead?: number; cacheWrite?: number;
            }> = [];
            for (const item of rawModels) {
              if (item === null || typeof item !== 'object') {
                send(res, 400, { error: 'invalid models entry' });
                return;
              }
              const record = item as Record<string, unknown>;
              if (typeof record.model !== 'string' || record.model.length === 0) {
                send(res, 400, { error: 'models entry missing model' });
                return;
              }
              const price = (key: string): number | undefined => {
                const value = record[key];
                if (value === null || value === undefined) return undefined;
                if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) {
                  throw new Error(`invalid ${key} for ${record.model}`);
                }
                return value;
              };
              const row: typeof rows[number] = { model: record.model };
              if (typeof record.provider === 'string' && record.provider.length > 0) {
                row.provider = record.provider;
              }
              const input = price('input');
              const output = price('output');
              const cacheRead = price('cacheRead');
              const cacheWrite = price('cacheWrite');
              if (input !== undefined) row.input = input;
              if (output !== undefined) row.output = output;
              if (cacheRead !== undefined) row.cacheRead = cacheRead;
              if (cacheWrite !== undefined) row.cacheWrite = cacheWrite;
              rows.push(row);
            }
            const entry = (ctx as HostContext & { fiber?: { entry?: unknown } }).fiber?.entry;
            const editor = ctx.get('configEditor') as ConfigEditorLike | undefined;
            if (entry === undefined || editor === undefined || typeof editor.edit !== 'function') {
              send(res, 503, {
                error: 'config editor unavailable in this profile; add the price list to cordis.patch.yml manually',
              });
              return;
            }
            const effectiveFrom =
              typeof body.effectiveFrom === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(body.effectiveFrom)
                ? body.effectiveFrom
                : localDateISO();
            const name =
              typeof body.name === 'string' && body.name.length > 0
                ? body.name
                : `openrouter ${effectiveFrom}`;
            const newList = { name, currency: 'USD', effectiveFrom, models: rows };
            await editor.edit(entry, (current) => ({
              ...current,
              prices: [...(Array.isArray(current.prices) ? current.prices : []), newList],
            }));
            ctx.logger.info(`dsh-usage-center: imported ${rows.length} reference price row(s) from openrouter`);
            send(res, 200, { ok: true, imported: rows.length, note: 'plugin reloads to apply the new price list' });
          } catch (error) {
            send(res, 500, { error: error instanceof Error ? error.message : String(error) });
          }
        };
        offRoute = webServer.register({
          kind: 'prefix',
          path: apiPath,
          handler: (req, res) => {
            try {
              const url = new URL(req.url ?? '/', 'http://localhost');
              const rest = url.pathname
                .slice(url.pathname.indexOf(apiPath) + apiPath.length)
                .replace(/^\/+/, '');
              if (req.method === 'POST') {
                if (rest === 'prices/suggest') {
                  void handleSuggest(req, res);
                  return;
                }
                if (rest === 'prices/import') {
                  void handleImport(req, res);
                  return;
                }
                methodNotAllowed(res);
                return;
              }
              if (req.method !== 'GET' && req.method !== 'HEAD') {
                methodNotAllowed(res);
                return;
              }
              const sub = rest.split('/')[0];
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
                case 'health': {
                  let integrations: Record<string, string> = {};
                  try {
                    integrations = JSON.parse(store.getMeta('integrations') ?? '{}') as Record<string, string>;
                  } catch {
                    integrations = {};
                  }
                  send(res, 200, { ok: true, database: dbPath, integrations });
                  return;
                }
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
                  const by = str('by');
                  if (by === 'provider' || by === 'model') {
                    send(res, 200, { by, series: query.trendSeries(by, num('days')) });
                  } else {
                    send(res, 200, { by: 'all', points: query.trend(num('days')) });
                  }
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
                case 'context': {
                  send(res, 200, query.context(str('sessionId')));
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
      } catch (error) {
        ctx.logger.warn('dsh-usage-center: webServer route registration skipped', error);
      }
      // Disposer: unregister when the service goes away (the fiber may re-run).
      return () => {
        offRoute?.();
        offRoute = undefined;
      };
    });

    // ----- optional integrations: /usage command + read-only agent tool -----
    // Cordis services are resolved through declared `ctx.inject([...])`;
    // registration outcomes are recorded in meta and surfaced by /health so
    // failures are diagnosable without host logs.
    const integrations: Record<string, string> = {};
    const recordIntegration = (key: string, attempt: () => void): void => {
      try {
        attempt();
        integrations[key] = 'ok';
      } catch (error) {
        integrations[key] = String((error as Error)?.message ?? error);
      }
    };
    ctx.inject(['commands'], (commandCtx) => {
      recordIntegration('commands', () => {
        commandCtx.commands!.register({
          name: 'usage',
          description: 'dsh-usage-center: requests, tokens, cache hit rate and top models across all sessions',
          handler: () => ({ kind: 'success', text: query.usageText('summary') }),
        });
      });
      store.setMeta('integrations', JSON.stringify(integrations));
    });
    ctx.inject(['tools'], (toolCtx) => {
      recordIntegration('tools', () => {
        toolCtx.tools!.register({
          name: 'usage_center',
          description:
            'Read the local usage ledger collected by dsh-usage-center: totals, today, per-model token usage, or the context monitor. Read-only.',
          output: {
            schema: { type: 'object' },
            render(args: unknown, value: unknown) {
              return [{ type: 'text', text: JSON.stringify(value, null, 2) }];
            },
          },
          parameters: {
            type: 'object',
            properties: {
              view: {
                type: 'string',
                enum: ['summary', 'today', 'models', 'context'],
                description: 'Which view to return. "context" with sessionId returns that session\'s context samples.',
              },
              sessionId: {
                type: 'string',
                description: 'Optional session id; used by view "context" for the per-session series.',
              },
            },
            additionalProperties: false,
          },
          async execute(args: unknown) {
            const a = (typeof args === 'object' && args !== null ? args : {}) as {
              view?: unknown; sessionId?: unknown;
            };
            const view = a.view === 'today' || a.view === 'models' || a.view === 'context'
              ? a.view
              : 'summary';
            if (view === 'context' && typeof a.sessionId === 'string' && a.sessionId.length > 0) {
              return query.context(a.sessionId);
            }
            return { view, text: query.usageText(view) };
          },
        });
      });
      store.setMeta('integrations', JSON.stringify(integrations));
    });

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
