import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { UsageDatabase, APPLICATION_ID, SCHEMA_VERSION } from '../lib/storage/database.js';

function sampleRecord(overrides = {}) {
  return {
    requestId: 'session-1:19',
    sessionId: 'session-1',
    seq: 19,
    turn: 1,
    step: 1,
    parentSessionId: null,
    origin: null,
    isSeed: 0,
    cwd: 'C:\\ws',
    provider: 'deepseek-account',
    model: 'deepseek-flash',
    kind: 'chat',
    timestamp: 1794121336596,
    inputTokens: 877,
    outputTokens: 192,
    cacheReadTokens: 8960,
    cacheWriteTokens: 0,
    reasoningTokens: null,
    totalTokens: 10029,
    durationMs: 1500,
    firstTokenLatencyMs: 100,
    finishReason: null,
    errorCode: null,
    errorStatus: null,
    errorMessage: null,
    rawUsage: '{"inputTokens":877}',
    sourceEvent: 'assistant/message',
    ...overrides,
  };
}

test('migrations set application_id and user_version', () => {
  const db = new UsageDatabase(':memory:');
  try {
    const app = db.db.prepare('PRAGMA application_id').get();
    const ver = db.db.prepare('PRAGMA user_version').get();
    assert.equal(app.application_id, APPLICATION_ID);
    assert.equal(ver.user_version, SCHEMA_VERSION);
    assert.equal(db.getMeta('schema_version'), String(SCHEMA_VERSION));
  } finally {
    db.close();
  }
});

test('upsert is idempotent: insert 鈫?unchanged 鈫?update on changed facts', () => {
  const db = new UsageDatabase(':memory:');
  try {
    assert.equal(db.upsertRecord(sampleRecord()), 'inserted');
    assert.equal(db.upsertRecord(sampleRecord()), 'unchanged');
    assert.equal(db.upsertRecord(sampleRecord({ outputTokens: 200, totalTokens: 10037 })), 'updated');

    const { items } = db.listRecords({ sessionId: 'session-1' });
    assert.equal(items.length, 1);
    assert.equal(items[0].outputTokens, 200);
  } finally {
    db.close();
  }
});

test('session watermark only advances', () => {
  const db = new UsageDatabase(':memory:');
  try {
    const row = (seq) => ({
      sessionId: 'session-1',
      createdAt: 1,
      cwd: null,
      parentSessionId: null,
      origin: null,
      seedLength: null,
      lastSeq: seq,
      updatedAt: Date.now(),
    });
    db.upsertSession(row(10));
    db.upsertSession(row(5));
    assert.equal(db.getSession('session-1').lastSeq, 10);
    db.upsertSession({ ...row(null), cwd: 'C:\\ws2' });
    const after = db.getSession('session-1');
    assert.equal(after.lastSeq, 10);
    assert.equal(after.cwd, 'C:\\ws2');
  } finally {
    db.close();
  }
});

test('totals, filters and cache hit rate', () => {
  const db = new UsageDatabase(':memory:');
  try {
    db.upsertRecord(sampleRecord());
    db.upsertRecord(
      sampleRecord({
        requestId: 'session-1:20', seq: 20, timestamp: 1794121400000,
        provider: 'glm', model: 'glm-5.3',
        inputTokens: 100, outputTokens: 50, cacheReadTokens: 0, cacheWriteTokens: 0, totalTokens: 150,
        durationMs: null, firstTokenLatencyMs: null, rawUsage: null,
      }),
    );
    db.upsertRecord(
      sampleRecord({
        requestId: 'session-2:1', seq: 1, sessionId: 'session-2', timestamp: 1794121500000,
        isSeed: 1, inputTokens: 0, outputTokens: 10, cacheReadTokens: 0, cacheWriteTokens: 0, totalTokens: 10,
        rawUsage: null,
      }),
    );

    const all = db.totals();
    assert.equal(all.requests, 3);
    assert.equal(all.inputTokens, 977);
    assert.equal(all.totalTokens, 10189);
    assert.equal(all.durationMsCount, 2);
    assert.equal(all.firstTokenMsCount, 2);
    // cacheRead / (input + cacheRead + cacheWrite) = 8960 / (977 + 8960 + 0)
    assert.ok(Math.abs(all.cacheHitRate - 8960 / 9937) < 1e-9);

    const noSeed = db.totals({ includeSeed: false });
    assert.equal(noSeed.requests, 2);

    const byModel = db.byModel();
    assert.equal(byModel.length, 2);
    assert.equal(byModel[0].provider, 'deepseek-account');

    const glmOnly = db.listRecords({ provider: 'glm' });
    assert.equal(glmOnly.total, 1);
    assert.equal(glmOnly.items[0].model, 'glm-5.3');

    const ranged = db.listRecords({ from: 1794121399999, to: 1794121499999 });
    assert.equal(ranged.total, 1);
    assert.equal(ranged.items[0].requestId, 'session-1:20');
  } finally {
    db.close();
  }
});

test('foreign application_id is refused', () => {
  const dir = mkdtempSync(join(tmpdir(), 'usage-center-test-'));
  const path = join(dir, 'foreign.db');
  try {
    const raw = new DatabaseSync(path);
    raw.exec('CREATE TABLE t (x);');
    raw.exec('PRAGMA application_id = 12345;');
    raw.close();
    assert.throws(() => new UsageDatabase(path), /another application/);
  } finally {
    try { rmSync(dir, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 }); } catch { /* best-effort temp cleanup */ }
  }
});

test('newer schema version is refused', () => {
  const dir = mkdtempSync(join(tmpdir(), 'usage-center-test-'));
  const path = join(dir, 'future.db');
  try {
    const raw = new DatabaseSync(path);
    raw.exec('CREATE TABLE t (x);');
    raw.exec(`PRAGMA application_id = ${APPLICATION_ID};`);
    raw.exec('PRAGMA user_version = 999;');
    raw.close();
    assert.throws(() => new UsageDatabase(path), /newer than this code/);
  } finally {
    try { rmSync(dir, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 }); } catch { /* best-effort temp cleanup */ }
  }
});
