/**
 * Full client render drive (ad hoc, no browser): a miniature React-like
 * renderer with working useState/useEffect/useMemo/useSyncExternalStore that
 * invokes the real component functions from client/index.js, feeds stubbed
 * fetch data, triggers the tab buttons, and reports the exact throw with a
 * stack if anything crashes. Companion of scripts/smoke-client.mjs.
 *
 * Usage: node scripts/render-client.mjs
 */

import assert from 'node:assert/strict';
import { pathToFileURL } from 'node:url';
import { resolve } from 'node:path';

// --------------------------------------------------------------- stub DOM

const loads = [];
const styleTags = [];
globalThis.window = {
  __ModuleLoader__: { load(def) { loads.push(def); } },
  setInterval: () => 0,
  clearInterval: () => {},
  setTimeout: () => 0,
};
globalThis.document = {
  createElement() {
    return { dataset: {}, style: {}, textContent: '', remove() {} };
  },
  head: { appendTag: true, appendChild(tag) { styleTags.push(tag); } },
};

// ---------------------------------------------------------- stub fetch API

function trendPoint(day, requests, total) {
  return {
    day, requests,
    inputTokens: Math.round(total * 0.03), outputTokens: Math.round(total * 0.05),
    cacheReadTokens: Math.round(total * 0.9), cacheWriteTokens: 0,
    reasoningTokens: 0, totalTokens: total,
    cacheHitRate: 0.9, avgFirstTokenMs: 900, avgDurationMs: 5000, errorCount: 0,
  };
}

const trendPoints = Array.from({ length: 30 }, (_, i) => {
  const day = new Date(2026, 10, 10 - 29 + i);
  const iso = `${day.getFullYear()}-${String(day.getMonth() + 1).padStart(2, '0')}-${String(day.getDate()).padStart(2, '0')}`;
  return i % 7 === 3 ? trendPoint(iso, 40 + i, 2_000_000 + i * 1000) : trendPoint(iso, 0, 0);
});

const record = (n) => ({
  requestId: `session-x:${n}`, sessionId: 'session-x', seq: n, turn: 1, step: n,
  parentSessionId: null, origin: null, isSeed: 0, cwd: 'C:\\ws',
  provider: 'glm', model: 'glm-5.3', kind: 'chat', timestamp: 1794280000000 + n * 1000,
  inputTokens: 1000 + n, outputTokens: 500, cacheReadTokens: 9000, cacheWriteTokens: 0,
  reasoningTokens: null, totalTokens: 10500 + n, durationMs: 4000, firstTokenLatencyMs: 800,
  finishReason: null, errorCode: n === 3 ? 'SERVER' : null, errorStatus: null,
  errorMessage: n === 3 ? 'boom' : null, rawUsage: null, sourceEvent: 'assistant/message',
});

let costsConfigured = false;

