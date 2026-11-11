import test from 'node:test';
import assert from 'node:assert/strict';
import { UsageDatabase } from '../lib/storage/database.js';
import { QueryService } from '../lib/query/query-service.js';

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

test('observation rows carry per-request detail and cost estimate via 1:1 joins', () => {
  const db = new UsageDatabase(':memory:');
  db.upsertContextSample(decl(1, 100_000));
  db.upsertRecord(record({
    requestId: 's1:2', seq: 2, inputTokens: 1000, cacheReadTokens: 9000, cacheWriteTokens: 0,
    outputTokens: 500, durationMs: 4200, firstTokenLatencyMs: 900,
  }));
  db.upsertRecord(record({
    requestId: 's1:3', seq: 3, kind: 'attempt', sourceEvent: 'assistant/attempt',
    finishReason: 'error', errorCode: 'SERVER',
    inputTokens: 300, cacheReadTokens: null, cacheWriteTokens: null, outputTokens: null,
  }));
  let rows = db.contextObservations('s1');
  assert.equal(rows.length, 2);
  const [chat, attempt] = rows;
  assert.equal(chat.inputRaw, 1000, 'raw input category joined from the ledger');
  assert.equal(chat.cacheRead, 9000);
  assert.equal(chat.outputTokens, 500);
  assert.equal(chat.durationMs, 4200);
  assert.equal(chat.firstTokenLatencyMs, 900);
  assert.equal(chat.errorCode, null);
  assert.equal(chat.costMicro, null, 'no price list → no estimate, never 0');
  assert.equal(chat.costCurrency, null);
  assert.equal(attempt.errorCode, 'SERVER', 'failed attempt keeps its error code');
  // Syncing a price list surfaces the per-request estimate on the same row.
  db.syncPriceLists([{
    name: 'test', currency: 'USD', effectiveFrom: 0,
    models: [{ provider: 'glm', model: 'glm-5.3', input: 1, output: 2, cacheRead: 0.1, cacheWrite: 0.2 }],
  }]);
  db.rebuildCosts();
  rows = db.contextObservations('s1');
  assert.ok(rows[0].costMicro !== null && rows[0].costMicro > 0, 'priced request carries its estimate');
  assert.equal(rows[0].costCurrency, 'USD');
  db.close();
});

test('consecutive compactions and a trailing compaction all stay as markers', () => {
  const db = new UsageDatabase(':memory:');
  db.upsertSession({ sessionId: 's1', createdAt: 1, cwd: null, parentSessionId: null, origin: null, seedLength: null, lastSeq: null, title: null, updatedAt: 1 });
  db.upsertContextSample(decl(1, 100_000));
  db.upsertRecord(record({ requestId: 's1:2', seq: 2, inputTokens: 500, cacheReadTokens: 0, timestamp: 1000 }));
  db.upsertRecord(record({ requestId: 's1:3', seq: 3, kind: 'compaction', sourceEvent: 'compaction/summary', inputTokens: null, cacheReadTokens: null, cacheWriteTokens: null, outputTokens: 100, durationMs: 8000, timestamp: 2000 }));
  db.upsertRecord(record({ requestId: 's1:4', seq: 4, kind: 'compaction', sourceEvent: 'compaction/summary', inputTokens: null, cacheReadTokens: null, cacheWriteTokens: null, outputTokens: 50, durationMs: 6000, timestamp: 3000 }));
  db.upsertRecord(record({ requestId: 's1:5', seq: 5, inputTokens: 60, cacheReadTokens: 0, timestamp: 4000 }));
  db.upsertRecord(record({ requestId: 's1:6', seq: 6, kind: 'compaction', sourceEvent: 'compaction/summary', inputTokens: null, cacheReadTokens: null, cacheWriteTokens: null, outputTokens: 30, timestamp: 5000 }));
  const rows = db.contextObservations('s1');
  assert.deepEqual(rows.map((r) => r.kind), ['chat', 'compaction', 'compaction', 'chat', 'compaction']);
  assert.deepEqual(rows.map((r) => r.seq), [2, 3, 4, 5, 6], 'order preserved');
  assert.equal(rows[1].durationMs, 8000);
  assert.equal(rows[4].inputTokens, null, 'trailing compaction keeps null input');
  const [s] = db.contextOverview();
  assert.equal(s.compactions, 3);
  assert.equal(s.totalRequests, 5);
  db.close();
});

test('mid-session model switch is visible in the observation series itself', () => {
  const db = new UsageDatabase(':memory:');
  db.upsertContextSample(decl(1, 100_000));
  db.upsertRecord(record({ requestId: 's1:2', seq: 2, inputTokens: 100, cacheReadTokens: 0, model: 'glm-5.3' }));
  db.upsertRecord(record({ requestId: 's1:3', seq: 3, inputTokens: 200, cacheReadTokens: 0, model: 'glm-5.3-flash' }));
  const rows = db.contextObservations('s1');
  assert.equal(rows[0].model, 'glm-5.3');
  assert.equal(rows[1].model, 'glm-5.3-flash', 'series carries the switch point');
  db.close();
});

