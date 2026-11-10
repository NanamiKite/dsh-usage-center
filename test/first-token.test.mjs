import test from 'node:test';
import assert from 'node:assert/strict';
import { firstTokenTime, lastStreamTime } from '../lib/domain/first-token.js';

test('raw text-delta chunk with content counts', () => {
  const stream = [
    { type: 'chunk', time: 1000, chunk: { type: 'block-start', index: 0, blockType: 'reasoning' } },
    { type: 'chunk', time: 1100, chunk: { type: 'reasoning-delta', index: 0, text: 'The' } },
  ];
  assert.equal(firstTokenTime(stream), 1100);
});

test('empty text deltas are skipped until a non-empty one', () => {
  const stream = [
    { type: 'chunk', time: 1000, chunk: { type: 'text-delta', index: 0, text: '' } },
    { type: 'chunk', time: 1200, chunk: { type: 'text-delta', index: 0, text: 'H' } },
  ];
  assert.equal(firstTokenTime(stream), 1200);
});

test('packed text run counts at first non-empty fragment', () => {
  const stream = [
    { type: 'text-chunks', time0: 5000, index: 0, dt: [10, 20], texts: ['', 'a', 'b'] },
  ];
  assert.equal(firstTokenTime(stream), 5010);
});

test('tool-call run with name counts at time0', () => {
  const stream = [
    { type: 'tool-call-chunks', time0: 7000, index: 1, dt: [5], id: 'call_1', name: 'pwsh', args: ['', '{"x"'] },
  ];
  assert.equal(firstTokenTime(stream), 7000);
});

test('tool-call run without name counts at first non-empty args fragment', () => {
  const stream = [
    { type: 'tool-call-chunks', time0: 7000, index: 1, dt: [5, 7], id: 'call_1', args: ['', 'x', 'y'] },
  ];
  assert.equal(firstTokenTime(stream), 7005);
});

test('usage and finish chunks never count', () => {
  const stream = [
    { type: 'chunk', time: 900, chunk: { type: 'usage', usage: { inputTokens: 1 } } },
    { type: 'chunk', time: 950, chunk: { type: 'finish', reason: { kind: 'stop' } } },
  ];
  assert.equal(firstTokenTime(stream), undefined);
});

test('lastStreamTime returns the reconstructed end of the last record', () => {
  const stream = [
    { type: 'text-chunks', time0: 1000, index: 0, dt: [10, 10], texts: ['a', 'b', 'c'] },
    { type: 'chunk', time: 1030, chunk: { type: 'finish', reason: { kind: 'stop' } } },
  ];
  assert.equal(lastStreamTime(stream), 1030);
});

test('empty stream yields undefined', () => {
  assert.equal(firstTokenTime([]), undefined);
  assert.equal(lastStreamTime([]), undefined);
});