function payloadFor(path) {
  if (path.startsWith('/summary')) {
    return {
      totals: { requests: 600, inputTokens: 2_000_000, outputTokens: 900_000, cacheReadTokens: 60_000_000, cacheWriteTokens: 0, reasoningTokens: 0, totalTokens: 63_000_000, cacheHitRate: 0.97, durationMsTotal: 0, durationMsCount: 0, firstTokenMsTotal: 0, firstTokenMsCount: 0 },
      today: { requests: 299, inputTokens: 1_000_000, outputTokens: 300_000, cacheReadTokens: 45_000_000, cacheWriteTokens: 0, reasoningTokens: 0, totalTokens: 47_000_000, cacheHitRate: 0.97, durationMsTotal: 0, durationMsCount: 0, firstTokenMsTotal: 0, firstTokenMsCount: 0 },
      byModel: [], byKind: [], sessions: [], ledger: { records: 600, firstTimestamp: 1, lastTimestamp: 2 },
      costs: costsConfigured ? [{ currency: 'USD', requests: 590, totalMicro: 12_345_678, missingCount: 1 }] : null,
    };
  }
  if (path.startsWith('/costs')) {
    if (!costsConfigured) return { configured: false };
    return {
      configured: true,
      byCurrency: [{ currency: 'USD', requests: 590, totalMicro: 12_345_678, missingCount: 1 }],
      byModel: [{
        provider: 'glm', model: 'glm-5.3', key: 'glm/glm-5.3', currency: 'USD',
        requests: 500, totalTokens: 61_000_000, totalMicro: 12_000_000, missingCount: 1,
        price: { input: 1.1, output: 4.4, cacheRead: 0.11 },
      }],
      byDay: [{ day: '2026-11-10', currency: 'USD', totalMicro: 500_000 }],
      coverage: { totalRequests: 600, pricedRequests: 590 },
    };
  }
  if (path.startsWith('/context')) {
    if (path.includes('sessionId=')) {
      return {
        sessionId: 'session-x-1234567890',
        samples: Array.from({ length: 12 }, (_, i) => ({
          seq: 10 + i * 7,
          timestamp: 1794280000000 + i * 60_000,
          provider: 'glm', model: 'glm-5.3',
          contextTokens: 20_000 + i * 9_000,
          contextWindow: 1_000_000,
          requestId: `s:${i}`,
        })),
      };
    }
    return {
      sessions: [{
        sessionId: 'session-x-1234567890', title: 'Verify dashboard rendering', origin: null, parentSessionId: null,
        provider: 'glm', model: 'glm-5.3',
        contextTokens: 119_000, peakTokens: 190_000, contextWindow: 1_000_000,
        timestamp: 1794280000000, compactions: 1, requests: 42,
      }],
    };
  }
  if (path.startsWith('/trend')) {
    if (path.includes('by=provider') || path.includes('by=model')) {
      const by = path.includes('by=provider') ? 'provider' : 'model';
      return {
        by,
        series: [
          { key: by === 'provider' ? 'glm' : 'glm/glm-5.3', points: trendPoints.map((p) => ({ day: p.day, totalTokens: Math.round(p.totalTokens * 0.8) })) },
          { key: by === 'provider' ? 'deepseek-account' : 'deepseek-account/deepseek-flash', points: trendPoints.map((p) => ({ day: p.day, totalTokens: Math.round(p.totalTokens * 0.2) })) },
        ],
      };
    }
    return { by: 'all', points: trendPoints };
  }
  if (path.startsWith('/breakdown')) {
    if (path.includes('by=provider')) {
      return {
        dim: 'provider',
        rows: [
          { key: 'glm', provider: 'glm', model: null, requests: 500, totalTokens: 61_000_000 },
          { key: 'deepseek-account', provider: 'deepseek-account', model: null, requests: 90, totalTokens: 11_000_000 },
        ],
      };
    }
    return {
      dim: 'model',
      rows: [{
        key: 'glm/glm-5.3', provider: 'glm', model: 'glm-5.3', kind: 'chat',
        requests: 500, inputTokens: 1_900_000, outputTokens: 800_000, cacheReadTokens: 58_000_000,
        cacheWriteTokens: 0, reasoningTokens: 0, totalTokens: 61_000_000, cacheHitRate: 0.97,
        avgFirstTokenMs: 850, errorCount: 1, lastTimestamp: 1794280000000,
      }],
    };
  }
  if (path.startsWith('/records')) {
    return { items: Array.from({ length: 10 }, (_, i) => record(i + 1)), total: 42 };
  }
  if (path.startsWith('/sessions')) {
    return {
      items: [{
        sessionId: 'session-x-1234567890', createdAt: 1794280000000, cwd: 'C:\\ws\\proj',
        origin: 'subagent', parentSessionId: 'session-parent', requests: 30,
        inputTokens: 224_258, outputTokens: 19_562, cacheReadTokens: 2_538_176,
        cacheWriteTokens: 0, totalTokens: 2_781_996, errorCount: 1,
        firstTimestamp: 1794280000000, lastTimestamp: 1794280100000,
      }],
      total: 1,
    };
  }
  throw new Error(`unexpected fetch ${path}`);
}

