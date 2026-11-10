/**
 * OpenRouter reference-price matching (pure logic, no network).
 *
 * Used by the manual import flow: the costs tab asks the host to fetch
 * OpenRouter's public model list, these functions map ledger (provider,
 * model) pairs onto OpenRouter entries, and the user confirms each row
 * before anything is written to the price config.
 *
 * Prices on OpenRouter are USD per token as decimal strings; the price
 * config stores USD per 1M tokens.
 */

export interface LocalPair {
  provider: string | null;
  model: string | null;
  requests: number;
  tokens: number | null;
}

export interface OpenRouterModel {
  id: string;
  name?: string | null;
  pricing?: Record<string, unknown> | null;
}

export type MatchQuality = 'exact' | 'suffix' | 'fuzzy';

export interface PriceSuggestion {
  provider: string | null;
  model: string;
  requests: number;
  tokens: number | null;
  matchId: string | null;
  matchName: string | null;
  matchQuality: MatchQuality | null;
  /** Per-1M USD prices; null = OpenRouter did not report that category. */
  input: number | null;
  output: number | null;
  cacheRead: number | null;
  cacheWrite: number | null;
  /** Pre-checked only when the name match is unambiguous. */
  checked: boolean;
}

/** USD-per-token (string or number) → USD per 1M tokens, 6-decimal rounded. */
export function perMillion(value: unknown): number | null {
  if (typeof value === 'number') {
    if (!Number.isFinite(value) || value < 0) return null;
  } else if (typeof value === 'string' && value.length > 0) {
    const parsed = Number(value);
    if (!Number.isFinite(parsed) || parsed < 0) return null;
    return round6(parsed * 1e6);
  } else {
    return null;
  }
  return round6((value as number) * 1e6);
}

function round6(v: number): number {
  return Math.round(v * 1e6) / 1e6;
}

/**
 * Best OpenRouter entry for one ledger pair.
 * `deepseek-account` style provider names also try their first segment
 * (`deepseek`) so account-qualified providers still match exactly.
 */
export function matchOpenRouter(
  pair: { provider: string | null; model: string | null },
  models: readonly OpenRouterModel[],
): { model: OpenRouterModel; quality: MatchQuality } | null {
  const raw = pair.model?.trim().toLowerCase();
  if (raw === undefined || raw.length === 0) return null;
  const model: string = raw;
  const providers = providerCandidates(pair.provider);
  let best: { model: OpenRouterModel; quality: MatchQuality } | null = null;
  for (const candidate of models) {
    const id = candidate.id.toLowerCase();
    const quality = classify(id, candidate.name ?? null, model, providers);
    if (quality === null) continue;
    // Same rank: prefer the shorter id so plain variants win over suffixed
    // variants (glm-5.3 over glm-5.3-flashx-legal) deterministically.
    const better =
      best === null
      || rank(quality) < rank(best.quality)
      || (rank(quality) === rank(best.quality) && id.length < best.model.id.length);
    if (better) best = { model: candidate, quality };
  }
  return best;
}

function providerCandidates(provider: string | null | undefined): string[] {
  if (provider === null || provider === undefined) return [];
  const p = provider.trim().toLowerCase();
  if (p.length === 0) return [];
  const first = p.split('-')[0] ?? p;
  return first !== p ? [p, first] : [p];
}

function classify(
  id: string,
  displayName: string | null,
  model: string,
  providers: string[],
): MatchQuality | null {
  // A ledger model may itself be the full OpenRouter id
  // (provider "openrouter", model "anthropic/claude-sonnet-4").
  if (id === model) return 'exact';
  for (const p of providers) {
    if (id === `${p}/${model}`) return 'exact';
  }
  if (id.endsWith(`/${model}`)) return 'suffix';
  const tail = id.slice(id.lastIndexOf('/') + 1);
  if (tail === model || tail.replaceAll(/[^a-z0-9.]/g, '') === model) return 'suffix';
  const name = displayName?.toLowerCase() ?? '';
  if (name.includes(model) || tail.includes(model)) return 'fuzzy';
  return null;
}

function rank(quality: MatchQuality): number {
  return quality === 'exact' ? 0 : quality === 'suffix' ? 1 : 2;
}

/** Map every ledger pair to a suggestion row; best matches first-stable order. */
export function buildSuggestions(
  pairs: readonly LocalPair[],
  orModels: readonly OpenRouterModel[],
): PriceSuggestion[] {
  return pairs.map((pair) => {
    const match = matchOpenRouter(pair, orModels);
    const pricing = match?.model.pricing ?? null;
    const pick = (key: string): number | null => (pricing === null ? null : perMillion(pricing[key]));
    const quality = match?.quality ?? null;
    return {
      provider: pair.provider,
      model: pair.model ?? '',
      requests: pair.requests,
      tokens: pair.tokens,
      matchId: match?.model.id ?? null,
      matchName: match?.model.name ?? null,
      matchQuality: quality,
      input: pick('prompt'),
      output: pick('completion'),
      cacheRead: pick('input_cache_read'),
      cacheWrite: pick('input_cache_write'),
      checked: quality === 'exact' || quality === 'suffix',
    };
  });
}
