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
/** USD-per-token (string or number) → USD per 1M tokens, 6-decimal rounded. */
export function perMillion(value) {
    if (typeof value === 'number') {
        if (!Number.isFinite(value) || value < 0)
            return null;
    }
    else if (typeof value === 'string' && value.length > 0) {
        const parsed = Number(value);
        if (!Number.isFinite(parsed) || parsed < 0)
            return null;
        return round6(parsed * 1e6);
    }
    else {
        return null;
    }
    return round6(value * 1e6);
}
function round6(v) {
    return Math.round(v * 1e6) / 1e6;
}
/**
 * Conservative version-separator key: a hyphen between two single digits
 * (each bounded by a non-digit or the string end) reads as a version dot —
 * `claude5-5` → `claude5.5`, `gemini-2-5-pro` → `gemini-2.5-pro`.
 * Everything else keeps its hyphens: letter segments (`deepseek-flash`),
 * multi-digit runs (dates `2024-01`, snapshots `gpt-4o-2024-11-20`, sizes
 * `glm-4-32b`). The comparison is key-equality on the whole id — no
 * substring guessing — so both sides must correspond beyond that one
 * separator.
 */
export function versionSeparatorKey(id) {
    return id.replace(/(^|[^0-9])([0-9])-([0-9])(?=[^0-9]|$)/g, '$1$2.$3');
}
/**
 * Best deterministic OpenRouter entry for one ledger pair, by tier
 * exact > suffix > fuzzy. The version-normalized tier is deliberately
 * NOT resolved here: it can be ambiguous, so it is reported separately
 * by normalizedMatches and the caller decides.
 * `deepseek-account` style provider names also try their first segment
 * (`deepseek`) so account-qualified providers still match exactly.
 */
export function matchOpenRouter(pair, models) {
    const raw = pair.model?.trim().toLowerCase();
    if (raw === undefined || raw.length === 0)
        return null;
    const model = raw;
    const providers = providerCandidates(pair.provider);
    let best = null;
    for (const candidate of models) {
        const id = candidate.id.toLowerCase();
        const quality = classify(id, candidate.name ?? null, model, providers);
        if (quality === null || quality === 'normalized')
            continue;
        // Same rank: prefer the shorter id so plain variants win over suffixed
        // variants (glm-5.3 over glm-5.3-flashx-legal) deterministically.
        const better = best === null
            || rank(quality) < rank(best.quality)
            || (rank(quality) === rank(best.quality) && id.length < best.model.id.length);
        if (better)
            best = { model: candidate, quality };
    }
    return best;
}
/**
 * Every catalog entry that matches only after version-separator
 * normalization, tiered: provider-aligned candidates (the full id,
 * provider segment included, reconciles with the ledger pair) strictly
 * outrank cross-provider tail matches, so an aligned candidate never has
 * to compete with same-name twins from other namespaces. Cross-provider
 * candidates are returned only when no aligned one exists. Consulted
 * when the deterministic tiers found nothing; more than one result still
 * means a manual pick (never auto-selected by id length or order).
 */