const fetchedUrls = [];
let importedBody = null;
const suggestFixture = {
  source: 'openrouter',
  fetchedAt: 1794280000000,
  suggestions: [
    { provider: 'glm', model: 'glm-5.3', requests: 500, tokens: 61_000_000, matchId: 'z-ai/glm-5.3', matchName: 'GLM 5.3', matchQuality: 'suffix', input: 0.5, output: 1.5, cacheRead: 0.05, cacheWrite: 0.7, checked: true },
    { provider: 'deepseek-account', model: 'deepseek-flash', requests: 90, tokens: 11_000_000, matchId: 'deepseek/deepseek-flash', matchName: 'DeepSeek Flash', matchQuality: 'exact', input: 0.27, output: 1.1, cacheRead: 0.007, cacheWrite: null, checked: true },
    { provider: 'gpt', model: 'gpt-6.1-sol', requests: 10, tokens: 8630, matchId: null, matchName: null, matchQuality: null, input: null, output: null, cacheRead: null, cacheWrite: null, checked: false },
  ],
};
globalThis.fetch = (url, options) => {
  fetchedUrls.push(url);
  const parsed = new URL(url, 'http://x');
  const subPath = parsed.pathname.replace(/^\/dsh-usage-center\/v1/, '') + parsed.search;
  if (options?.method === 'POST') {
    if (subPath === '/prices/suggest') {
      return Promise.resolve({ ok: true, json: () => Promise.resolve(suggestFixture) });
    }
    if (subPath === '/prices/import') {
      importedBody = JSON.parse(options.body);
      costsConfigured = true;
      return Promise.resolve({ ok: true, json: () => Promise.resolve({ ok: true, imported: importedBody.models.length }) });
    }
    return Promise.resolve({ ok: false, status: 404, json: () => Promise.resolve({ error: 'not found' }) });
  }
  return Promise.resolve({ ok: true, json: () => Promise.resolve(payloadFor(subPath)) });
};

// ----------------------------------------------------------- fake React

const instances = new Map(); // path -> { hooks: [], i: 0 }
let current = null;
let dirty = false;
let renderDepth = 0;

function useStateFake(init) {
  assert.ok(current !== null, 'useState outside component');
  const slot = current.hooks[current.i] ??= { value: typeof init === 'function' ? init() : init };
  current.i += 1;
  return [slot.value, (update) => {
    slot.value = typeof update === 'function' ? update(slot.value) : update;
    dirty = true;
  }];
}

const pendingEffects = [];

function useEffectFake(fn) {
  assert.ok(current !== null, 'useEffect outside component');
  current.hooks[current.i] = { effect: fn };
  current.i += 1;
  pendingEffects.push(fn);
}

function useMemoFake(fn) {
  assert.ok(current !== null, 'useMemo outside component');
  const slot = current.hooks[current.i] ??= {};
  current.i += 1;
  if (!('value' in slot)) slot.value = fn();
  return slot.value;
}

function useSyncExternalStoreFake(subscribe, getSnapshot) {
  assert.ok(current !== null, 'useSyncExternalStore outside component');
  const slot = current.hooks[current.i] ??= { unsub: undefined };
  current.i += 1;
  if (slot.unsub === undefined) slot.unsub = subscribe(() => { dirty = true; });
  return getSnapshot();
}

const fakeReact = {
  createElement(type, props, ...children) {
    const merged = { ...(props ?? {}) };
    if (children.length > 0) {
      merged.children = children.length === 1 ? children[0] : children;
    }
    return { type, props: merged };
  },
  useState: useStateFake,
  useEffect: useEffectFake,
  useMemo: useMemoFake,
  useSyncExternalStore: useSyncExternalStoreFake,
};

// ------------------------------------------------------------- mini render

function renderElement(el, path) {
  if (el === null || el === undefined || el === false || el === true) return null;
  if (Array.isArray(el)) {
    return el.map((child, index) => renderElement(child, `${path}/${index}`));
  }
  if (typeof el === 'string' || typeof el === 'number') return { text: String(el), path };
  assert.ok(typeof el === 'object' && typeof el.type !== 'undefined', `bad element at ${path}`);
  const { type, props } = el;
  if (typeof type === 'function') {
    const inst = instances.get(path) ?? { hooks: [], i: 0 };
    instances.set(path, inst);
    inst.i = 0;
    const prev = current;
    current = inst;
    let output;
    try {
      output = type(props);
    } finally {
      current = prev;
    }
    renderDepth += 1;
    try {
      return renderElement(output, path);
    } finally {
      renderDepth -= 1;
    }
  }
  const children = renderElement(props.children ?? null, `${path}/${String(type)}`);
  return { tag: String(type), props, children, path };
}

function collectNodes(node, out = []) {
  if (node === null || node === undefined) return out;
  if (Array.isArray(node)) {
    for (const item of node) collectNodes(item, out);
    return out;
  }
  out.push(node);
  if (node.children !== undefined) collectNodes(node.children, out);
  return out;
}

function textOf(node) {
  return collectNodes(node).map((n) => n.text ?? '').join('');
}

