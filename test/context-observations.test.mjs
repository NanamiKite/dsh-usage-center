import test from 'node:test';
import assert from 'node:assert/strict';
import { UsageDatabase } from '../lib/storage/database.js';

function record(over = {}) {
  return {
    requestId: 's1:10', sessionId: 's1', seq: 10, turn: 1, step: 1,
    parentSessionId: null, origin: null, isSeed: 0, cwd: null,
    provider: 'glm', model: 'glm-5.3', kind: 'chat', timestamp: 1794000000000,
    inputTokens: 1000, outputTokens: 50, cacheReadTokens: 9000, cacheWriteTokens: 0,
    reasoningTokens: null, totalTokens: 10050, durationMs: 1000, firstTokenLatencyMs: 100,
    finishReason: 'stop', errorCode: null, errorStatus: null, errorMessage: null,
    rawUsage: null, sourceEvent: 'assistant/message', ...over,
  };
}

function decl(seq, window, session = 's1') {
  return { sessionId: session, seq, timestamp: seq, provider: 'glm', model: 'glm-5.3', contextWindow: window };
}

test('every request with input usage becomes an observation; window carries by order', () => {
  const db = new UsageDatabase(':memory:');
  // One declaration, then many requests: the old sampler produced ONE point
  // for the whole span; the derived observations cover every request.
  db.upsertContextSample(decl(5, 1_000_000));
  for (let i = 0; i < 5; i += 1) {
    db.upsertRecord(record({ requestId: `s1:${10 + i}`, seq: 10 + i, inputTokens: 1000 + i * 100, cacheReadTokens: 5000 }));
  }
  const rows = db.contextObservations('s1');
  assert.equal(rows.length, 5, 'one observation per request with usage');
  assert.deepEqual(rows.map((r) => r.seq), [10, 11, 12, 13, 14]);
  for (const row of rows) {
    assert.equal(row.contextWindow, 1_000_000, 'declaration carried forward');
    assert.equal(row.kind, 'chat');
  }
  db.close();
});

test('requests before the first declaration keep window unknown (no backfill)', () => {
  const db = new UsageDatabase(':memory:');
  db.upsertRecord(record({ requestId: 's1:2', seq: 2 }));
  db.upsertRecord(record({ requestId: 's1:9', seq: 9 }));
  db.upsertContextSample(decl(5, 500_000));
  const rows = db.contextObservations('s1');
  assert.equal(rows.length, 2);
  assert.equal(rows[0].contextWindow, null, 'seq 2 predates the declaration');
  assert.equal(rows[1].contextWindow, 500_000, 'seq 9 follows it');
  db.close();
});

test('window changes apply from the new declaration onward', () => {
  const db = new UsageDatabase(':memory:');
  db.upsertContextSample(decl(1, 100_000));
  db.upsertRecord(record({ requestId: 's1:2', seq: 2 }));
  db.upsertContextSample(decl(5, 200_000));
  db.upsertRecord(record({ requestId: 's1:6', seq: 6 }));
  const rows = db.contextObservations('s1');
  assert.equal(rows[0].contextWindow, 100_000);
  assert.equal(rows[1].contextWindow, 200_000);
  db.close();
});

test('missing usage categories are marked, unknown never becomes zero', () => {
  const db = new UsageDatabase(':memory:');
  db.upsertContextSample(decl(1, 100_000));
  // input NULL, cacheRead present → sum keeps present parts, mask marks input.
  db.upsertRecord(record({ requestId: 's1:2', seq: 2, inputTokens: null, cacheReadTokens: 7000, cacheWriteTokens: null }));
  const [row] = db.contextObservations('s1');
  assert.equal(row.inputTokens, 7000);
  assert.equal(row.missingMask, 1 | 4, 'input and cacheWrite missing');
  // A chat record with no input-side usage at all is NOT an observation.
  db.upsertRecord(record({ requestId: 's1:3', seq: 3, inputTokens: null, cacheReadTokens: null, cacheWriteTokens: null }));
  assert.equal(db.contextObservations('s1').length, 1);
  db.close();
});

test('attempts and compactions are marked; compaction stays visible without usage', () => {
  const db = new UsageDatabase(':memory:');
  db.upsertContextSample(decl(1, 100_000));
  db.upsertRecord(record({ requestId: 's1:2', seq: 2, kind: 'attempt', sourceEvent: 'assistant/attempt', finishReason: 'error', inputTokens: 300, cacheReadTokens: null, cacheWriteTokens: null }));
  db.upsertRecord(record({ requestId: 's1:3', seq: 3, kind: 'compaction', sourceEvent: 'compaction/summary', inputTokens: null, cacheReadTokens: null, cacheWriteTokens: null, outputTokens: 100 }));
  const rows = db.contextObservations('s1');
  assert.deepEqual(rows.map((r) => r.kind), ['attempt', 'compaction']);
  assert.equal(rows[1].inputTokens, null, 'compaction marker without usage');
  db.close();
});

