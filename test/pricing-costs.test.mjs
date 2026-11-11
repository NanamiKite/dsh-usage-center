/**
 * Tests for the estimated-cost engine: price list normalization and
 * resolution, the cost_entries derived cache (sync idempotence, effectiveFrom
 * semantics, missing-price flags, micro-unit math), CSV export escaping, and
 * the ledger-vs-session-log reconciler.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { UsageDatabase } from '../lib/storage/database.js';
import { QueryService } from '../lib/query/query-service.js';
import {
  MISSING_CACHE_READ, MISSING_INPUT,
  categoryMicro, normalizeEffectiveFrom, normalizePriceList, resolvePrice, windowMultiplier,
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

test('costs view: unpriced history stays explicit — effectiveFrom exposed, nothing guessed', () => {
  const db = new UsageDatabase(':memory:');
  try {
    // One request BEFORE the first list, one AFTER: the earlier one must stay
    // unpriced (no retroactive guessing), and the view must say when pricing
    // starts so the UI can explain "configured but nothing priced yet".
    db.upsertRecord(record({ requestId: 's:1', seq: 1, timestamp: localTs(2026, 11, 1) }));
    db.upsertRecord(record({ requestId: 's:2', seq: 2, timestamp: localTs(2026, 11, 10) }));
    db.syncPriceLists([{
      currency: 'USD', effectiveFrom: '2026-11-10',
      models: [{ provider: 'p1', model: 'm1', input: 1 }],
    }]);
    const view = new QueryService(db).costs({});
    assert.equal(view.configured, true);
    assert.equal(view.effectiveFrom, localTs(2026, 11, 10, 0), 'newest list effective date exposed');
    assert.equal(view.coverage.totalRequests, 2);
    assert.equal(view.coverage.pricedRequests, 1, 'only the request after the effective date is priced');
    assert.equal(view.byModel.length, 1, 'priced models only — the unpriced request is not guessed into a row');
  } finally {
    db.close();
  }
});

test('daily rate windows: normalization rejects malformed, multiplier picks by row time', () => {
  const good = normalizePriceList({
    currency: 'CNY', effectiveFrom: '2026-11-01',
    windows: [
      { from: '00:30', to: '16:00', multiplier: 1 },
      { from: '16:00', to: '00:30', multiplier: 0.5 },
    ],
    models: [{ model: 'm1', input: 1 }],
  });
  assert.notEqual(good, null);
  assert.equal(good.windows.entries.length, 2, 'both windows parsed');
  // The second window wraps midnight: 16:00–00:30 at half price.
  assert.equal(windowMultiplier(good.windows, localTs(2026, 11, 10, 20)), 0.5, 'evening in the wrap window');
  assert.equal(windowMultiplier(good.windows, localTs(2026, 11, 10, 0)), 0.5, '00:00 before the 00:30 end is inside the wrap');
  assert.equal(windowMultiplier(good.windows, localTs(2026, 11, 10, 12)), 1, 'midday at base rate');
  assert.equal(windowMultiplier(undefined, localTs(2026, 11, 10, 12)), 1, 'no windows = base rate');

  const bad = (windows) => normalizePriceList({
    currency: 'CNY', effectiveFrom: '2026-11-01', windows, models: [{ model: 'm1', input: 1 }],
  });
  assert.equal(bad([{ from: '01:00', to: '05:00', multiplier: 0.5 }, { from: '04:00', to: '06:00', multiplier: 0.8 }]), null, 'overlap rejected');
  assert.equal(bad([{ from: '24:00', to: '05:00', multiplier: 0.5 }]), null, 'bad HH:MM rejected');
  assert.equal(bad([{ from: '01:00', to: '02:00', multiplier: 0 }]), null, 'multiplier 0 rejected');
  assert.equal(bad([{ from: '01:00', to: '01:00', multiplier: 0.5 }]), null, 'zero-length window rejected');
});

test('daily rate windows apply per row time in the cost cache', () => {
  const db = new UsageDatabase(':memory:');
  try {
    db.syncPriceLists([{
      currency: 'CNY', effectiveFrom: '2026-11-01',
      windows: [{ from: '16:00', to: '00:30', multiplier: 0.5 }],
      models: [{ provider: 'p1', model: 'm1', input: 1 }],
    }]);
    // 1M input tokens: base rate → 1,000,000 micro; off-peak → half.
    db.upsertRecord(record({ requestId: 's:1', seq: 1, timestamp: localTs(2026, 11, 10, 12) }));
    db.upsertRecord(record({ requestId: 's:2', seq: 2, timestamp: localTs(2026, 11, 10, 20) }));
    const byId = new Map(db.costRows({}).map((r) => [r.request_id, r]));
    assert.equal(byId.get('s:1').total_micro, 1_000_000, 'midday priced at base rate');
    assert.equal(byId.get('s:2').total_micro, 500_000, 'off-peak priced at half');
  } finally {
    db.close();
  }
});

test('retroactive mode: pre-history priced at the first list when opted in, and flagged', () => {
  const db = new UsageDatabase(':memory:');
  try {
    db.upsertRecord(record({ requestId: 's:0', seq: 0, timestamp: localTs(2026, 10, 20, 12) }));
    db.upsertRecord(record({ requestId: 's:1', seq: 1, timestamp: localTs(2026, 11, 10, 12) }));
    db.syncPriceLists([{
      currency: 'USD', effectiveFrom: '2026-11-01',
      models: [{ provider: 'p1', model: 'm1', input: 1 }],
    }]);
    let agg = db.costAggregates();
    assert.equal(agg.coverage.pricedRequests, 1);
    assert.equal(agg.coverage.retroPriced, 0, 'default: pre-history stays unpriced');

    db.setRetroactivePricing(true);
    assert.ok(db.costsDirty(), 'toggling the mode marks the cache dirty');
    agg = db.costAggregates(); // read path rebuilds (pending-flag bypass)
    assert.equal(agg.coverage.pricedRequests, 2, 'retro row priced');
    assert.equal(agg.coverage.retroPriced, 1, 'and counted as retro');
    const retroRow = db.costRows({}).find((r) => r.request_id === 's:0');
    assert.equal(retroRow.total_micro, 1_000_000, 'priced at the first list rate');
    assert.equal(Number(retroRow.missing_mask) & 16, 16, 'MISSING_RETRO bit set for labeling');
  } finally {
    db.close();
  }
});

test('specificity: model exactness outranks provider exactness (documented tier order)', () => {
  const list = normalizePriceList({
    currency: 'USD', effectiveFrom: '2026-11-01',
    models: [
      { model: 'm', input: 1 },                 // wildcard provider + exact model → tier 2
      { provider: 'p', model: '*', input: 9 },  // exact provider + wildcard model → tier 3
      { provider: 'p', model: 'm', input: 5 },  // exact + exact → tier 1
      { model: '*', input: 7 },                 // full wildcard → tier 4
    ],
  });
  const pick = (p, m) => resolvePrice([list], localTs(2026, 11, 10), p, m).entry;
  assert.equal(pick('p', 'm').input, 5, 'exact provider + exact model wins');
  // The reported conflict: both middle tiers match a p/m request.
  const conflict = normalizePriceList({
    currency: 'USD', effectiveFrom: '2026-11-01',
    models: [
      { model: 'm', input: 1 },
      { provider: 'p', model: '*', input: 9 },
    ],
  });
  assert.equal(
    resolvePrice([conflict], localTs(2026, 11, 10), 'p', 'm').entry.input, 1,
    'wildcard provider + exact model beats exact provider + wildcard model',
  );
  assert.equal(pick(null, 'm').input, 1, 'wildcard-provider tier applies when provider differs');
  assert.equal(pick('p', 'other').input, 9, 'provider-wildcard-model tier when no exact model');
  assert.equal(pick('q', 'other').input, 7, 'full wildcard fallback');
});

test('effectiveFrom rejects rolled dates and out-of-range epochs', () => {
  assert.equal(normalizeEffectiveFrom('2026-02-30'), null, 'Feb 30 rolls to March — rejected');
  assert.equal(normalizeEffectiveFrom('2026-02-29'), null, '2026 is not a leap year');
  assert.equal(normalizeEffectiveFrom('2028-02-29'), localTs(2028, 2, 29, 0), 'a real leap day passes');
  assert.equal(normalizeEffectiveFrom('2026-13-01'), null, 'month 13 rolls to January — rejected');
  assert.equal(normalizeEffectiveFrom('2026-04-31'), null, 'April 31 rolls to May — rejected');
  assert.equal(normalizeEffectiveFrom(1e20), null, 'epoch beyond the Date range — rejected, not thrown');
  assert.equal(
    normalizePriceList({ currency: 'USD', effectiveFrom: 1e20, models: [{ model: 'm', input: 1 }] }),
    null,
    'the whole list is skipped instead of crashing the sync',
  );
});

test('rate windows read wall-clock in the stored zone, not the process zone', () => {
  const utc = normalizePriceList({
    currency: 'USD', effectiveFrom: '2026-11-01', tz: 'UTC',
    windows: [{ from: '04:00', to: '05:00', multiplier: 0.5 }],
    models: [{ model: 'm', input: 1 }],
  });
  assert.equal(utc.windows.tz, 'UTC');
  const ts = Date.UTC(2026, 10, 10, 4, 0); // 04:00 UTC regardless of this machine's zone
  assert.equal(windowMultiplier(utc.windows, ts), 0.5, '04:00 UTC inside the window');
  assert.equal(windowMultiplier(utc.windows, ts + 30 * 60_000), 0.5, '04:30 UTC still inside');
  assert.equal(windowMultiplier(utc.windows, ts + 60 * 60_000), 1, '05:00 UTC outside (exclusive)');
  assert.equal(windowMultiplier(utc.windows, ts + 120 * 60_000), 1, '06:00 UTC outside');

  // A zone-less config resolves to the configuring machine's zone and stores it.
  const zoned = normalizePriceList({
    currency: 'USD', effectiveFrom: '2026-11-01',
    windows: [{ from: '01:00', to: '02:00', multiplier: 0.9 }],
    models: [{ model: 'm', input: 1 }],
  });
  assert.equal(typeof zoned.windows.tz, 'string');
  assert.ok(zoned.windows.tz.length > 0, 'resolved zone is stored with the windows');

  // An invalid zone is a config error — the whole list is rejected.
  assert.equal(normalizePriceList({
    currency: 'USD', effectiveFrom: '2026-11-01', tz: 'Not/AZone',
    windows: [{ from: '01:00', to: '02:00', multiplier: 0.5 }],
    models: [{ model: 'm', input: 1 }],
  }), null, 'invalid IANA zone rejected');
});

test('retro anchoring with multiple lists: earliest-moment resolution, no cross-list splicing', () => {
  // 1) The first list lacks the model entirely → pre-history stays unpriced.
  const db1 = new UsageDatabase(':memory:');
  try {
    db1.upsertRecord(record({ requestId: 's:0', seq: 0, timestamp: localTs(2026, 10, 20, 12) }));
    db1.syncPriceLists([
      { name: 'first', currency: 'USD', effectiveFrom: '2026-11-01', models: [{ model: 'other', input: 1 }] },
      { name: 'second', currency: 'USD', effectiveFrom: '2026-11-05', models: [{ provider: 'p1', model: 'm1', input: 2 }] },
    ]);
    db1.setRetroactivePricing(true);
    const agg = db1.costAggregates();
    assert.equal(agg.coverage.retroPriced, 0, 'first list has no m1 entry → unpriced, no splicing from later lists');
    assert.equal(agg.coverage.pricedRequests, 0, 'the record predates both lists');
  } finally {
    db1.close();
  }

  // 2) Equal effectiveFrom: the first-synced list is the anchor.
  const db2 = new UsageDatabase(':memory:');
  try {
    db2.upsertRecord(record({ requestId: 's:0', seq: 0, timestamp: localTs(2026, 10, 20, 12) }));
    db2.syncPriceLists([
      { name: 'A', currency: 'USD', effectiveFrom: '2026-11-01', models: [{ model: 'm1', input: 3 }] },
      { name: 'B', currency: 'USD', effectiveFrom: '2026-11-01', models: [{ provider: 'p1', model: 'm1', input: 4 }] },
    ]);
    db2.setRetroactivePricing(true);
    const row = db2.costRows({}).find((r) => r.request_id === 's:0');
    assert.equal(row.total_micro, 3_000_000, 'equal effectiveFrom → first-synced list wins the anchor');
  } finally {
    db2.close();
  }

  // 3) A category the anchor list does not price stays unpriced on retro rows.
  const db3 = new UsageDatabase(':memory:');
  try {
    db3.upsertRecord(record({ requestId: 's:0', seq: 0, timestamp: localTs(2026, 10, 20, 12) }));
    db3.syncPriceLists([
      { currency: 'USD', effectiveFrom: '2026-11-01', models: [{ provider: 'p1', model: 'm1', input: 1 }] },
      { currency: 'USD', effectiveFrom: '2026-11-05', models: [{ provider: 'p1', model: 'm1', output: 5 }] },
    ]);
    db3.setRetroactivePricing(true);
    const row = db3.costRows({}).find((r) => r.request_id === 's:0');
    assert.equal(row.total_micro, 1_000_000, 'input priced from the anchor list');
    assert.equal(Number(row.missing_mask) & 2, 2, 'output stays unpriced — no category splicing');
  } finally {
    db3.close();
  }
});

test('listPriceLists exposes windows; the prices view exposes the retro mode', () => {
  const db = new UsageDatabase(':memory:');
  try {
    db.syncPriceLists([{
      currency: 'USD', effectiveFrom: '2026-11-01', tz: 'Asia/Shanghai',
      windows: [{ from: '16:00', to: '00:30', multiplier: 0.5 }],
      models: [{ model: 'm1', input: 1 }],
    }]);
    const [l] = db.listPriceLists();
    assert.equal(l.models, 1);
    assert.notEqual(l.windows, null, 'windows exposed');
    assert.equal(l.windows.tz, 'Asia/Shanghai');
    assert.equal(l.windows.entries.length, 1);
    assert.equal(l.windows.entries[0].multiplier, 0.5);
    assert.equal(new QueryService(db).prices().retroactive, false, 'retro mode off by default');
    db.setRetroactivePricing(true);
    assert.equal(new QueryService(db).prices().retroactive, true);
  } finally {
    db.close();
  }
});
