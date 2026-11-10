/**
 * Tests for the estimated-cost engine: price list normalization and
 * resolution, the cost_entries derived cache (sync idempotence, effectiveFrom
 * semantics, missing-price flags, micro-unit math), CSV export escaping, and
 * the ledger-vs-session-log reconciler.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { UsageDatabase } from '../lib/storage/database.js';
import {
  MISSING_CACHE_READ, MISSING_INPUT,
  categoryMicro, normalizeEffectiveFrom, normalizePriceList, resolvePrice,
} from '../lib/domain/pricing.js';
import { toCsv } from '../lib/domain/csv.js';
import { reconcileAgainstLogs } from '../lib/collector/reconciler.js';

function localTs(year, month, day, hour = 12) {
  return new Date(year, month - 1, day, hour, 0, 0, 0).getTime();
}

function record(overrides = {}) {
  return {
    requestId: 's:1', sessionId: 's', seq: 1, turn: 1, step: 1,
    parentSessionId: null, origin: null, isSeed: 0, cwd: null,
    provider: 'p1', model: 'm1', kind: 'chat',
    timestamp: localTs(2026, 11, 10),
    inputTokens: 1_000_000, outputTokens: 500_000,
    cacheReadTokens: 2_000_000, cacheWriteTokens: null,
    reasoningTokens: null, totalTokens: 3_500_000,
    durationMs: null, firstTokenLatencyMs: null,
    finishReason: null, errorCode: null, errorStatus: null, errorMessage: null,
    rawUsage: null, sourceEvent: 'assistant/message',
    ...overrides,
  };
}

test('normalizePriceList accepts a valid list and rejects malformed ones', () => {
  const good = normalizePriceList({
    currency: 'usd', effectiveFrom: '2026-11-01',
    models: [{ model: 'm1', input: 1, output: 2 }, { provider: 'p2', model: '*', cacheRead: 0.1 }],
  });
  assert.notEqual(good, null);
  assert.equal(good.currency, 'USD');
  assert.equal(good.effectiveFrom, localTs(2026, 11, 1, 0));
  assert.equal(good.models.length, 2);
  // Same content → same hash (idempotent sync key).
  assert.equal(good.hash, normalizePriceList({
    currency: 'USD', effectiveFrom: localTs(2026, 11, 1, 0),
    models: [{ model: 'm1', input: 1, output: 2 }, { provider: 'p2', model: '*', cacheRead: 0.1 }],
  }).hash);

  assert.equal(normalizePriceList({ currency: 'DOLLAR', effectiveFrom: '2026-11-01', models: [{ model: 'm' }] }), null);
  assert.equal(normalizePriceList({ currency: 'USD', effectiveFrom: '2026-13-01', models: [{ model: 'm' }] }), null);
  assert.equal(normalizePriceList({ currency: 'USD', effectiveFrom: '2026-11-01', models: [] }), null);
  assert.equal(normalizePriceList({ currency: 'USD', effectiveFrom: '2026-11-01', models: [{ model: 'm' }] }), null, 'entry without any price');
  assert.equal(normalizePriceList({ currency: 'USD', effectiveFrom: '2026-11-01', models: [{ model: 'm', input: -1 }] }), null, 'negative price');
  assert.equal(normalizeEffectiveFrom('2026-11-01T00:00:00Z'), null, 'only the plain date form is accepted');
});

test('resolvePrice: newest in-effect list wins, specificity orders entries', () => {
  const early = { effectiveFrom: 100, currency: 'USD', models: [{ model: 'm1', input: 1 }] };
  const late = { effectiveFrom: 200, currency: 'USD', models: [
    { model: 'm1', input: 9 },
    { provider: 'p1', model: 'm2', input: 8 },
    { model: 'm2', input: 7 },
    { provider: 'p1', model: '*', input: 6 },
  ] };
  assert.equal(resolvePrice([early, late], 150, 'p1', 'm1').list, early, 'before the late list');
  assert.equal(resolvePrice([early, late], 50, 'p1', 'm1'), null, 'before any list');
  assert.equal(resolvePrice([early, late], 200, null, 'm1').entry.input, 9, 'exact model beats wildcard');
  assert.equal(resolvePrice([early, late], 200, 'p1', 'm2').entry.input, 8, 'exact provider+model wins');
  assert.equal(resolvePrice([early, late], 200, null, 'm2').entry.input, 7, 'wildcard provider + exact model');
  assert.equal(resolvePrice([early, late], 200, 'p1', 'm9').entry.input, 6, 'provider wildcard model');
  assert.equal(resolvePrice([early, late], 200, 'p2', 'm9'), null, 'no match');
});

test('categoryMicro rounds tokens × per-million price into exact micro units', () => {
  assert.equal(categoryMicro(1_000_000, 0.27), 270_000);
  assert.equal(categoryMicro(877, 0.27), Math.round(877 * 0.27));
  assert.equal(categoryMicro(null, 0.27), 0);
  assert.equal(categoryMicro(500, undefined), 0);
});

test('cost engine: sync is idempotent, effectiveFrom splits pricing, missing flagged', () => {
  const db = new UsageDatabase(':memory:');
  try {
    const config = [{
      name: 'nov', currency: 'USD', effectiveFrom: '2026-11-01',
      models: [{ provider: 'p1', model: 'm1', input: 0.5, output: 1.5, cacheRead: 0.05 }],
    }];
    assert.deepEqual(db.syncPriceLists(config), { synced: 1, skipped: 0 });
    assert.deepEqual(db.syncPriceLists(config), { synced: 0, skipped: 0 }, 'hash dedupe');
    assert.equal(db.listPriceLists().length, 1);

    // One record before the list, two after; second list re-prices later rows.
    db.upsertRecord(record({ requestId: 's:0', timestamp: localTs(2026, 10, 30) }));
    db.upsertRecord(record({ requestId: 's:1' }));
    db.upsertRecord(record({
      requestId: 's:2', timestamp: localTs(2026, 11, 20),
      cacheWriteTokens: 1_000_000, totalTokens: 4_500_000,
    }));
    db.rebuildCosts();
    let rows = db.db
      .prepare('SELECT request_id, currency, total_micro, missing_mask FROM cost_entries ORDER BY request_id')
      .all();
    assert.equal(rows.length, 2, 'record before the first list stays unpriced');
    // s:1 = 1M*0.5 + 0.5M*1.5 + 2M*0.05 = 500000+750000+100000 micro
    assert.equal(rows.find((r) => r.request_id === 's:1').total_micro, 1_350_000);
    // s:2 adds cacheWrite tokens with no price → flagged, not guessed.
    const s2 = rows.find((r) => r.request_id === 's:2');
    assert.equal(s2.total_micro, 1_350_000);
    assert.equal(s2.missing_mask, 8);

    // A later, cheaper list reprices only later timestamps after rebuild.
    db.syncPriceLists([{
      name: 'dec', currency: 'USD', effectiveFrom: '2026-11-15',
      models: [{ provider: 'p1', model: 'm1', input: 0.1, output: 0.2, cacheRead: 0.01 }],
    }]);
    assert.equal(db.costsDirty(), true, 'price change marks costs dirty');
    db.ensureCostsFresh(0);
    rows = db.db
      .prepare('SELECT request_id, total_micro FROM cost_entries ORDER BY request_id')
      .all();
    assert.equal(rows.find((r) => r.request_id === 's:1').total_micro, 1_350_000, 'old window keeps its list');
    // s:2 = 1M*0.1 + 0.5M*0.2 + 2M*0.01 + (cacheWrite unpriced) = 100000+100000+20000
    assert.equal(rows.find((r) => r.request_id === 's:2').total_micro, 220_000);

    const aggregates = db.costAggregates();
    assert.equal(aggregates.coverage.totalRequests, 3);
    assert.equal(aggregates.coverage.pricedRequests, 2);
    assert.equal(aggregates.byCurrency.length, 1);
    assert.equal(aggregates.byCurrency[0].totalMicro, 1_570_000);
    assert.equal(aggregates.byModel[0].key, 'p1/m1');
    assert.ok(aggregates.byDay.length >= 2, 'per-day buckets exist');
  } finally {
    db.close();
  }
});

test('toCsv escapes quotes, commas, and line breaks; CRLF rows', () => {
  const csv = toCsv(
    ['a', 'b'],
    [['x,y', 'plain'], ['say "hi"', 'line\r\nbreak'], [null, 5]],
  );
  assert.equal(csv, 'a,b\r\n"x,y",plain\r\n"say ""hi""","line\r\nbreak"\r\n,5');
});

test('reconciler reports zero diffs on matching logs, diffs on tampering', async () => {
  const db = new UsageDatabase(':memory:');
  try {
    const events = [
      { type: 'assistant/message', seq: 1, data: { usage: { inputTokens: 100, outputTokens: 50, cacheReadTokens: 300, cacheWriteTokens: 0, totalTokens: 450 } } },
      { type: 'assistant/attempt', seq: 2, data: { stream: [
        { chunk: { type: 'text-delta', text: 'x' } },
        { chunk: { type: 'usage', usage: { inputTokens: 10, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0, totalTokens: 10 } } },
        { chunk: { type: 'finish', reason: { failure: 'x' } } },
      ] } },
    ];
    db.upsertRecord(record({ requestId: 's1:1', sessionId: 's1', seq: 1, timestamp: localTs(2026, 11, 5), inputTokens: 100, outputTokens: 50, cacheReadTokens: 300, cacheWriteTokens: 0, totalTokens: 450 }));
    db.upsertRecord(record({ requestId: 's1:2', sessionId: 's1', seq: 2, timestamp: localTs(2026, 11, 5), inputTokens: 10, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0, totalTokens: 10, kind: 'attempt', errorCode: 'X' }));
    const sessionQuery = {
      listSessions: async () => [{ header: { id: 's1' } }],
      readSession: async () => ({ session: { id: 's1' }, events }),
    };
    const clean = await reconcileAgainstLogs(sessionQuery, db);
    assert.equal(clean.mismatchedSessions, 0);
    assert.deepEqual(clean.diffs, []);

    // Tamper the ledger: drop one record's cacheRead tokens.
    db.db.prepare("UPDATE usage_records SET cache_read_tokens = 0 WHERE request_id = 's1:1'").run();
    const dirty = await reconcileAgainstLogs(sessionQuery, db);
    assert.equal(dirty.mismatchedSessions, 1);
    assert.ok(dirty.diffs.some((d) => d.field === 'cacheReadTokens' && d.expected === 300 && d.ledger === 0));

    // A ledger-only session surfaces as an error entry.
    db.upsertRecord(record({ requestId: 'ghost:1', sessionId: 'ghost', seq: 1 }));
    const ghost = await reconcileAgainstLogs(sessionQuery, db);
    assert.ok(ghost.errors.some((e) => e.sessionId === 'ghost' && /not listed/.test(e.error)));
  } finally {
    db.close();
  }
});
