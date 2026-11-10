/**
 * History importer: replays persisted sessions through the same normalizer the
 * live collector uses, so "history == live" by construction.
 *
 * Access path: `ctx.sessionQuery.listSessions()` + `readSession(id)` — the
 * official live-preferred query service (the same path dsh-usage-stats uses).
 * Sessions are processed with a small worker pool; every write is an
 * idempotent upsert, so re-importing is always safe.
 */
import { SessionNormalizer, sessionTitleOf } from './normalizer.js';
/** Import every persisted session the sessionQuery service lists. */
export async function importHistory(sessionQuery, sink, options = {}) {
    const concurrency = Math.min(Math.max(options.concurrency ?? 2, 1), 8);
    const result = {
        sessions: 0,
        events: 0,
        records: { inserted: 0, updated: 0, unchanged: 0 },
        errors: [],
    };
    let records;
    try {
        records = await sessionQuery.listSessions(options.signal);
    }
    catch (error) {
        result.errors.push({
            sessionId: '<listSessions>',
            error: error instanceof Error ? error.message : String(error),
        });
        return result;
    }
    const queue = [...records];
    const stats = { inserted: 0, updated: 0, unchanged: 0 };
    const worker = async () => {
        for (;;) {
            if (options.signal?.aborted)
                return;
            const record = queue.shift();
            if (record === undefined)
                return;
            const header = record.header ?? {};
            const sessionId = header.id;
            if (typeof sessionId !== 'string' || sessionId.length === 0)
                continue;
            try {
                const snapshot = await sessionQuery.readSession(sessionId);
                const events = Array.isArray(snapshot.events) ? snapshot.events : [];
                const effectiveHeader = snapshot.session ?? snapshot.header ?? header;
                const normalizer = new SessionNormalizer(sessionId, effectiveHeader);
                let lastSeq = null;
                for (const event of events) {
                    const usage = normalizer.process(event);
                    if (usage !== null) {
                        const outcome = sink.writeRecord(usage);
                        if (outcome === 'inserted')
                            stats.inserted += 1;
                        else if (outcome === 'updated')
                            stats.updated += 1;
                        else
                            stats.unchanged += 1;
                    }
                    const sample = normalizer.processContext(event);
                    if (sample !== null)
                        sink.writeContextSample?.(sample);
                    const title = sessionTitleOf(event);
                    if (title !== null)
                        sink.writeSessionTitle?.(sessionId, title);
                    if (typeof event.seq === 'number')
                        lastSeq = event.seq;
                }
                sink.writeSessionRow({
                    sessionId,
                    createdAt: typeof effectiveHeader.createdAt === 'number' ? effectiveHeader.createdAt : null,
                    cwd: typeof effectiveHeader.cwd === 'string' ? effectiveHeader.cwd : null,
                    parentSessionId: typeof effectiveHeader.parentSession === 'string'
                        ? effectiveHeader.parentSession
                        : null,
                    origin: typeof effectiveHeader.origin === 'string' ? effectiveHeader.origin : null,
                    seedLength: typeof effectiveHeader.seedLength === 'number' ? effectiveHeader.seedLength : null,
                    lastSeq,
                    title: null,
                    updatedAt: Date.now(),
                });
                result.sessions += 1;
                result.events += events.length;
            }
            catch (error) {
                result.errors.push({
                    sessionId,
                    error: error instanceof Error ? error.message : String(error),
                });
            }
        }
    };
    await Promise.all(Array.from({ length: concurrency }, () => worker()));
    result.records = { ...stats };
    return result;
}
