/**
 * Tests for the price-source suggestion pipeline: OpenRouter normalization,
 * ledger-model matching (alias / exact / unique-model / unmatched), and the
 * generated config YAML.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import {
  DEFAULT_PROVIDER_ALIASES,
  localToday,
  matchPrices,
  normalizeOpenRouter,
  suggestionYaml,
} from '../lib/domain/price-sources.js';

// Fixture shaped exactly like the live OpenRouter listing (per-token USD).
const LISTING = {
  data: [
    {
      id: 'z-ai/glm-5.3',
      pricing: { prompt: '0.0000011', completion: '0.0000044', input_cache_read: '0.00000011' },
    },
    { id: 'z-ai/glm-5.3:free', pricing: { prompt: '0', completion: '0' } },
    {
      id: 'deepseek/deepseek-flash',
      pricing: { prompt: '0.00000027', completion: '0.0000011', input_cache_read: '0.000000027', input_cache_write: '0.00000027' },
    },
    {
      id: 'openai/gpt-6.1-sol',
      pricing: { prompt: '0.000002', completion: '0.00001', input_cache_read: '0.0000001', input_cache_write: '0.0000025' },
    },
    { id: 'weird', pricing: { prompt: '1', completion: '2' } },
    { id: 'a/no-pricing' },
    { id: 'a/zero-both', pricing: { prompt: '0', completion: '0' } },
  ],
};

test('normalizeOpenRouter converts per-token USD to per-1M and skips variants', () => {
  const entries = normalizeOpenRouter(LISTING);
  assert.deepEqual(entries.map((e) => e.key), [
    'z-ai/glm-5.3', 'deepseek/deepseek-flash', 'openai/gpt-6.1-sol', 'a/zero-both',
  ], ':free variants and entries without pricing are skipped; a zero price is real (free model) and kept');
  const glm = entries[0];
  assert.equal(glm.provider, 'z-ai');
  assert.equal(glm.model, 'glm-5.3');
  assert.equal(glm.input, 1.1);
  assert.equal(glm.output, 4.4);
  assert.equal(glm.cacheRead, 0.11);
  assert.equal(glm.cacheWrite, undefined, 'category absent in source stays unset');
  const sol = entries[2];
  assert.equal(sol.input, 2);
  assert.equal(sol.output, 10);
  assert.equal(sol.cacheWrite, 2.5);
  assert.deepEqual(normalizeOpenRouter({ data: 'nope' }), []);
  assert.deepEqual(normalizeOpenRouter(null), []);
});

test('matchPrices: alias, exact, unique-model, and honest unmatched', () => {
  const entries = normalizeOpenRouter(LISTING);
  const ledger = [
    { provider: 'glm', model: 'glm-5.3', requests: 271 },              // alias glm→z-ai
    { provider: 'deepseek-account', model: 'deepseek-flash', requests: 312 }, // alias
    { provider: 'openai', model: 'gpt-6.1-sol', requests: 1 },         // exact
    { provider: 'gpt', model: 'gpt-6.1-sol', requests: 1 },            // alias → openai
    { provider: 'p1', model: 'glm-5.3', requests: 5 },                 // model appears once → 'model'
    { provider: 'p1', model: 'does-not-exist', requests: 2 },          // unmatched
    { provider: null, model: null, requests: 1 },                      // unmatched
  ];
  const { matches, unmatched } = matchPrices(entries, ledger);
  assert.equal(matches.length, 5);
  assert.equal(matches[0].key, 'z-ai/glm-5.3');
  assert.equal(matches[0].confidence, 'alias');
  assert.equal(matches[1].key, 'deepseek/deepseek-flash');
  assert.equal(matches[2].confidence, 'exact');
  assert.equal(matches[3].confidence, 'alias');
  assert.equal(matches[4].confidence, 'model');
  assert.equal(unmatched.length, 2);
  // Custom aliases override the built-in table.
  const custom = matchPrices(entries, [{ provider: 'glm', model: 'glm-5.3', requests: 1 }], { glm: 'other' });
  assert.equal(custom.matches.length, 1);
  assert.equal(custom.matches[0].confidence, 'model', 'alias miss falls back, not fails');
  assert.ok(Object.values(DEFAULT_PROVIDER_ALIASES).includes('z-ai'));
});

test('suggestionYaml emits only categories the source provides', () => {
  const entries = normalizeOpenRouter(LISTING);
  const { matches } = matchPrices(entries, [
    { provider: 'glm', model: 'glm-5.3', requests: 1 },
    { provider: 'gpt', model: 'gpt-6.1-sol', requests: 1 },
  ]);
  const yaml = suggestionYaml(matches, {
    name: 'openrouter-test', currency: 'USD', effectiveFrom: '2026-11-10',
  });
  assert.match(yaml, /- name: openrouter-test/);
  assert.match(yaml, /effectiveFrom: '2026-11-10'/);
  assert.match(yaml, /- \{ model: glm-5\.3, provider: glm, input: 1\.1, output: 4\.4, cacheRead: 0\.11 \}/);
  assert.match(yaml, /cacheWrite: 2\.5/);
  assert.doesNotMatch(yaml, /model: glm-5\.3[^\n]*cacheWrite/);
});

test('localToday is a local YYYY-MM-DD', () => {
  assert.match(localToday(), /^\d{4}-\d{2}-\d{2}$/);
});