function findButtonWithText(root, label) {
  return collectNodes(root).find(
    (n) => n.tag === 'button' && textOf(n).includes(label) && typeof n.props.onClick === 'function',
  );
}

const flushMicrotasks = async () => {
  for (let i = 0; i < 10; i += 1) await Promise.resolve();
};

// ------------------------------------------------------------------ drive

const registrations = [];
const ctx = {
  locale: {
    register: () => () => {},
    subscribe: () => () => {},
    getSnapshot: () => ({ active: 'zh-CN' }),
  },
  slots: {
    inject: (slotKey, callback) => { registrations.push([slotKey, callback()]); return () => {}; },
    register: (options, component) => ({ options, component }),
  },
  effect: () => {},
  get: (name) => (name === 'layout' ? { selectPanel() {} } : undefined),
};

await import(pathToFileURL(resolve('client/index.js')).href);
const def = loads[0];
const mod = def.factory((name) => {
  if (name === 'react') return fakeReact;
  throw new Error(`unexpected require("${name}")`);
});
mod.apply(ctx);

const main = registrations.find(([key]) => key === 'main');
assert.ok(main !== undefined, 'main registration missing');

function renderDashboard() {
  return renderElement(main[1].component(), 'main');
}

let tree = renderDashboard();
const settle = async () => {
  for (let round = 0; round < 6; round += 1) {
    while (pendingEffects.length > 0) pendingEffects.splice(0).forEach((fn) => fn());
    await flushMicrotasks();
    if (!dirty) break;
    dirty = false;
    tree = renderDashboard();
  }
};
await settle();

// Overview rendered with data.
const overviewText = textOf(tree);
assert.match(overviewText, /用量中心/, 'header title rendered');
assert.match(overviewText, /请求总数/, 'stat cards rendered');
assert.match(overviewText, /glm\/glm-5\.3/, 'model table rendered');

// Drive every tab via its real button.
const clickTab = async (label) => {
  const button = findButtonWithText(tree, label);
  assert.ok(button !== undefined, `tab button "${label}" found`);
  button.props.onClick();
  dirty = true;
  await settle();
  tree = renderDashboard();
};
for (const label of ['请求', '台账', '费用', '上下文', '总览', '请求']) {
  await clickTab(label);
}

assert.match(textOf(tree), /上一页/, 'requests pager rendered');

// Requests filters: provider/model dropdowns populated from ledger facets.
const filterSelects = collectNodes(tree).filter((n) => n.tag === 'select');
assert.ok(filterSelects.length >= 3, 'provider/model/kind dropdowns rendered');
const filterSelectText = filterSelects.map((s) => textOf(s)).join('|');
assert.match(filterSelectText, /glm-5\.3/, 'model options populated');
assert.match(filterSelectText, /deepseek-account/, 'provider options populated');

// Costs (unconfigured): unified table with per-category price columns ("–").
await clickTab('费用');
assert.match(textOf(tree), /模型用量/, 'unconfigured costs table rendered');
assert.match(textOf(tree), /输入 \/1M/, 'input price column present');
assert.match(textOf(tree), /输出 \/1M/, 'output price column present');
assert.match(textOf(tree), /缓存读 \/1M/, 'cache-read price column present');

// Costs (configured): estimate cards + labeled price cells.
costsConfigured = true;
await clickTab('总览');
await clickTab('费用');
assert.match(textOf(tree), /USD/, 'configured cost view rendered');
assert.match(textOf(tree), /1\.10/, 'configured price cell rendered');

