/**
 * Tests for the context monitor: `request/context` normalization, the
 * derived context-tokens fill (input + cacheRead + cacheWrite of the first
 * following usage record, attributed to every still-open sample), and the
 * per-session views.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { SessionNormalizer } from '../lib/collector/normalizer.js';
import { UsageDatabase } from '../lib/storage/database.js';

function normalizer() {
  return new SessionNormalizer('s1', {});
}

function record(overrides = {}) {
  return {
    requestId: 's1:20', sessionId: 's1', seq: 20, turn: 1, step: 1,
    parentSessionId: null, origin: null, isSeed: 0, cwd: null,
    provider: 'glm', model: 'glm-5.3', kind: 'chat',
    timestamp: 1794300000000,
    inputTokens: 1_000, outputTokens: 200,
    cacheReadTokens: 50_000, cacheWriteTokens: null,
    reasoningTokens: null, totalTokens: 51_200,
    durationMs: null, firstTokenLatencyMs: null,
    finishReason: null, errorCode: null, errorStatus: null, errorMessage: null,
    rawUsage: null, sourceEvent: 'assistant/message',
    ...overrides,
  };
}

test('processContext extracts the request/context payload defensively', () => {
  const n = normalizer();
  const sample = n.processContext({
    type: 'request/context', seq: 19, time: 1794299999000,
    data: { provider: 'glm', model: 'glm-5.3', contextWindow: 1_000_000 },
  });
  assert.deepEqual(sample, {
    sessionId: 's1', seq: 19, timestamp: 1794299999000,
    provider: 'glm', model: 'glm-5.3', contextWindow: 1_000_000,
  });
  assert.equal(n.processContext({ type: 'assistant/message', seq: 20, time: 1, data: {} }), null);
  assert.equal(n.processContext({ type: 'request/context', seq: 21, time: 1, data: 'junk' }), null);
  assert.equal(n.processContext({ type: 'request/context', seq: 22, time: 1, data: {} }), null);
});

test('fillContextTokens attributes the following request feed to open samples', () => {
  const db = new UsageDatabase(':memory:');
  try {
    // Two samples: one for a failed attempt (seq 10, no usage record), one
    // for the settled message (seq 12). The sessions row is written by the
    // collector on the first event of the session.
    db.upsertSession({ sessionId: 's1', createdAt: 1, cwd: null, parentSessionId: null, origin: null, seedLength: null, lastSeq: 20, updatedAt: 1 });
    db.upsertContextSample({ sessionId: 's1', seq: 10, timestamp: 1, provider: 'glm', model: 'glm-5.3', contextWindow: 1_000_000 });
    db.upsertContextSample({ sessionId: 's1', seq: 12, timestamp: 2, provider: 'glm', model: 'glm-5.3', contextWindow: 1_000_000 });
    // A record without token data closes nothing.
    db.fillContextTokens(record({ requestId: 's1:11', seq: 11, inputTokens: null, cacheReadTokens: null, cacheWriteTokens: null, totalTokens: null }));
    let samples = db.contextSamples('s1');
    assert.equal(samples.length, 0, 'nothing filled from a token-less record');
    // The settled message fills BOTH open samples (same logical request).
    db.fillContextTokens(record({ requestId: 's1:20', seq: 20, inputTokens: 1_000, cacheReadTokens: 50_000, cacheWriteTokens: null }));
    samples = db.contextSamples('s1');
    assert.equal(samples.length, 2);
    assert.ok(samples.every((s) => s.contextTokens === 51_000 && s.requestId === 's1:20'));
    // Replay is a no-op: samples are already filled.
    db.fillContextTokens(record({ requestId: 's1:20', seq: 20 }));
    assert.equal(db.contextSamples('s1').length, 2);

    const sessions = db.contextSessions();
    assert.equal(sessions.length, 1);
    assert.equal(sessions[0].sessionId, 's1');
    assert.equal(sessions[0].contextTokens, 51_000);
    assert.equal(sessions[0].contextWindow, 1_000_000);
    assert.equal(sessions[0].compactions, 0);
    // A compaction record counts toward the session's compactions.
    db.upsertRecord(record({ requestId: 's1:30', seq: 30, kind: 'compaction', sourceEvent: 'compaction/summary' }));
    assert.equal(db.contextSessions()[0].compactions, 1);
  } finally {
    db.close();
  }
});