test('usage amendments propagate: rebuild converges to the corrected input', () => {
  const db = new UsageDatabase(':memory:');
  db.upsertContextSample(decl(1, 100_000));
  db.upsertRecord(record({ requestId: 's1:2', seq: 2, inputTokens: 100, cacheReadTokens: 0 }));
  assert.equal(db.contextObservations('s1')[0].inputTokens, 100);
  db.upsertRecord(record({ requestId: 's1:2', seq: 2, inputTokens: 200, cacheReadTokens: 0 }));
  assert.equal(db.contextObservations('s1')[0].inputTokens, 200, 'amended usage reflected after rebuild');
  // Idempotent double rebuild.
  db.rebuildContextObservations();
  db.rebuildContextObservations();
  assert.equal(db.contextObservations('s1').length, 1);
  db.close();
});

test('overview aggregates: last/prev/delta/max/counts/model-switch per session', () => {
  const db = new UsageDatabase(':memory:');
  db.upsertSession({ sessionId: 's1', createdAt: 1, cwd: null, parentSessionId: null, origin: null, seedLength: null, lastSeq: null, title: null, updatedAt: 1 });
  db.upsertContextSample(decl(1, 1000));
  db.upsertRecord(record({ requestId: 's1:2', seq: 2, inputTokens: 100, cacheReadTokens: 0, timestamp: 1000 }));
  db.upsertRecord(record({ requestId: 's1:3', seq: 3, inputTokens: 300, cacheReadTokens: 0, timestamp: 2000, model: 'glm-5.3-flash' }));
  db.upsertRecord(record({ requestId: 's1:4', seq: 4, kind: 'compaction', sourceEvent: 'compaction/summary', inputTokens: null, cacheReadTokens: null, cacheWriteTokens: null, outputTokens: 10, timestamp: 3000 }));
  const overview = db.contextOverview();
  assert.equal(overview.length, 1);
  const s = overview[0];
  assert.equal(s.lastInput, 300);
  assert.equal(s.prevInput, 100);
  assert.equal(s.delta, 200);
  assert.equal(s.modelSwitched, true, 'glm-5.3 → glm-5.3-flash');
  assert.equal(s.maxInput, 300);
  assert.equal(s.observedRequests, 2, 'chat observations only');
  assert.equal(s.totalRequests, 3);
  assert.equal(s.compactions, 1);
  assert.equal(s.contextWindow, 1000);
  assert.equal(s.lastObsAt, 3000);
  db.close();
});

test('sessions without observable usage are listed with hints, not dropped', () => {
  const db = new UsageDatabase(':memory:');
  db.upsertSession({ sessionId: 's2', createdAt: 1, cwd: null, parentSessionId: null, origin: null, seedLength: null, lastSeq: null, title: null, updatedAt: 1 });
  db.upsertRecord(record({ requestId: 's2:2', sessionId: 's2', seq: 2, inputTokens: null, cacheReadTokens: null, cacheWriteTokens: null }));
  const overview = db.contextOverview();
  const s2 = overview.find((row) => row.sessionId === 's2');
  assert.ok(s2 !== undefined, 'session listed even without observations');
  assert.equal(s2.lastInput, null);
  assert.equal(s2.observedRequests, 0);
  assert.equal(s2.totalRequests, 1);
  db.close();
});

test('declaration corrections mark the cache dirty and converge', () => {
  const db = new UsageDatabase(':memory:');
  db.upsertContextSample(decl(1, 1000));
  db.upsertRecord(record({ requestId: 's1:2', seq: 2 }));
  assert.equal(db.contextObservations('s1')[0].contextWindow, 1000);
  db.upsertContextSample(decl(1, 2000)); // corrected declaration, same seq
  assert.equal(db.contextObservations('s1')[0].contextWindow, 2000, 'window correction propagates');
  db.close();
});

test('live and replay paths produce identical observations (both are just records)', () => {
  const db = new UsageDatabase(':memory:');
  db.upsertContextSample(decl(1, 1000));
  db.upsertRecord(record({ requestId: 's1:2', seq: 2, inputTokens: 100, cacheReadTokens: 0 }));
  const first = db.deriveObservationRows();
  // "Replay": write the same record again (idempotent upsert) and rebuild.
  db.upsertRecord(record({ requestId: 's1:2', seq: 2, inputTokens: 100, cacheReadTokens: 0 }));
  db.rebuildContextObservations();
  const second = db.deriveObservationRows();
  assert.deepEqual(first, second);
  db.close();
});
