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
/** Missing-price flags (bitmask over token categories). */
export const MISSING_INPUT = 1;
export const MISSING_OUTPUT = 2;
export const MISSING_CACHE_READ = 4;
export const MISSING_CACHE_WRITE = 8;
/** Priced retroactively (before the first list) under the opt-in mode. */
export const MISSING_RETRO = 16;
/**
 * Parse and validate one configured list. Returns null for a malformed list
 * (bad date, empty models, non-positive price); the caller skips it and
 * reports, rather than guessing an interpretation.
 */
export function normalizePriceList(input) {
    if (typeof input !== 'object' || input === null)
        return null;
    const raw = input;
    const currency = typeof raw.currency === 'string' ? raw.currency.trim().toUpperCase() : '';
    if (!/^[A-Z]{3}$/.test(currency))
        return null;
    const effectiveFrom = normalizeEffectiveFrom(raw.effectiveFrom);
    if (effectiveFrom === null)
        return null;
    if (!Array.isArray(raw.models) || raw.models.length === 0)
        return null;
    const models = [];
    for (const entry of raw.models) {
        if (typeof entry !== 'object' || entry === null)
            return null;
        const e = entry;
        const model = typeof e.model === 'string' ? e.model.trim() : '';
        if (model.length === 0)
            return null;
        const provider = typeof e.provider === 'string' && e.provider.trim().length > 0
            ? e.provider.trim()
            : undefined;
        const price = (value) => {
            if (typeof value !== 'number' || !Number.isFinite(value) || value < 0)
                return undefined;
            return value;
        };
        const normalized = { model };
        if (provider !== undefined)
            normalized.provider = provider;
        const inputPrice = price(e.input);
        const outputPrice = price(e.output);
        const cacheReadPrice = price(e.cacheRead);
        const cacheWritePrice = price(e.cacheWrite);
        if (inputPrice !== undefined)
            normalized.input = inputPrice;
        if (outputPrice !== undefined)
            normalized.output = outputPrice;
        if (cacheReadPrice !== undefined)
            normalized.cacheRead = cacheReadPrice;
        if (cacheWritePrice !== undefined)
            normalized.cacheWrite = cacheWritePrice;
        if (normalized.input === undefined && normalized.output === undefined &&
            normalized.cacheRead === undefined && normalized.cacheWrite === undefined) {
            return null; // an entry with no price at all is a config error
        }
        models.push(normalized);
    }
    const name = typeof raw.name === 'string' && raw.name.trim().length > 0
        ? raw.name.trim()
        : `${currency} @ ${new Date(effectiveFrom).toISOString()}`;
    const windows = normalizeWindows(raw.windows, raw.tz);
    if (windows === null)
        return null; // malformed windows (or zone) reject the list
    const list = { name, currency, effectiveFrom, models };
    if (windows !== undefined)
        list.windows = windows;
    return { ...list, hash: hashPriceList(list) };
}
const HH_MM = /^([01]\d|2[0-3]):([0-5]\d)$/;
function validZone(tz) {
    try {
        new Intl.DateTimeFormat('en-US', { timeZone: tz });
        return true;
    }
    catch {
        return false;
    }
}
/**
 * Parse and validate the optional daily windows. Rules: `HH:MM`, `0 <
 * multiplier <= 10`, wrap past midnight allowed, OVERLAP rejected (an
 * ambiguous row would otherwise pick a window by list order). The zone is
 * `tz` when given (must be valid IANA) and otherwise the configuring
 * machine's zone — resolved ONCE here so the stored value is reproducible
 * on machines in other zones. Returns undefined when no windows are
 * configured, null for any violation — the whole list is skipped rather
 * than guessed.
 */
export function normalizeWindows(input, tzInput) {
    if (input === undefined || input === null)
        return undefined;
    if (!Array.isArray(input) || input.length === 0)
        return null;
    let tz;
    if (tzInput === undefined || tzInput === null) {
        tz = Intl.DateTimeFormat().resolvedOptions().timeZone;
    }
    else if (typeof tzInput === 'string' && tzInput.trim().length > 0 && validZone(tzInput.trim())) {
        tz = tzInput.trim();
    }
    else {
        return null; // an invalid zone is a config error, never guessed
    }
    const entries = [];
    const covered = new Array(24 * 60).fill(false);
    const cover = (from, to) => {
        for (let m = from; m !== to; m = (m + 1) % 1440) {
            if (covered[m])
                return false;
            covered[m] = true;
        }
        return true;
    };
    for (const entry of input) {
        if (typeof entry !== 'object' || entry === null)
            return null;
        const e = entry;
        const fromMatch = typeof e.from === 'string' ? HH_MM.exec(e.from.trim()) : null;
        const toMatch = typeof e.to === 'string' ? HH_MM.exec(e.to.trim()) : null;
        if (fromMatch === null || toMatch === null)
            return null;
        if (typeof e.multiplier !== 'number' || !Number.isFinite(e.multiplier)
            || e.multiplier <= 0 || e.multiplier > 10) {
            return null;
        }
        const fromMin = Number(fromMatch[1]) * 60 + Number(fromMatch[2]);
        const toMin = Number(toMatch[1]) * 60 + Number(toMatch[2]);
        if (fromMin === toMin)
            return null; // zero-length window
        if (!cover(fromMin, toMin))
            return null; // overlap
        entries.push({ from: fromMatch[0], to: toMatch[0], multiplier: e.multiplier });
    }
    return { tz, entries };
}
const zoneFormatters = new Map();
/** Wall-clock (hour, minute) of `timestamp` in `tz`, via cached formatters. */
function hourMinuteOf(tz, timestamp) {
    let formatter = zoneFormatters.get(tz);
    if (formatter === undefined) {
        formatter = new Intl.DateTimeFormat('en-US', {
            timeZone: tz, hour: 'numeric', minute: 'numeric', hourCycle: 'h23',
        });
        zoneFormatters.set(tz, formatter);
    }
    const parts = formatter.formatToParts(new Date(timestamp));
    const hour = Number(parts.find((p) => p.type === 'hour')?.value ?? '0');
    const minute = Number(parts.find((p) => p.type === 'minute')?.value ?? '0');
    return { hour, minute };
}
/**
 * The window multiplier for one row: the wall-clock minute of its timestamp
 * IN THE LIST'S STORED ZONE (not the reading process's zone), against the
 * daily windows (wrap-aware). Outside every window → 1 (base rate).
 */
