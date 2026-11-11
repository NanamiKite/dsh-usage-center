import test from 'node:test';
import assert from 'node:assert/strict';
import { perMillion, matchOpenRouter, buildSuggestions, normalizedMatches, versionSeparatorKey } from '../lib/domain/openrouter.js';

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

test('versionSeparatorKey rewrites only single-digit version separators', () => {
  assert.equal(versionSeparatorKey('claude5-5'), 'claude5.5');
  assert.equal(versionSeparatorKey('anthropic/claude-sonnet-4-5'), 'anthropic/claude-sonnet-4.5');
  assert.equal(versionSeparatorKey('gemini-2-5-pro'), 'gemini-2.5-pro');
  assert.equal(versionSeparatorKey('claude-3-5-haiku-20241022'), 'claude-3.5-haiku-20241022');
  // Ordinary hyphens, dates, snapshots, and sizes keep their separators.
  assert.equal(versionSeparatorKey('deepseek-flash'), 'deepseek-flash');
  assert.equal(versionSeparatorKey('model-2024-01'), 'model-2024-01');
  assert.equal(versionSeparatorKey('gpt-4o-2024-11-20'), 'gpt-4o-2024-11-20');
  assert.equal(versionSeparatorKey('glm-4-32b'), 'glm-4-32b');
  assert.equal(versionSeparatorKey('gpt-5-preview'), 'gpt-5-preview');
});

test('exact id outranks the dotted twin', () => {
  const fixture = [
    { id: 'anthropic/claude5.5', name: 'Claude 5.5', pricing: {} },
    { id: 'anthropic/claude5-5', name: 'Claude 5.5', pricing: {} },
  ];
  const hit = matchOpenRouter({ provider: 'anthropic', model: 'claude5-5' }, fixture);
  assert.equal(hit?.model.id, 'anthropic/claude5-5');
  assert.equal(hit?.quality, 'exact');
});

test('suffix match outranks the normalized tier', () => {
  const fixture = [
    { id: 'z-ai/glm-5.3', name: 'GLM 5.3', pricing: {} },
    { id: 'glm/glm-5-3', name: 'GLM 5.3', pricing: {} },
  ];
  const [row] = buildSuggestions([{ provider: 'glm', model: 'glm-5.3', requests: 1, tokens: 1 }], fixture);
  assert.equal(row?.matchId, 'z-ai/glm-5.3');
  assert.equal(row?.matchQuality, 'suffix');
  assert.deepEqual(row?.normalizedCandidates, []);
});

test('single normalized candidate is reported but never pre-checked', () => {
  const fixture = [
    { id: 'anthropic/claude5.5', name: 'Claude 5.5', pricing: { prompt: '0.000003', completion: '0.000015' } },
  ];
  const [row] = buildSuggestions([{ provider: 'anthropic', model: 'claude5-5', requests: 8, tokens: 900000 }], fixture);
  assert.equal(row?.matchId, 'anthropic/claude5.5');
  assert.equal(row?.matchQuality, 'normalized');
  assert.equal(row?.checked, false);
  assert.equal(row?.input, 3);
  assert.equal(row?.output, 15);
  assert.deepEqual(row?.normalizedCandidates?.map((c) => c.id), ['anthropic/claude5.5']);
});

test('normalized tier outranks fuzzy display-name matches', () => {
  const fixture = [
    { id: 'anthropic/claude5.5', name: 'Claude 5.5', pricing: { prompt: '0.000003' } },
    { id: 'anthropic/claude5-5-family', name: 'Claude5-5 Family', pricing: {} },
  ];
  const [row] = buildSuggestions([{ provider: 'anthropic', model: 'claude5-5', requests: 1, tokens: 1 }], fixture);
  assert.equal(row?.matchId, 'anthropic/claude5.5');
  assert.equal(row?.matchQuality, 'normalized');
});

test('ordinary hyphens never become version matches', () => {
  const fixture = [
    { id: 'deepseek/deepseek.flash', name: 'DeepSeek Flash', pricing: {} },
    { id: 'acme/model-2024.01', name: 'Model 2024.01', pricing: {} },
  ];
  assert.equal(matchOpenRouter({ provider: 'deepseek', model: 'deepseek-flash' }, fixture), null);
  assert.deepEqual(normalizedMatches({ provider: 'deepseek', model: 'deepseek-flash' }, fixture), []);
  assert.deepEqual(normalizedMatches({ provider: 'acme', model: 'model-2024-01' }, fixture), []);
});

test('preview variants are not version-matched', () => {
  // `gpt-5-5` must not reach a preview variant…
  const previews = [{ id: 'openai/gpt-5-preview', name: 'GPT-5 Preview', pricing: {} }];
  assert.deepEqual(normalizedMatches({ provider: 'openai', model: 'gpt-5-5' }, previews), []);
  assert.equal(matchOpenRouter({ provider: 'openai', model: 'gpt-5-5' }, previews), null);
  // …and a preview model never normalizes onto the plain dotted twin.
  const twins = [{ id: 'openai/gpt-5.5', name: 'GPT-5.5', pricing: {} }];
  assert.deepEqual(normalizedMatches({ provider: 'openai', model: 'gpt-5-preview' }, twins), []);
});

test('multiple normalized candidates are never auto-picked', () => {
  const fixture = [
    { id: 'qwenlab/qwen-4.6', name: 'Qwen 4.6', pricing: { prompt: '0.0000006', completion: '0.0000024' } },
    { id: 'openrouter/qwen-4.6', name: 'Qwen 4.6 (openrouter)', pricing: { prompt: '0.0000005', completion: '0.0000022' } },
  ];
  const [row] = buildSuggestions([{ provider: 'qwenlab', model: 'qwen-4-6', requests: 2, tokens: 40000 }], fixture);
  assert.equal(row?.matchId, null);
  assert.equal(row?.matchName, null);
  assert.equal(row?.matchQuality, 'normalized');
  assert.equal(row?.checked, false);
  assert.equal(row?.input, null);
  // Sorted by id for stable display — not catalog order, no shortest-id pick.
  assert.deepEqual(row?.normalizedCandidates?.map((c) => c.id), ['openrouter/qwen-4.6', 'qwenlab/qwen-4.6']);
  assert.equal(row?.normalizedCandidates?.[1]?.input, 0.6);
});
