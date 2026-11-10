/**
 * Tests for the materialized daily cache (`daily_stats`), the
 * trend/breakdown/session queries, and the derived-cache lifecycle
 * (dirty → rebuild → clean, amend convergence).
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { UsageDatabase } from '../lib/storage/database.js';

/** Local-time epoch ms (tests must not depend on the runner's TZ database). */
function localTs(year, month, day, hour = 12, minute = 0) {
  return new Date(year, month - 1, day, hour, minute, 0, 0).getTime();
}

function record(overrides = {}) {
  return {
    requestId: 'session-1:1',
    sessionId: 'session-1',
    seq: 1,
    turn: 1,
    step: 1,
    parentSessionId: null,
    origin: null,
    isSeed: 0,
    cwd: 'C:\\ws',
    provider: 'p1',
    model: 'm1',
    kind: 'chat',
    timestamp: localTs(2026, 11, 8),
    inputTokens: 100,
    outputTokens: 50,
    cacheReadTokens: 300,
    cacheWriteTokens: 100,
    reasoningTokens: null,
    totalTokens: 550,
    durationMs: 1000,
    firstTokenLatencyMs: 200,
    finishReason: null,
    errorCode: null,
    errorStatus: null,
    errorMessage: null,
    rawUsage: null,
    sourceEvent: 'assistant/message',
    ...overrides,
  };
}

function sessionRow(sessionId, overrides = {}) {
  return {
    sessionId,
    createdAt: localTs(2026, 11, 7),
    cwd: 'C:\\ws',
    parentSessionId: null,
    origin: null,
    seedLength: null,
    lastSeq: null,
    updatedAt: localTs(2026, 11, 8),
    ...overrides,
  };
}

test('daily_stats lifecycle: clean → dirty on write → clean after rebuild', () => {
  const db = new UsageDatabase(':memory:');
  try {
    assert.equal(db.statsDirty(), false, 'empty ledger is not dirty');
    db.upsertRecord(record());
    assert.equal(db.statsDirty(), true);
    db.rebuildDailyStats();
    assert.equal(db.statsDirty(), false, 'rebuild covers the write');
    // An unchanged replay must not dirty the cache again.
    db.upsertRecord(record());
    assert.equal(db.statsDirty(), false, 'unchanged replay stays clean');
  } finally {
    db.close();
  }
});

test('rebuild buckets by local calendar day across a midnight boundary', () => {
  const db = new UsageDatabase(':memory:');
  try {
    const day1 = localTs(2026, 11, 8, 23, 59);
    const day2 = localTs(2026, 11, 9, 0, 1);
    db.upsertRecord(record({ requestId: 's:1', seq: 1, timestamp: day1 }));
    db.upsertRecord(record({ requestId: 's:2', seq: 2, timestamp: day2 }));
    db.upsertRecord(record({
      requestId: 's:3', seq: 3, timestamp: day2,
      provider: 'p2', model: 'm2', inputTokens: 10, outputTokens: 5,
      cacheReadTokens: 0, cacheWriteTokens: 0, totalTokens: 15,
      errorCode: 'SERVER',
    }));
    db.rebuildDailyStats();
    const rows = db.db
      .prepare('SELECT * FROM daily_stats ORDER BY day, provider')
      .all();
    assert.equal(rows.length, 3, 'two days, three (day × model) buckets');
    const [d8, d9m1, d9m2] = rows;
    assert.equal(d8.day, '2026-11-08');
    assert.equal(d8.provider, 'p1');
    assert.equal(d8.requests, 1);
    assert.equal(d9m1.day, '2026-11-09');
    assert.equal(d9m1.model, 'm1');
    assert.equal(d9m1.total_tokens, 550);
    assert.equal(d9m2.model, 'm2');
    assert.equal(d9m2.error_count, 1);
  } finally {
    db.close();
  }
});

test('amend under the same request id converges after rebuild', () => {
  const db = new UsageDatabase(':memory:');
  try {
    db.upsertRecord(record({ requestId: 's:1', totalTokens: 550 }));
    db.rebuildDailyStats();
    // llm/retry-style amendment: same key, corrected facts.
    db.upsertRecord(record({
      requestId: 's:1',
      outputTokens: 150,
      totalTokens: 650,
      firstTokenLatencyMs: 400,
    }));
    assert.equal(db.statsDirty(), true, 'amend marks the cache dirty');
    db.ensureDailyStatsFresh(0);
    assert.equal(db.statsDirty(), false);
    const row = db.db
      .prepare('SELECT SUM(total_tokens) AS t, SUM(first_token_ms) AS f FROM daily_stats')
      .get();
    assert.equal(row.t, 650, 'cache reflects the amended, not the stale, total');
    assert.equal(row.f, 400);
  } finally {
    db.close();
  }
});

