/**
 * Pricing: pure helpers for the estimated-cost engine.
 *
 * Policy semantics:
 * - A price list applies from its `effectiveFrom` instant (local midnight
 *   when given as `YYYY-MM-DD`). At any timestamp the applicable list is the
 *   newest one already in effect; before the first list nothing is priced.
 * - Within a list, the most specific model entry wins: exact provider+model,
 *   then wildcard provider+exact model, then exact provider+wildcard model,
 *   then full wildcard.
 * - Prices are per **1M tokens**, one currency per list. Cost arithmetic is
 *   done in integer micro currency units (1e-6) to keep sums exact:
 *   `micro = round(tokens * pricePerMillion)`.
 * - A token category with tokens but no configured price stays unpriced
 *   (missing flag) — the engine never falls back to a guessed price.
 */

import { createHash } from 'node:crypto';

/** One model's prices inside a price list. `provider` omitted = wildcard. */
export interface ModelPriceConfig {
  provider?: string;
  model: string;
  /** Per 1M input tokens, in the list's currency. */
  input?: number;
  /** Per 1M output tokens. */
  output?: number;
  /** Per 1M cache-read tokens. */
  cacheRead?: number;
  /** Per 1M cache-write tokens. */
  cacheWrite?: number;
}

/** A versioned snapshot of prices effective from a point in time. */
export interface PriceListConfig {
  name?: string;
  /** ISO 4217 code, e.g. `USD`, `CNY`. */
  currency: string;
  /** Local `YYYY-MM-DD` or epoch ms. */
  effectiveFrom: string | number;
  models: ModelPriceConfig[];
}

export interface NormalizedPriceList {
  name: string;
  currency: string;
  effectiveFrom: number;
  models: ModelPriceConfig[];
  /** Stable content hash for idempotent config sync. */
  hash: string;
}

/** Missing-price flags (bitmask over token categories). */
export const MISSING_INPUT = 1;
export const MISSING_OUTPUT = 2;
export const MISSING_CACHE_READ = 4;
export const MISSING_CACHE_WRITE = 8;

/**
 * Parse and validate one configured list. Returns null for a malformed list
 * (bad date, empty models, non-positive price); the caller skips it and
 * reports, rather than guessing an interpretation.
 */
export function normalizePriceList(input: unknown): NormalizedPriceList | null {
  if (typeof input !== 'object' || input === null) return null;
  const raw = input as Record<string, unknown>;
  const currency = typeof raw.currency === 'string' ? raw.currency.trim().toUpperCase() : '';
  if (!/^[A-Z]{3}$/.test(currency)) return null;
  const effectiveFrom = normalizeEffectiveFrom(raw.effectiveFrom);
  if (effectiveFrom === null) return null;
  if (!Array.isArray(raw.models) || raw.models.length === 0) return null;
  const models: ModelPriceConfig[] = [];
  for (const entry of raw.models) {
    if (typeof entry !== 'object' || entry === null) return null;
    const e = entry as Record<string, unknown>;
    const model = typeof e.model === 'string' ? e.model.trim() : '';
    if (model.length === 0) return null;
    const provider =
      typeof e.provider === 'string' && e.provider.trim().length > 0
        ? e.provider.trim()
        : undefined;
    const price = (value: unknown): number | undefined => {
      if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) return undefined;
      return value;
    };
    const normalized: ModelPriceConfig = { model };
    if (provider !== undefined) normalized.provider = provider;
    const inputPrice = price(e.input);
    const outputPrice = price(e.output);
    const cacheReadPrice = price(e.cacheRead);
    const cacheWritePrice = price(e.cacheWrite);
    if (inputPrice !== undefined) normalized.input = inputPrice;
    if (outputPrice !== undefined) normalized.output = outputPrice;
    if (cacheReadPrice !== undefined) normalized.cacheRead = cacheReadPrice;
    if (cacheWritePrice !== undefined) normalized.cacheWrite = cacheWritePrice;
    if (normalized.input === undefined && normalized.output === undefined &&
        normalized.cacheRead === undefined && normalized.cacheWrite === undefined) {
      return null; // an entry with no price at all is a config error
    }
    models.push(normalized);
  }
  const name = typeof raw.name === 'string' && raw.name.trim().length > 0
    ? raw.name.trim()
    : `${currency} @ ${new Date(effectiveFrom).toISOString()}`;
  return { name, currency, effectiveFrom, models, hash: hashPriceList({ name, currency, effectiveFrom, models }) };
}

/** Local `YYYY-MM-DD` (midnight) or epoch ms → epoch ms; null when invalid. */
export function normalizeEffectiveFrom(value: unknown): number | null {
  if (typeof value === 'number' && Number.isFinite(value)) return Math.trunc(value);
  if (typeof value === 'string') {
    const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value.trim());
    if (match !== null) {
      const date = new Date(
        Number(match[1]), Number(match[2]) - 1, Number(match[3]), 0, 0, 0, 0,
      );
      return Number.isNaN(date.getTime()) ? null : date.getTime();
    }
  }
  return null;
}

function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  if (value !== null && typeof value === 'object') {
    const entries = Object.entries(value as Record<string, unknown>)
      .filter(([, v]) => v !== undefined)
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
    return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${canonicalJson(v)}`).join(',')}}`;
  }
  return JSON.stringify(value) ?? 'null';
}

function hashPriceList(list: Omit<NormalizedPriceList, 'hash'>): string {
  return createHash('sha256').update(canonicalJson(list)).digest('hex').slice(0, 32);
}

function specificity(entry: ModelPriceConfig, provider: string | null, model: string | null): number {
  const providerOk = entry.provider === undefined || entry.provider === provider;
  const modelOk = entry.model === '*' || entry.model === model;
  if (!providerOk || !modelOk) return -1;
  const providerRank = entry.provider === undefined ? 0 : 1;
  const modelRank = entry.model === '*' ? 0 : 1;
  return providerRank * 2 + modelRank;
}

/**
 * The applicable entry for one request, or null when nothing prices it:
 * among the lists already in effect at `timestamp`, the newest wins; inside
 * that list the most specific matching entry wins. Returns the owning list
 * object as given (extra fields pass through).
 */
export function resolvePrice<T extends { effectiveFrom: number; currency: string; models: ModelPriceConfig[] }>(
  lists: ReadonlyArray<T>,
  timestamp: number,
  provider: string | null,
  model: string | null,
): { list: T; entry: ModelPriceConfig } | null {
  let applicable: T | null = null;
  for (const list of lists) {
    if (list.effectiveFrom > timestamp) continue;
    if (applicable === null || list.effectiveFrom > applicable.effectiveFrom) applicable = list;
  }
  if (applicable === null) return null;
  let best: { entry: ModelPriceConfig; rank: number } | null = null;
  for (const entry of applicable.models) {
    const rank = specificity(entry, provider, model);
    if (rank < 0) continue;
    if (best === null || rank > best.rank) best = { entry, rank };
  }
  if (best === null) return null;
  return { list: applicable, entry: best.entry };
}

/** Integer micro currency units for one token category; 0 when unpriced. */
export function categoryMicro(tokens: number | null, pricePerMillion: number | undefined): number {
  if (tokens === null || tokens <= 0 || pricePerMillion === undefined) return 0;
  return Math.round(tokens * pricePerMillion);
}
