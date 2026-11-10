import test from 'node:test';
import assert from 'node:assert/strict';
import { SessionNormalizer } from '../lib/collector/normalizer.js';

const baseHeader = { id: 'session-1', createdAt: 100, cwd: 'C:\\ws' };

test('assistant/message becomes a chat record with usage, duration and latency', () => {
  const n = new SessionNormalizer('session-1', baseHeader);
  n.process({ type: 'step/start', seq: 6, time: 1000, data: { turn: 1, step: 1 } });
  const record = n.process({
    type: 'assistant/message',
    seq: 19,
    time: 2500,
    data: {
      turn: 1,
      step: 1,
      message: {
        role: 'assistant',
        content: [],
        source: { kind: 'model', provider: 'deepseek-account', model: 'deepseek-flash' },
        id: 'm1',
      },
      usage: { inputTokens: 877, outputTokens: 192, cacheReadTokens: 8960, cacheWriteTokens: 0, totalTokens: 10029 },
      stream: [
        { type: 'chunk', time: 1100, chunk: { type: 'text-delta', index: 0, text: 'H' } },
        { type: 'text-chunks', time0: 1200, index: 0, dt: [5], texts: ['e', 'llo'] },
      ],
    },
  });
  assert.ok(record);
  assert.equal(record.requestId, 'session-1:19');
  assert.equal(record.kind, 'chat');
  assert.equal(record.provider, 'deepseek-account');
  assert.equal(record.model, 'deepseek-flash');
  assert.equal(record.inputTokens, 877);
  assert.equal(record.outputTokens, 192);
  assert.equal(record.cacheReadTokens, 8960);
  assert.equal(record.cacheWriteTokens, 0);
  assert.equal(record.totalTokens, 10029);
  assert.equal(record.reasoningTokens, null);
  assert.equal(record.durationMs, 1500);
  assert.equal(record.firstTokenLatencyMs, 100);
  assert.equal(record.isSeed, 0);
  assert.equal(record.rawUsage, JSON.stringify({ inputTokens: 877, outputTokens: 192, cacheReadTokens: 8960, cacheWriteTokens: 0, totalTokens: 10029 }));
});

test('compaction/summary becomes a compaction record', () => {
  const n = new SessionNormalizer('session-1', baseHeader);
  const record = n.process({
    type: 'compaction/summary',
    seq: 455,
    time: 1794292188328,
    data: {
      compactionId: 'c1',
      provider: 'glm',
      model: 'glm-5.3',
      usage: { inputTokens: 421, outputTokens: 2920, cacheReadTokens: 259840, totalTokens: 263181 },
    },
  });
  assert.ok(record);
  assert.equal(record.kind, 'compaction');
  assert.equal(record.provider, 'glm');
  assert.equal(record.model, 'glm-5.3');
  assert.equal(record.totalTokens, 263181);
  assert.equal(record.cacheWriteTokens, null);
});

test('events below seedLength are marked isSeed', () => {
  const n = new SessionNormalizer('session-2', { ...baseHeader, id: 'session-2', parentSession: 'session-1', seedLength: 5 });
  n.process({ type: 'step/start', seq: 2, time: 100, data: { turn: 1, step: 1 } });
  const seeded = n.process({
    type: 'assistant/message',
    seq: 3,
    time: 200,
    data: { turn: 1, step: 1, message: { source: { provider: 'glm', model: 'glm-5.3' } }, usage: { totalTokens: 10 } },
  });
  assert.ok(seeded);
  assert.equal(seeded.isSeed, 1);
  assert.equal(seeded.parentSessionId, 'session-1');

  n.process({ type: 'step/start', seq: 6, time: 300, data: { turn: 2, step: 1 } });
  const own = n.process({
    type: 'assistant/message',
    seq: 7,
    time: 400,
    data: { turn: 2, step: 1, message: { source: { provider: 'glm', model: 'glm-5.3' } }, usage: { totalTokens: 11 } },
  });
  assert.ok(own);
  assert.equal(own.isSeed, 0);
});

