/**
 * Public price sources: fetch community/aggregator listings and turn them
 * into *suggestions* for the `prices` config.
 *
 * Design stance: fetched prices are reference data (what the aggregator
 * charges), never applied silently. The suggest endpoint matches ledger
 * models against a listing, reports the confidence of every match, and
 * emits ready-to-paste YAML; applying a price list stays a human decision
 * in the config, keeping config the single source of truth.
 */

/** One model's per-1M prices as listed by a source (USD). */
export interface SourcePriceEntry {
  /** Full source key, e.g. `z-ai/glm-5.3`. */
  key: string;
  provider: string;
  model: string;
  input?: number;
  output?: number;
  cacheRead?: number;
  cacheWrite?: number;
}

/**
 * Ledger provider id → source provider namespace. Identity-level mappings
 * only (same vendor, different naming); overridable via config
 * `priceAliases`.
 */
export const DEFAULT_PROVIDER_ALIASES: Readonly<Record<string, string>> = {
  glm: 'z-ai',
  'deepseek-account': 'deepseek',
  gpt: 'openai',
};

export interface LedgerModelRef {
  provider: string | null;
  model: string | null;
  requests: number;
}

export interface PriceMatch {
  provider: string | null;
  model: string | null;
  requests: number;
  /** Matched source key. */
  key: string;
  /** How the source key was derived. */
  confidence: 'alias' | 'exact' | 'model';
  entry: SourcePriceEntry;
}

/** Per-token USD string → per-1M price. */
function perMillion(value: unknown): number | undefined {
  if (typeof value !== 'string' && typeof value !== 'number') return undefined;
  const n = Number(value);
  if (!Number.isFinite(n) || n < 0) return undefined;
  return Math.round(n * 1e6 * 1e9) / 1e9;
}

/**
 * Normalize the OpenRouter model listing (`GET /api/v1/models`) into price
 * entries. Variant suffixes (`:free`, `:batch`, …) are skipped so the base
 * SKU matches.
 */
export function normalizeOpenRouter(json: unknown): SourcePriceEntry[] {
  if (typeof json !== 'object' || json === null) return [];
  const data = (json as { data?: unknown }).data;
  if (!Array.isArray(data)) return [];
  const entries: SourcePriceEntry[] = [];
  for (const item of data) {
    if (typeof item !== 'object' || item === null) continue;
    const raw = item as Record<string, unknown>;
    const id = typeof raw.id === 'string' ? raw.id : '';
    if (id.length === 0 || id.includes(':')) continue;
    const slash = id.indexOf('/');
    if (slash <= 0 || slash === id.length - 1) continue;
    const pricing = raw.pricing;
    if (typeof pricing !== 'object' || pricing === null) continue;
    const p = pricing as Record<string, unknown>;
    const entry: SourcePriceEntry = {
      key: id,
      provider: id.slice(0, slash),
      model: id.slice(slash + 1),
    };
    const input = perMillion(p.prompt);
    const output = perMillion(p.completion);
    const cacheRead = perMillion(p.input_cache_read);
    const cacheWrite = perMillion(p.input_cache_write);
    if (input !== undefined) entry.input = input;
    if (output !== undefined) entry.output = output;
    if (cacheRead !== undefined) entry.cacheRead = cacheRead;
    if (cacheWrite !== undefined) entry.cacheWrite = cacheWrite;
    if (entry.input === undefined && entry.output === undefined) continue;
    entries.push(entry);
  }
  return entries;
}

/**
 * Match ledger models against source entries.
 * - `alias`: provider mapped through the alias table, model exact;
 * - `exact`: provider as-is, model exact;
 * - `model`: model id unique across the source (provider-agnostic);
 * anything else stays unmatched — no fuzzy guessing.
 */
export function matchPrices(
  entries: ReadonlyArray<SourcePriceEntry>,
  ledger: ReadonlyArray<LedgerModelRef>,
  aliases: Readonly<Record<string, string>> = {},
): { matches: PriceMatch[]; unmatched: LedgerModelRef[] } {
  const byKey = new Map(entries.map((entry) => [entry.key, entry]));
  const byModel = new Map<string, SourcePriceEntry[]>();
  for (const entry of entries) {
    const list = byModel.get(entry.model) ?? [];
    list.push(entry);
    byModel.set(entry.model, list);
  }
  const aliasOf = (provider: string | null): string | null => {
    if (provider === null) return null;
    return aliases[provider] ?? DEFAULT_PROVIDER_ALIASES[provider] ?? provider;
  };
  const matches: PriceMatch[] = [];
  const unmatched: LedgerModelRef[] = [];
  for (const item of ledger) {
    if (item.model === null) {
      unmatched.push(item);
      continue;
    }
    const mapped = aliasOf(item.provider);
    if (mapped !== null && mapped !== item.provider) {
      const viaAlias = byKey.get(`${mapped}/${item.model}`);
      if (viaAlias !== undefined) {
        matches.push({ ...item, key: viaAlias.key, confidence: 'alias', entry: viaAlias });
        continue;
      }
    }
    if (item.provider !== null) {
      const exact = byKey.get(`${item.provider}/${item.model}`);
      if (exact !== undefined) {
        matches.push({ ...item, key: exact.key, confidence: 'exact', entry: exact });
        continue;
      }
    }
    const sameModel = byModel.get(item.model);
    if (sameModel !== undefined && sameModel.length === 1) {
      const unique = sameModel[0];
      if (unique !== undefined) {
        matches.push({ ...item, key: unique.key, confidence: 'model', entry: unique });
        continue;
      }
    }
    unmatched.push(item);
  }
  return { matches, unmatched };
}

function yamlNumber(value: number): string {
  return String(value);
}

/**
 * Ready-to-paste `prices` config for the matched models. Only categories the
 * source provides are emitted; the rest stay unset (unpriced), never guessed.
 */
export function suggestionYaml(
  matches: ReadonlyArray<PriceMatch>,
  options: { name: string; currency: string; effectiveFrom: string },
): string {
  const lines: string[] = [];
  lines.push(`- name: ${options.name}`);
  lines.push(`  currency: ${options.currency}`);
  lines.push(`  effectiveFrom: '${options.effectiveFrom}'`);
  lines.push('  models:');
  for (const match of matches) {
    const fields: string[] = [`model: ${match.model}`];
    if (match.provider !== null) fields.push(`provider: ${match.provider}`);
    if (match.entry.input !== undefined) fields.push(`input: ${yamlNumber(match.entry.input)}`);
    if (match.entry.output !== undefined) fields.push(`output: ${yamlNumber(match.entry.output)}`);
    if (match.entry.cacheRead !== undefined) fields.push(`cacheRead: ${yamlNumber(match.entry.cacheRead)}`);
    if (match.entry.cacheWrite !== undefined) fields.push(`cacheWrite: ${yamlNumber(match.entry.cacheWrite)}`);
    lines.push(`    - { ${fields.join(', ')} }`);
  }
  return lines.join('\n');
}

/** Local `YYYY-MM-DD` for `effectiveFrom`. */
export function localToday(): string {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}