export function windowMultiplier(windows, timestamp) {
    if (windows === undefined || windows.entries.length === 0)
        return 1;
    const { hour, minute } = hourMinuteOf(windows.tz, timestamp);
    const clock = hour * 60 + minute;
    for (const w of windows.entries) {
        const from = HH_MM.exec(w.from);
        const to = HH_MM.exec(w.to);
        if (from === null || to === null)
            continue;
        const fromMin = Number(from[1]) * 60 + Number(from[2]);
        const toMin = Number(to[1]) * 60 + Number(to[2]);
        const inside = fromMin <= toMin
            ? clock >= fromMin && clock < toMin
            : clock >= fromMin || clock < toMin; // wraps midnight
        if (inside)
            return w.multiplier;
    }
    return 1;
}
/** Local `YYYY-MM-DD` (midnight) or epoch ms → epoch ms; null when invalid. */
export function normalizeEffectiveFrom(value) {
    if (typeof value === 'number' && Number.isFinite(value)) {
        // Outside the ECMAScript time range, Date methods throw — reject instead.
        if (Math.abs(value) > 8.64e15)
            return null;
        return Math.trunc(value);
    }
    if (typeof value === 'string') {
        const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value.trim());
        if (match !== null) {
            const year = Number(match[1]);
            const month = Number(match[2]);
            const day = Number(match[3]);
            const date = new Date(year, month - 1, day, 0, 0, 0, 0);
            // Read back: JS Date silently ROLLS overflow (2026-02-30 → March,
            // 2026-13-01 → next January). A rolled date is a config error, not a
            // silently shifted effective day.
            if (Number.isNaN(date.getTime())
                || date.getFullYear() !== year
                || date.getMonth() !== month - 1
                || date.getDate() !== day) {
                return null;
            }
            return date.getTime();
        }
    }
    return null;
}
function canonicalJson(value) {
    if (Array.isArray(value))
        return `[${value.map(canonicalJson).join(',')}]`;
    if (value !== null && typeof value === 'object') {
        const entries = Object.entries(value)
            .filter(([, v]) => v !== undefined)
            .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
        return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${canonicalJson(v)}`).join(',')}}`;
    }
    return JSON.stringify(value) ?? 'null';
}
function hashPriceList(list) {
    return createHash('sha256').update(canonicalJson(list)).digest('hex').slice(0, 32);
}
function specificity(entry, provider, model) {
    const providerOk = entry.provider === undefined || entry.provider === provider;
    const modelOk = entry.model === '*' || entry.model === model;
    if (!providerOk || !modelOk)
        return -1;
    const providerRank = entry.provider === undefined ? 0 : 1;
    const modelRank = entry.model === '*' ? 0 : 1;
    // Model exactness outranks provider exactness (the documented tier order):
    // wildcard-provider + exact model beats exact-provider + wildcard model.
    return modelRank * 2 + providerRank;
}
/**
 * The applicable entry for one request, or null when nothing prices it:
 * among the lists already in effect at `timestamp`, the newest wins; inside
 * that list the most specific matching entry wins. Returns the owning list
 * object as given (extra fields pass through).
 */
export function resolvePrice(lists, timestamp, provider, model) {
    let applicable = null;
    for (const list of lists) {
        if (list.effectiveFrom > timestamp)
            continue;
        if (applicable === null || list.effectiveFrom > applicable.effectiveFrom)
            applicable = list;
    }
    if (applicable === null)
        return null;
    let best = null;
    for (const entry of applicable.models) {
        const rank = specificity(entry, provider, model);
        if (rank < 0)
            continue;
        if (best === null || rank > best.rank)
            best = { entry, rank };
    }
    if (best === null)
        return null;
    return { list: applicable, entry: best.entry };
}
/** Integer micro currency units for one token category; 0 when unpriced. */
export function categoryMicro(tokens, pricePerMillion) {
    if (tokens === null || tokens <= 0 || pricePerMillion === undefined)
        return 0;
    return Math.round(tokens * pricePerMillion);
}