test('context detail joins fresh costs without a manual rebuild (read-after-write)', () => {
  const db = new UsageDatabase(':memory:');
  db.syncPriceLists([{
    name: 't', currency: 'USD', effectiveFrom: 0,
    models: [{ provider: 'glm', model: 'glm-5.3', input: 1, output: 0, cacheRead: 0, cacheWrite: 0 }],
  }]);
  db.upsertContextSample(decl(1, 100_000));
  db.upsertRecord(record({ requestId: 's1:2', seq: 2, inputTokens: 1_000_000, cacheReadTokens: 0, outputTokens: 0 }));
  const [row] = db.contextObservations('s1');
  assert.ok(row.costMicro !== null && row.costMicro > 0, 'estimate present on the first read after the write');
  assert.equal(row.costMicro, 1_000_000);
  db.upsertRecord(record({ requestId: 's1:2', seq: 2, inputTokens: 2_000_000, cacheReadTokens: 0, outputTokens: 0 }));
  const [amended] = db.contextObservations('s1');
  assert.equal(amended.inputTokens, 2_000_000);
  assert.equal(amended.costMicro, 2_000_000, 'amended usage updates the estimate on the same read path');
  db.close();
});

test('context detail carries the session record total (usage-less records included)', () => {
  const db = new UsageDatabase(':memory:');
  db.upsertContextSample(decl(1, 100_000));
  db.upsertRecord(record({ requestId: 's1:2', seq: 2, inputTokens: 100, cacheReadTokens: 0 }));
  db.upsertRecord(record({ requestId: 's1:3', seq: 3, inputTokens: null, cacheReadTokens: null, cacheWriteTokens: null }));
  const view = new QueryService(db).context('s1');
  assert.equal(view.totalRequests, 2, 'both ledger records counted — the panel cannot derive this alone');
  assert.equal(view.observations.length, 1, 'only the usage-bearing record is an observation');
  db.close();
});

test('a later declaration without a window ends the carry-over', () => {
  const db = new UsageDatabase(':memory:');
  db.upsertSession({ sessionId: 's1', createdAt: 1, cwd: null, parentSessionId: null, origin: null, seedLength: null, lastSeq: null, title: null, updatedAt: 1 });
  db.upsertContextSample(decl(1, 100_000));
  db.upsertRecord(record({ requestId: 's1:2', seq: 2, inputTokens: 100, cacheReadTokens: 0, timestamp: 1000 }));
  // Model switch: the new declaration carries provider/model but no window.
  db.upsertContextSample(decl(5, null));
  db.upsertRecord(record({ requestId: 's1:6', seq: 6, inputTokens: 200, cacheReadTokens: 0, model: 'glm-5.3-flash', timestamp: 2000 }));
  const rows = db.contextObservations('s1');
  assert.equal(rows.length, 2);
  assert.equal(rows[0].contextWindow, 100_000);
  assert.equal(rows[1].contextWindow, null, 'latest declaration has no window → unknown, not the old model\'s value');
  const [s] = db.contextOverview();
  assert.equal(s.contextWindow, null, 'overview follows the latest observation, including null');
  db.close();
});

test('long session: 5k requests derive and query without pathological cost', () => {
  const db = new UsageDatabase(':memory:');
  db.upsertContextSample({ sessionId: 'big', seq: 1, timestamp: 1, provider: 'glm', model: 'glm-5.3', contextWindow: 200_000 });
  db.upsertSession({ sessionId: 'big', createdAt: 1, cwd: null, parentSessionId: null, origin: null, seedLength: null, lastSeq: null, title: null, updatedAt: 1 });
  const t0 = Date.now();
  for (let i = 0; i < 5000; i += 1) {
    db.upsertRecord(record({
      requestId: `big:${i}`, sessionId: 'big', seq: i + 1,
      inputTokens: 10_000 + i, cacheReadTokens: 0, timestamp: 1794000000000 + i * 1000,
    }));
  }
  const tInsert = Date.now() - t0;
  const t1 = Date.now();
  const count = db.rebuildContextObservations();
  const tRebuild = Date.now() - t1;
  assert.equal(count, 5000, 'every request observed');
  const t2 = Date.now();
  const rows = db.contextObservations('big');
  const tQuery = Date.now() - t2;
  assert.equal(rows.length, 5000);
  assert.equal(rows[4999].inputTokens, 10_000 + 4999);
  assert.equal(rows[4999].outputTokens, 50, 'enrichment join covers the whole series');
  const t3 = Date.now();
  db.contextOverview();
  const tOverview = Date.now() - t3;
  assert.ok(tRebuild < 10_000, `rebuild took ${tRebuild}ms`);
  assert.ok(tQuery < 5_000, `query took ${tQuery}ms`);
  assert.ok(tOverview < 5_000, `overview took ${tOverview}ms`);
  console.log(`context perf (5k requests): insert ${tInsert}ms · rebuild ${tRebuild}ms · query ${tQuery}ms · overview ${tOverview}ms`);
  db.close();
});