test('trend zero-fills gaps and computes derived rates', () => {
  const db = new UsageDatabase(':memory:');
  try {
    // One record today (relative to the runner's clock) plus an older day.
    const now = new Date();
    const todayTs = new Date(now.getFullYear(), now.getMonth(), now.getDate(), 10).getTime();
    const oldTs = localTs(2026, 1, 2, 9);
    db.upsertRecord(record({ requestId: 's:today', timestamp: todayTs }));
    db.upsertRecord(record({
      requestId: 's:old', timestamp: oldTs,
      inputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0, totalTokens: 5,
      firstTokenLatencyMs: null,
    }));
    const points = db.trend(30);
    assert.equal(points.length, 30, 'range length is honored');
    assert.equal(points.at(-1).day, UsageDatabase.dayOf(Date.now()), 'ends today');
    const today = points.at(-1);
    assert.equal(today.requests, 1);
    assert.equal(today.totalTokens, 550);
    // cacheRead / (input + cacheRead + cacheWrite) = 300 / 500
    assert.ok(Math.abs(today.cacheHitRate - 0.6) < 1e-9);
    assert.equal(today.avgFirstTokenMs, 200);
    const empty = points.find((p) => p.day !== today.day && p.day !== '2026-01-02');
    assert.ok(empty !== undefined, 'gap days are present');
    assert.equal(empty.requests, 0, 'gap days are zero-filled');
    assert.equal(empty.cacheHitRate, null, 'no token data → null, not 0');
    assert.equal(empty.avgFirstTokenMs, null);
    // The old day has no cache-able denominator (all null→0 sums but requests>0):
    const old = points.find((p) => p.day === '2026-01-02');
    if (old !== undefined && old.day <= points.at(-1).day && old.requests > 0) {
      assert.equal(old.cacheHitRate, null);
    }
  } finally {
    db.close();
  }
});

test('breakdown groups by model, provider, and kind', () => {
  const db = new UsageDatabase(':memory:');
  try {
    db.upsertRecord(record({ requestId: 's:1', provider: 'p1', model: 'm1', kind: 'chat' }));
    db.upsertRecord(record({ requestId: 's:2', provider: 'p1', model: 'm1', kind: 'chat' }));
    db.upsertRecord(record({
      requestId: 's:3', provider: 'p1', model: 'm2', kind: 'attempt', errorCode: 'SERVER',
    }));
    const byModel = db.breakdown('model');
    assert.deepEqual(byModel.map((r) => r.key), ['p1/m1', 'p1/m2'], 'sorted by total tokens');
    assert.equal(byModel[0].requests, 2);
    assert.equal(byModel[1].errorCount, 1);
    const byProvider = db.breakdown('provider');
    assert.equal(byProvider.length, 1);
    assert.equal(byProvider[0].requests, 3);
    const byKind = db.breakdown('kind');
    assert.deepEqual(byKind.map((r) => r.key).sort(), ['attempt', 'chat']);
    // Unknown provider/model degrade to '?' without throwing.
    db.upsertRecord(record({ requestId: 's:4', provider: null, model: null }));
    const withUnknown = db.breakdown('model');
    assert.ok(withUnknown.some((r) => r.key === '?/?'));
  } finally {
    db.close();
  }
});

test('sessionSummaries joins ledger totals and paginates', () => {
  const db = new UsageDatabase(':memory:');
  try {
    db.upsertSession(sessionRow('session-1'));
    db.upsertSession(sessionRow('session-2', { origin: 'subagent', parentSessionId: 'session-1' }));
    db.upsertSession(sessionRow('session-empty'));
    db.upsertRecord(record({ requestId: 'session-1:1', sessionId: 'session-1', timestamp: localTs(2026, 11, 8, 10) }));
    db.upsertRecord(record({ requestId: 'session-1:2', sessionId: 'session-1', timestamp: localTs(2026, 11, 8, 11) }));
    db.upsertRecord(record({
      requestId: 'session-2:1', sessionId: 'session-2',
      timestamp: localTs(2026, 11, 9, 9), errorCode: 'SERVER',
    }));
    const page = db.sessionSummaries({ limit: 2, offset: 0 });
    assert.equal(page.total, 3);
    assert.equal(page.items.length, 2);
    // Most recent activity first: session-2 (11-09) → session-1 (11-08) → empty.
    assert.equal(page.items[0].sessionId, 'session-2');
    assert.equal(page.items[0].requests, 1);
    assert.equal(page.items[0].errorCount, 1);
    assert.equal(page.items[0].origin, 'subagent');
    assert.equal(page.items[1].sessionId, 'session-1');
    assert.equal(page.items[1].totalTokens, 1100);
    const rest = db.sessionSummaries({ limit: 2, offset: 2 });
    assert.equal(rest.items[0].sessionId, 'session-empty');
    assert.equal(rest.items[0].requests, 0, 'session with no records reports zero requests');
    assert.equal(rest.items[0].lastTimestamp, null);
  } finally {
    db.close();
  }
});
