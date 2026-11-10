import test from 'node:test';
import assert from 'node:assert/strict';
import { perMillion, matchOpenRouter, buildSuggestions } from '../lib/domain/openrouter.js';

const OR_FIXTURE = [
  { id: 'z-ai/glm-5.3', name: 'GLM 5.3', pricing: { prompt: '0.0000005', completion: '0.0000015', input_cache_read: '0.00000005', input_cache_write: '0.0000007' } },
  { id: 'z-ai/glm-5.3-flash', name: 'GLM 5.3 Flash', pricing: { prompt: '0.00000006', completion: '0.00000022' } },
  { id: 'deepseek/deepseek-flash', name: 'DeepSeek Flash', pricing: { prompt: '0.00000027', completion: '0.0000011', input_cache_read: '0.000000007' } },
  { id: 'openai/gpt-6', name: 'GPT-6', pricing: { prompt: '0.00000125', completion: '0.0000010' } },
];

test('perMillion converts USD-per-token strings to per-1M numbers', () => {
  assert.equal(perMillion('0.00000027'), 0.27);
  assert.equal(perMillion('0.0000015'), 1.5);
  assert.equal(perMillion('0'), 0);
  assert.equal(perMillion(0.0000005), 0.5);
  assert.equal(perMillion('abc'), null);
  assert.equal(perMillion(undefined), null);
  assert.equal(perMillion('-1'), null);
});

test('matchOpenRouter prefers exact provider/model id', () => {
  const hit = matchOpenRouter({ provider: 'deepseek', model: 'deepseek-flash' }, OR_FIXTURE);
  assert.equal(hit.model.id, 'deepseek/deepseek-flash');
  assert.equal(hit.quality, 'exact');
});

test('matchOpenRouter matches account-qualified providers via first segment', () => {
  const hit = matchOpenRouter({ provider: 'deepseek-account', model: 'deepseek-flash' }, OR_FIXTURE);
  assert.equal(hit.model.id, 'deepseek/deepseek-flash');
  // 'deepseek-account' normalizes to the 'deepseek' namespace, so this is exact
  assert.equal(hit.quality, 'exact');
});

test('matchOpenRouter matches different provider namespace via suffix', () => {
  const hit = matchOpenRouter({ provider: 'glm', model: 'glm-5.3' }, OR_FIXTURE);
  assert.equal(hit.model.id, 'z-ai/glm-5.3');
  assert.equal(hit.quality, 'suffix');
});

test('matchOpenRouter reports fuzzy when only the display name matches', () => {
  const hit = matchOpenRouter({ provider: 'gpt', model: 'gpt-6' }, OR_FIXTURE);
  assert.equal(hit.model.id, 'openai/gpt-6');
  assert.equal(hit.quality, 'suffix');
});

test('matchOpenRouter returns null for unknown models and null model names', () => {
  assert.equal(matchOpenRouter({ provider: 'gpt', model: 'gpt-6.1-sol' }, OR_FIXTURE), null);
  assert.equal(matchOpenRouter({ provider: 'glm', model: null }, OR_FIXTURE), null);
  assert.equal(matchOpenRouter({ provider: null, model: '' }, OR_FIXTURE), null);
});

test('matchOpenRouter prefers the shorter id among equal-rank fuzzy candidates', () => {
  const fixture = [
    { id: 'z-ai/glm-5.3-flashx-legal', name: 'Z.ai: GLM 5.3 FlashX Legal', pricing: {} },
    { id: 'z-ai/glm-5.3-prime', name: 'Z.ai: GLM 5.3 Prime', pricing: {} },
    { id: 'z-ai/glm-5.3-flashx', name: 'Z.ai: GLM 5.3 FlashX', pricing: {} },
  ];
  const hit = matchOpenRouter({ provider: 'glm', model: 'glm-5.3' }, fixture);
  assert.equal(hit.model.id, 'z-ai/glm-5.3-prime');
  assert.equal(hit.quality, 'fuzzy');
});

test('buildSuggestions fills prices, checked defaults, and null on no match', () => {
  const suggestions = buildSuggestions(
    [
      { provider: 'glm', model: 'glm-5.3', requests: 685, tokens: 154320579 },
      { provider: 'deepseek-account', model: 'deepseek-flash', requests: 312, tokens: 30649966 },
      { provider: 'gpt', model: 'gpt-6.1-sol', requests: 1, tokens: 8630 },
      { provider: 'glm', model: null, requests: 2, tokens: null },
    ],
    OR_FIXTURE,
  );
  assert.equal(suggestions.length, 4);

  const glm = suggestions[0];
  assert.equal(glm.matchId, 'z-ai/glm-5.3');
  assert.equal(glm.input, 0.5);
  assert.equal(glm.output, 1.5);
  assert.equal(glm.cacheRead, 0.05);
  assert.equal(glm.cacheWrite, 0.7);
  assert.equal(glm.checked, true);

  const ds = suggestions[1];
  assert.equal(ds.input, 0.27);
  assert.equal(ds.cacheRead, 0.007);
  assert.equal(ds.cacheWrite, null); // fixture has no cache_write price
  assert.equal(ds.checked, true);

  const unmatched = suggestions[2];
  assert.equal(unmatched.matchId, null);
  assert.equal(unmatched.checked, false);
  assert.equal(unmatched.input, null);

  const nullModel = suggestions[3];
  assert.equal(nullModel.matchId, null);
  assert.equal(nullModel.checked, false);
});
