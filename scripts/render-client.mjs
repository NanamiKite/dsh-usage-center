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

function payloadFor(path) {
  if (path.startsWith('/summary')) {
    return {
      totals: { requests: 600, inputTokens: 2_000_000, outputTokens: 900_000, cacheReadTokens: 60_000_000, cacheWriteTokens: 0, reasoningTokens: 0, totalTokens: 63_000_000, cacheHitRate: 0.97, durationMsTotal: 0, durationMsCount: 0, firstTokenMsTotal: 0, firstTokenMsCount: 0 },
      today: { requests: 299, inputTokens: 1_000_000, outputTokens: 300_000, cacheReadTokens: 45_000_000, cacheWriteTokens: 0, reasoningTokens: 0, totalTokens: 47_000_000, cacheHitRate: 0.97, durationMsTotal: 0, durationMsCount: 0, firstTokenMsTotal: 0, firstTokenMsCount: 0 },
      byModel: [], byKind: [], sessions: [], ledger: { records: 600, firstTimestamp: 1, lastTimestamp: 2 },
    };
  }
  if (path.startsWith('/trend')) return { points: trendPoints };
  if (path.startsWith('/breakdown')) {
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
globalThis.fetch = (url) => {
  fetchedUrls.push(url);
  const parsed = new URL(url, 'http://x');
  const subPath = parsed.pathname.replace(/^\/dsh-usage-center\/v1/, '') + parsed.search;
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