export function normalizedMatches(pair, models) {
    const raw = pair.model?.trim().toLowerCase();
    if (raw === undefined || raw.length === 0)
        return [];
    const providers = providerCandidates(pair.provider);
    const modelKey = versionSeparatorKey(raw);
    const aligned = [];
    const cross = [];
    for (const candidate of models) {
        const id = candidate.id.toLowerCase();
        if (classify(id, null, raw, providers) !== 'normalized')
            continue;
        const idKey = versionSeparatorKey(id);
        const isAligned = idKey === modelKey
            || providers.some((p) => idKey === versionSeparatorKey(`${p}/${raw}`));
        (isAligned ? aligned : cross).push(candidate);
    }
    return aligned.length > 0 ? aligned : cross;
}
function providerCandidates(provider) {
    if (provider === null || provider === undefined)
        return [];
    const p = provider.trim().toLowerCase();
    if (p.length === 0)
        return [];
    const first = p.split('-')[0] ?? p;
    return first !== p ? [p, first] : [p];
}
function classify(id, displayName, model, providers) {
    // A ledger model may itself be the full OpenRouter id
    // (provider "openrouter", model "anthropic/claude-sonnet-4").
    if (id === model)
        return 'exact';
    for (const p of providers) {
        if (id === `${p}/${model}`)
            return 'exact';
    }
    if (id.endsWith(`/${model}`))
        return 'suffix';
    const tail = id.slice(id.lastIndexOf('/') + 1);
    if (tail === model || tail.replaceAll(/[^a-z0-9.]/g, '') === model)
        return 'suffix';
    // Version-separator reconciliation: the whole body must correspond, the
    // only tolerated difference is single-digit hyphen ↔ dot.
    const modelKey = versionSeparatorKey(model);
    const tailKey = versionSeparatorKey(tail);
    const idKey = versionSeparatorKey(id);
    if (tailKey === modelKey
        || idKey === modelKey
        || providers.some((p) => idKey === versionSeparatorKey(`${p}/${model}`))) {
        return 'normalized';
    }
    const name = displayName?.toLowerCase() ?? '';
    if (name.includes(model) || tail.includes(model))
        return 'fuzzy';
    return null;
}
function rank(quality) {
    if (quality === 'exact')
        return 0;
    if (quality === 'suffix')
        return 1;
    if (quality === 'normalized')
        return 2;
    return 3;
}
/** Map every ledger pair to a suggestion row; best matches first-stable order. */
export function buildSuggestions(pairs, orModels) {
    return pairs.map((pair) => {
        const match = matchOpenRouter(pair, orModels);
        const pricingOf = (m) => m?.pricing ?? null;
        const pick = (pricing, key) => pricing === null ? null : perMillion(pricing[key]);
        // Layered matching: exact/suffix win outright; the normalized tier
        // outranks fuzzy but is never pre-checked, and multiple normalized
        // candidates are surfaced for a manual pick instead of being resolved
        // by id length or catalog order.
        const normalized = match === null || rank(match.quality) > rank('normalized')
            ? normalizedMatches(pair, orModels)
            : [];
        if (normalized.length > 0) {
            const toCandidate = (m) => {
                const pricing = pricingOf(m);
                return {
                    id: m.id,
                    input: pick(pricing, 'prompt'),
                    output: pick(pricing, 'completion'),
                    cacheRead: pick(pricing, 'input_cache_read'),
                    cacheWrite: pick(pricing, 'input_cache_write'),
                };
            };
            const candidates = normalized.map(toCandidate)
                .sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
            const [only] = candidates;
            const [onlyModel] = normalized;
            if (candidates.length === 1 && only !== undefined) {
                return {
                    provider: pair.provider,
                    model: pair.model ?? '',
                    requests: pair.requests,
                    tokens: pair.tokens,
                    matchId: only.id,
                    matchName: onlyModel?.name ?? null,
                    matchQuality: 'normalized',
                    normalizedCandidates: candidates,
                    input: only.input,
                    output: only.output,
                    cacheRead: only.cacheRead,
                    cacheWrite: only.cacheWrite,
                    checked: false,
                };
            }
            // Ambiguous: matchId stays null until the user picks one candidate.
            return {
                provider: pair.provider,
                model: pair.model ?? '',
                requests: pair.requests,
                tokens: pair.tokens,
                matchId: null,
                matchName: null,
                matchQuality: 'normalized',
                normalizedCandidates: candidates,
                input: null,
                output: null,
                cacheRead: null,
                cacheWrite: null,
                checked: false,
            };
        }
        const pricing = pricingOf(match?.model);
        const quality = match?.quality ?? null;
        return {
            provider: pair.provider,
            model: pair.model ?? '',
            requests: pair.requests,
            tokens: pair.tokens,
            matchId: match?.model.id ?? null,
            matchName: match?.model.name ?? null,
            matchQuality: quality,
            normalizedCandidates: [],
            input: pick(pricing, 'prompt'),
            output: pick(pricing, 'completion'),
            cacheRead: pick(pricing, 'input_cache_read'),
            cacheWrite: pick(pricing, 'input_cache_write'),
            checked: quality === 'exact' || quality === 'suffix',
        };
    });
}
