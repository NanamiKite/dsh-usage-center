import test from 'node:test';
import assert from 'node:assert/strict';
import { UsageDatabase } from '../lib/storage/database.js';
import { QueryService } from '../lib/query/query-service.js';
import { SessionNormalizer } from '../lib/collector/normalizer.js';
import { matchOpenRouter } from '../lib/domain/openrouter.js';

function record(over = {}) {
  return {
    requestId: 's1:10', sessionId: 's1', seq: 10, turn: 1, step: 1,
    parentSessionId: null, origin: null, isSeed: 0, cwd: null,
    provider: 'glm', model: 'glm-5.3', kind: 'chat', timestamp: 1794000000000,
    inputTokens: 100, outputTokens: 50, cacheReadTokens: 0, cacheWriteTokens: 0,
    reasoningTokens: null, totalTokens: 150, durationMs: 1000, firstTokenLatencyMs: 100,
    finishReason: 'stop', errorCode: null, errorStatus: null, errorMessage: null,
    rawUsage: null, sourceEvent: 'assistant/message', ...over,
  };
}

test('live normalizer ignores orphan llm/retry; history mode records it', () => {
  const live = new SessionNormalizer('s1', {}, { orphanRetry: 'ignore' });
  const event = { type: 'llm/retry', seq: 11, time: 1794000001000, data: { turn: 1, step: 1, provider: 'glm', failure: { code: 'SERVER' } } };
  assert.equal(live.process(event), null, 'live tracker drops the orphan retry');
  const history = new SessionNormalizer('s1', {});
  assert.notEqual(history.process(event), null, 'history replay keeps the hard-loss row');
});

test('startup-boundary duplicate heals when the real attempt lands', () => {
  const db = new UsageDatabase(':memory:');
  // The stale fallback row a previous live session wrote (s:11, own seq).
  db.upsertRecord(record({
    requestId: 's1:11', seq: 11, sourceEvent: 'llm/retry',
    inputTokens: null, outputTokens: null, totalTokens: null,
    finishReason: 'error', errorCode: 'SERVER',
  }));
  // History import converges on the real attempt (s:10) with the retry merged.
  const outcome = db.upsertRecord(record({ requestId: 's1:10', seq: 10, errorCode: 'SERVER' }));
  assert.equal(outcome, 'inserted');
  const rows = db.db.prepare('SELECT request_id FROM usage_records ORDER BY seq').all();
  assert.deepEqual(rows.map((r) => r.request_id), ['s1:10'], 'fallback row purged, single record remains');
  db.close();
});

test('metadata-only corrections are not swallowed by the idempotence check', () => {
  const db = new UsageDatabase(':memory:');
  db.upsertRecord(record({ isSeed: 0, cwd: null }));
  const outcome = db.upsertRecord(record({ isSeed: 1, cwd: 'C:\\ws' }));
  assert.equal(outcome, 'updated');
  const row = db.db.prepare('SELECT is_seed, cwd, source_event FROM usage_records WHERE request_id = ?').get('s1:10');
  assert.equal(row.is_seed, 1);
  assert.equal(row.cwd, 'C:\\ws');
  // sourceEvent-only change also counts now
  assert.equal(db.upsertRecord(record({ isSeed: 1, cwd: 'C:\\ws', sourceEvent: 'assistant/message' })), 'unchanged');
  assert.equal(db.upsertRecord(record({ isSeed: 1, cwd: 'C:\\ws', sourceEvent: 'assistant/attempt' })), 'updated');
  db.close();
});

test('context observations follow ledger amendments (derived cache converges)', () => {
  const db = new UsageDatabase(':memory:');
  db.upsertContextSample({ sessionId: 's1', seq: 5, timestamp: 1, provider: 'glm', model: 'glm-5.3', contextWindow: 1000 });
  db.upsertRecord(record({ requestId: 's1:10', seq: 10, inputTokens: 100, cacheReadTokens: 0 }));
  let rows = db.contextObservations('s1');
  assert.equal(rows.length, 1);
  assert.equal(rows[0].inputTokens, 100);
  assert.equal(rows[0].contextWindow, 1000);
  // Amend the same record: the derived observation must converge.
  db.upsertRecord(record({ requestId: 's1:10', seq: 10, inputTokens: 200, cacheReadTokens: 0 }));
  rows = db.contextObservations('s1');
  assert.equal(rows[0].inputTokens, 200, 'amendment propagates into the observation');
  // A later record adds its OWN observation; attribution never overlaps.
  db.upsertRecord(record({ requestId: 's1:20', seq: 20, inputTokens: 900, cacheReadTokens: 0 }));
  rows = db.contextObservations('s1');
  assert.equal(rows.length, 2);
  assert.deepEqual(rows.map((r) => r.inputTokens), [200, 900]);
  db.close();
});

test('session export is not capped at the 200-row page ceiling', () => {
  const db = new UsageDatabase(':memory:');
  for (let i = 0; i < 205; i += 1) {
    db.upsertSession({ sessionId: `s${i}`, createdAt: 1, cwd: null, parentSessionId: null, origin: null, seedLength: null, lastSeq: null, title: null, updatedAt: 1 });
  }
  assert.equal(db.exportSessions().length, 205);
  assert.equal(db.sessionSummaries({ limit: 1000 }).items.length, 200, 'paged surface still capped');
  db.close();
});

test('summary applies filters consistently across totals, byKind, and costs', () => {
  const db = new UsageDatabase(':memory:');
  db.syncPriceLists([{ currency: 'USD', effectiveFrom: '2026-01-01', models: [{ model: 'glm-5.3', provider: 'glm', input: 1, output: 2 }] }]);
  db.upsertRecord(record({ requestId: 'a:1', sessionId: 'a', kind: 'chat', timestamp: 1794000000000 }));
  db.upsertRecord(record({ requestId: 'b:1', sessionId: 'b', kind: 'compaction', provider: 'deepseek-account', model: 'deepseek-flash', timestamp: 1794000000500 }));
  const q = new QueryService(db);
  const filtered = q.summary({ sessionId: 'a' });
  assert.equal(filtered.totals.requests, 1);
  assert.deepEqual(filtered.byKind.map((k) => k.kind), ['chat'], 'byKind respects the filter');
  const filteredCosts = filtered.costs;
  assert.ok(Array.isArray(filteredCosts) && filteredCosts.length === 1, 'costs present');
  const past = q.summary({ sessionId: 'a', from: 1000, to: 2000 });
  assert.equal(past.today.requests, 0, 'today intersects the requested window');
  const global = q.summary({});
  assert.equal(global.totals.requests, 2);
  assert.equal(global.byKind.length, 2, 'unfiltered summary keeps both kinds');
  db.close();
});

test('OpenRouter match accepts a ledger model that IS the full id', () => {
  const fixture = [{ id: 'anthropic/claude-sonnet-4', name: 'Claude Sonnet 4', pricing: { prompt: '0.000003' } }];
  const hit = matchOpenRouter({ provider: 'openrouter', model: 'anthropic/claude-sonnet-4' }, fixture);
  assert.equal(hit?.model.id, 'anthropic/claude-sonnet-4');
  assert.equal(hit?.quality, 'exact');
});