// Reference-price import: explicit button, per-row confirmation, POST only
// the checked rows, notice after import.
costsConfigured = false;
await clickTab('总览');
await clickTab('费用');
const suggestButton = findButtonWithText(tree, '参考价');
assert.ok(suggestButton !== undefined, 'suggest button rendered');
suggestButton.props.onClick();
dirty = true;
await settle();
tree = renderDashboard();
assert.match(textOf(tree), /导入参考价/, 'suggest modal rendered');
assert.match(textOf(tree), /OpenRouter/, 'source line rendered');
assert.match(textOf(tree), /z-ai\/glm-5\.3/, 'suggestion match rendered');
assert.match(textOf(tree), /无匹配/, 'unmatched row rendered');
const boxes = collectNodes(tree).filter((n) => n.tag === 'input' && n.props.type === 'checkbox');
assert.equal(boxes.length, 3, 'one checkbox per suggestion');
assert.equal(boxes[2].props.disabled, true, 'unmatched row disabled');
boxes[1].props.onClick(); // uncheck deepseek-flash
dirty = true;
await settle();
tree = renderDashboard();
const importButton = findButtonWithText(tree, '导入所选');
assert.ok(importButton !== undefined, 'import button rendered');
assert.match(textOf(importButton), /\(1\)/, 'one row selected after unchecking');
importButton.props.onClick();
dirty = true;
await settle();
tree = renderDashboard();
assert.ok(importedBody !== null, 'import request posted');
assert.equal(importedBody.models.length, 1, 'only the checked row posted');
assert.equal(importedBody.models[0].model, 'glm-5.3');
assert.equal(importedBody.models[0].cacheWrite, 0.7);
assert.match(textOf(tree), /参考价已写入配置/, 'imported notice rendered');

// Context monitor: sessions table (with title), drill into the series view.
await clickTab('上下文');
assert.match(textOf(tree), /glm-5\.3/, 'context sessions rendered');
assert.match(textOf(tree), /Verify dashboard rendering/, 'session title rendered');
assert.match(textOf(tree), /峰值/, 'peak column rendered');
const contextRow = collectNodes(tree).find((n) => n.tag === 'tr' && typeof n.props.onClick === 'function');
assert.ok(contextRow !== undefined, 'context row clickable');
contextRow.props.onClick();
dirty = true;
await settle();
tree = renderDashboard();
assert.match(textOf(tree), /seq 10/, 'context series chart rendered');
assert.match(textOf(tree), /所选会话/, 'detail water cards bound to the clicked session');
assert.match(textOf(tree), /峰值/, 'detail cards show peak watermark');
await clickTab('总览');

// Trend dimension switch: provider view renders per-key legend.
const providerChip = findButtonWithText(tree, '提供商');
assert.ok(providerChip !== undefined, 'trend dimension chips rendered');
providerChip.props.onClick();
dirty = true;
await settle();
tree = renderDashboard();
assert.match(textOf(tree), /deepseek-account/, 'provider series legend rendered');

// Switch back to "all" and render BEFORE the reload settles: the stale
// provider-shaped response must not crash the all-view interpretation.
const allChip = findButtonWithText(tree, '总览');
assert.ok(allChip !== undefined, 'all chip rendered');
allChip.props.onClick();
dirty = true;
tree = renderDashboard(); // no settle: one stale-response frame
assert.match(textOf(tree), /用量中心/, 'stale-response frame renders without crash');
await settle();
tree = renderDashboard();

// Stacked bars must express magnitude: at least one segment taller than a
// hairline (the old Math.max(y1 - y0, 0.8) bug drew every bar 0.8px).
const barRects = collectNodes(tree).filter(
  (n) => n.tag === 'rect' && typeof n.props.height === 'number' && n.props.height > 5,
);
assert.ok(barRects.length > 0, `bar segments express magnitude (tallest: ${Math.max(...barRects.map((r) => r.props.height)).toFixed(1)}px)`);

// Chart paints must not contain color-mix(): this engine rejects it on SVG
// fill/stroke and paint falls back to black. Plain `var(--token, literal)`
// is fine (proven live: solid var-based series render colored).
const SVG_PAINTED = ['rect', 'line', 'circle', 'polyline', 'text'];
const paints = collectNodes(tree).filter((n) => SVG_PAINTED.includes(n.tag))
  .flatMap((n) => [n.props.style?.fill, n.props.style?.stroke])
  .filter((v) => typeof v === 'string' && v.length > 0);
assert.ok(paints.length > 0, 'chart paints present');
for (const paint of paints) {
  assert.ok(!paint.includes('color-mix('), `chart paint must not use color-mix(), got: ${paint}`);
}

// Ledger row click jumps to requests with a session filter.
await clickTab('台账');
const ledgerRow = collectNodes(tree).find((n) => n.tag === 'tr' && typeof n.props.onClick === 'function');
if (ledgerRow !== undefined) {
  ledgerRow.props.onClick();
  dirty = true;
  await settle();
  tree = renderDashboard();
  assert.match(textOf(tree), /上一页/, 'ledger row jumps to requests view');
}

console.log(`client render drive ok — ${fetchedUrls.length} api calls, tabs exercised`);