test('assistant/message without usage keeps every token null', () => {
  const n = new SessionNormalizer('session-1', baseHeader);
  const record = n.process({
    type: 'assistant/message',
    seq: 30,
    time: 1000,
    data: { turn: 1, step: 2, message: { source: { provider: 'gpt', model: 'gpt-6.1-sol' } } },
  });
  assert.ok(record);
  assert.equal(record.inputTokens, null);
  assert.equal(record.totalTokens, null);
  assert.equal(record.rawUsage, null);
  assert.equal(record.durationMs, null);
});

test('assistant/attempt extracts usage and failure from its embedded stream (real payload)', () => {
  const n = new SessionNormalizer('session-1', baseHeader);
  const record = n.process({
    type: 'assistant/attempt',
    seq: 179,
    time: 1794303518423,
    data: {
      turn: 1,
      step: 21,
      stream: [
        { type: 'chunk', time: 1794303518422, chunk: { type: 'usage', usage: { inputTokens: 4100, outputTokens: 33, totalTokens: 4133, cacheReadTokens: 0, cacheWriteTokens: 0 } } },
        {
          type: 'chunk',
          time: 1794303518423,
          chunk: {
            type: 'finish',
            reason: { kind: 'error', failure: { message: '502 Upstream service temporarily unavailable', code: 'SERVER' } },
          },
        },
      ],
    },
  });
  assert.ok(record);
  assert.equal(record.kind, 'attempt');
  assert.equal(record.finishReason, 'error');
  assert.equal(record.errorCode, 'SERVER');
  assert.equal(record.errorMessage, '502 Upstream service temporarily unavailable');
  assert.equal(record.inputTokens, 4100);
  assert.equal(record.outputTokens, 33);
  assert.equal(record.totalTokens, 4133);
  assert.equal(record.provider, null);
});

test('llm/retry amends the matching attempt record under the same requestId', () => {
  const n = new SessionNormalizer('session-1', baseHeader);
  const attempt = n.process({
    type: 'assistant/attempt',
    seq: 179,
    time: 1000,
    data: {
      turn: 1,
      step: 21,
      stream: [
        { type: 'chunk', time: 999, chunk: { type: 'finish', reason: { kind: 'error', failure: { message: '502', code: 'SERVER' } } } },
      ],
    },
  });
  assert.ok(attempt);
  assert.equal(attempt.provider, null);

  const amended = n.process({
    type: 'llm/retry',
    seq: 180,
    time: 1100,
    data: {
      retryId: 'r1',
      turn: 1,
      step: 21,
      provider: 'glm',
      retry: 1,
      maxRetries: 5,
      delayMs: 522.7,
      failure: { message: '502 Upstream service temporarily unavailable', code: 'SERVER' },
    },
  });
  assert.ok(amended);
  assert.equal(amended.requestId, attempt.requestId);
  assert.equal(amended.provider, 'glm');
  assert.equal(amended.errorCode, 'SERVER');
  assert.equal(amended.kind, 'attempt');
});

test('llm/retry without a prior attempt bills its own boundary record', () => {
  const n = new SessionNormalizer('session-1', baseHeader);
  const record = n.process({
    type: 'llm/retry',
    seq: 180,
    time: 1100,
    data: { retryId: 'r1', turn: 2, step: 3, provider: 'glm', retry: 1, failure: { message: 'timeout', code: 'TIMEOUT' } },
  });
  assert.ok(record);
  assert.equal(record.requestId, 'session-1:180');
  assert.equal(record.provider, 'glm');
  assert.equal(record.errorCode, 'TIMEOUT');
  assert.equal(record.finishReason, 'error');
});

test('malformed events never throw', () => {
  const n = new SessionNormalizer('session-1', baseHeader);
  assert.equal(n.process({ type: 'assistant/message', seq: 1, time: 1, data: 42 }), null);
  assert.equal(n.process({ type: 'compaction/summary', seq: 2, time: 2 }), null);
  assert.equal(n.process({ type: 'user/message', seq: 3, time: 3, data: {} }), null);
});

test('unrelated events return null', () => {
  const n = new SessionNormalizer('session-1', baseHeader);
  for (const type of ['user/message', 'tool/call', 'tool/result', 'turn/start', 'session/title']) {
    assert.equal(n.process({ type, seq: 1, time: 1, data: {} }), null, type);
  }
});
