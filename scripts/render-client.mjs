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
const docListeners = {}; // mousedown registry for outside-click dismissal
globalThis.document = {
  createElement() {
    return { dataset: {}, style: {}, textContent: '', remove() {} };
  },
  head: { appendTag: true, appendChild(tag) { styleTags.push(tag); } },
  addEventListener: (type, fn) => { (docListeners[type] ??= []).push(fn); },
  removeEventListener: (type, fn) => {
    const list = docListeners[type] ?? [];
    const i = list.indexOf(fn);
    if (i >= 0) list.splice(i, 1);
  },
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
let costsZeroPriced = false;

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
    if (costsZeroPriced) {
      // Configured, but the list starts today: history unpriced, nothing guessed.
      return {
        configured: true, effectiveFrom: 1794280000000,
        byCurrency: [], byModel: [], byDay: [],
        coverage: { totalRequests: 600, pricedRequests: 0, retroPriced: 0 },
      };
    }
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
      coverage: { totalRequests: 600, pricedRequests: 590, retroPriced: 12 },
    };
  }
  if (path.startsWith('/context')) {
    if (path.includes('sessionId=')) {
      const id = decodeURIComponent(path.split('sessionId=')[1] ?? '');
      if (id === 'session-dense') {
        // 130 samples ≈ 5.1px spacing: unknown → 200k → unknown windows.
        const t0 = 1794280000000;
        const obs = [];
        for (let i = 0; i < 130; i += 1) {
          const window = i < 10 || i >= 120 ? null : 200_000;
          const base = {
            requestId: `session-dense:${i + 1}`, seq: i + 1, timestamp: t0 + i * 30_000,
            provider: 'glm', model: 'glm-5.3', inputTokens: 5_000 + i * 40, missingMask: 0,
            contextWindow: window, inputRaw: 5_000 + i * 40, cacheRead: 0, cacheWrite: 0,
            outputTokens: 400, durationMs: 3_000, firstTokenLatencyMs: 700,
            errorCode: null, costMicro: null, costCurrency: null,
          };
          if (i === 60) {
            obs.push({
              ...base, kind: 'compaction', inputTokens: null, inputRaw: null,
              cacheRead: null, cacheWrite: null, outputTokens: 800, durationMs: 6_000,
            });
          } else {
            obs.push({ ...base, kind: 'chat' });
          }
        }
        return { sessionId: 'session-dense', totalRequests: 130, observations: obs };
      }
      const t0 = 1794280000000;
      const chat = (seq, inputTokens, over = {}) => ({
        requestId: `session-x-1234567890:${seq}`, seq, timestamp: t0 + seq * 60_000,
        provider: 'glm', model: 'glm-5.3', kind: 'chat', inputTokens, missingMask: 0,
        contextWindow: 1_000_000, inputRaw: Math.round(inputTokens * 0.1),
        cacheRead: inputTokens - Math.round(inputTokens * 0.1), cacheWrite: 0,
        outputTokens: 500, durationMs: 4_000, firstTokenLatencyMs: 800,
        errorCode: null, costMicro: null, costCurrency: null, ...over,
      });
      const compaction = (seq, over = {}) => ({
        requestId: `session-x-1234567890:${seq}`, seq, timestamp: t0 + seq * 60_000,
        provider: 'glm', model: 'glm-5.3-flash', kind: 'compaction', inputTokens: null,
        missingMask: 0, contextWindow: 1_000_000, inputRaw: null, cacheRead: null,
        cacheWrite: null, outputTokens: 900, durationMs: 8_500, firstTokenLatencyMs: null,
        errorCode: null, costMicro: 300, costCurrency: 'USD', ...over,
      });
      return {
        sessionId: 'session-x-1234567890',
        totalRequests: 42,
        observations: [
          chat(10, 20_000),
          chat(11, 30_000, { missingMask: 1, inputRaw: null }),
          chat(12, 45_000, { model: 'glm-5.3-flash', costMicro: 1_500, costCurrency: 'USD' }),
          compaction(13),
          chat(14, 8_000, { model: 'glm-5.3-flash', contextWindow: 2_000_000 }),
          {
            requestId: 'session-x-1234567890:15', seq: 15, timestamp: t0 + 15 * 60_000,
            provider: 'glm', model: 'glm-5.3-flash', kind: 'attempt', inputTokens: 9_000,
            missingMask: 0, contextWindow: 2_000_000, inputRaw: 900, cacheRead: 8_100,
            cacheWrite: 0, outputTokens: null, durationMs: 1_200, firstTokenLatencyMs: null,
            errorCode: 'SERVER', costMicro: null, costCurrency: null,
          },
          chat(16, 9_500, { model: 'glm-5.3-flash', contextWindow: 2_000_000 }),
          compaction(17, { durationMs: null, costMicro: null, costCurrency: null, contextWindow: 2_000_000 }),
          chat(18, 3_000, { model: 'glm-5.3-flash', contextWindow: 2_000_000 }),
        ],
      };
    }
    return {
      sessions: [{
        sessionId: 'session-x-1234567890', title: 'Verify dashboard rendering', origin: null, parentSessionId: null,
        model: 'glm-5.3',
        lastInput: 119_000, lastInputAt: 1794280000000, lastRequestId: 'session-x-1234567890:87',
        prevInput: 90_000, delta: 29_000, modelSwitched: false,
        maxInput: 190_000, observedRequests: 40, totalRequests: 42,
        compactions: 1, contextWindow: 1_000_000, lastObsAt: 1794280000000,
      }, {
        sessionId: 'session-dense', title: 'Dense series', origin: null, parentSessionId: null,
        model: 'glm-5.3',
        lastInput: 9_160, lastInputAt: 1794280000000, lastRequestId: 'session-dense:130',
        prevInput: 9_120, delta: 40, modelSwitched: false,
        maxInput: 9_160, observedRequests: 129, totalRequests: 130,
        compactions: 1, contextWindow: null, lastObsAt: 1794280000000,
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
      items: [
        {
          sessionId: 'session-main', createdAt: 1794270000000, cwd: 'C:\\ws',
          title: 'Verify dashboard rendering',
          origin: null, parentSessionId: null, requests: 90,
          inputTokens: 200_000, outputTokens: 15_000, cacheReadTokens: 2_000_000,
          cacheWriteTokens: 0, totalTokens: 2_215_000, errorCount: 0,
          firstTimestamp: 1794270000000, lastTimestamp: 1794280100000,
        },
        {
          sessionId: 'session-x-1234567890', createdAt: 1794280000000, cwd: 'C:\\ws\\proj',
          title: 'Verify dashboard rendering (run 2)',
          origin: 'subagent', parentSessionId: 'session-main', requests: 30,
          inputTokens: 224_258, outputTokens: 19_562, cacheReadTokens: 2_538_176,
          cacheWriteTokens: 0, totalTokens: 2_781_996, errorCount: 1,
          firstTimestamp: 1794280000000, lastTimestamp: 1794280100000,
        },
        {
          sessionId: 'session-dense', createdAt: 1794280000000, cwd: 'C:\\ws\\dense',
          title: 'Dense series',
          origin: null, parentSessionId: null, requests: 130,
          inputTokens: 815_000, outputTokens: 51_600, cacheReadTokens: 0,
          cacheWriteTokens: 0, totalTokens: 866_600, errorCount: 0,
          firstTimestamp: 1794280000000, lastTimestamp: 1794284000000,
        },
      ],
      total: 3,
    };
  }
  throw new Error(`unexpected fetch ${path}`);
}

const fetchedUrls = [];
let importedBody = null;
const suggestFixture = {
  source: 'openrouter',
  fetchedAt: 1794280000000,
  historyBefore: { count: 120, first: 1794280000000 - 5 * 86_400_000 },
  suggestions: [
    { provider: 'glm', model: 'glm-5.3', requests: 500, tokens: 61_000_000, matchId: 'z-ai/glm-5.3', matchName: 'GLM 5.3', matchQuality: 'suffix', input: 0.5, output: 1.5, cacheRead: 0.05, cacheWrite: 0.7, checked: true, normalizedCandidates: [] },
    { provider: 'deepseek-account', model: 'deepseek-flash', requests: 90, tokens: 11_000_000, matchId: 'deepseek/deepseek-flash', matchName: 'DeepSeek Flash', matchQuality: 'exact', input: 0.27, output: 1.1, cacheRead: 0.007, cacheWrite: null, checked: true, normalizedCandidates: [] },
    { provider: 'gpt', model: 'gpt-6.1-sol', requests: 10, tokens: 8630, matchId: null, matchName: null, matchQuality: null, input: null, output: null, cacheRead: null, cacheWrite: null, checked: false, normalizedCandidates: [] },
    { provider: 'anthropic', model: 'claude5-5', requests: 8, tokens: 900_000, matchId: 'anthropic/claude5.5', matchName: 'Claude 5.5', matchQuality: 'normalized', normalizedCandidates: [{ id: 'anthropic/claude5.5', input: 3, output: 15, cacheRead: 0.3, cacheWrite: 3.75 }], input: 3, output: 15, cacheRead: 0.3, cacheWrite: 3.75, checked: false },
    { provider: 'my-router', model: 'qwen-4-6', requests: 2, tokens: 40_000, matchId: null, matchName: null, matchQuality: 'normalized', normalizedCandidates: [
      { id: 'openrouter/qwen-4.6', input: 0.5, output: 2.2, cacheRead: null, cacheWrite: null },
      { id: 'qwenlab/qwen-4.6', input: 0.6, output: 2.4, cacheRead: null, cacheWrite: null },
    ], input: null, output: null, cacheRead: null, cacheWrite: null, checked: false },
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
  useRef(init) {
    assert.ok(current !== null, 'useRef outside component');
    const slot = current.hooks[current.i] ??= { current: init };
    current.i += 1;
    return slot;
  },
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
  const node = { tag: String(type), props, children, path };
  // Host refs and virtual containment, so outside-click logic is testable.
  if (props.ref !== null && typeof props.ref === 'object') props.ref.current = node;
  node.contains = (target) => target === node || collectNodes(node).includes(target);
  return node;
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

// Background refresh keeps content mounted: the 15s poll used to swap the
// panel for a loading view, which collapsed the scroll container and threw
// a scrolled-down user back to the top.
const refreshBtn = findButtonWithText(tree, '⟳');
assert.ok(refreshBtn !== undefined, 'header refresh button present');
refreshBtn.props.onClick();
dirty = true;
tree = renderDashboard(); // registers the new-tick effect closures
pendingEffects.splice(0).forEach((fn) => fn()); // the fetch starts
tree = renderDashboard(); // the frame while the request is in flight
assert.match(textOf(tree), /请求总数/, 'content stays mounted during a background refresh');
assert.ok(!textOf(tree).includes('加载中'), 'no loading flash on a background poll');
await settle();
tree = renderDashboard();
assert.match(textOf(tree), /请求总数/, 'content intact after the refresh settles');

// Drive every tab via its real button.
const clickTab = async (label) => {
  const button = findButtonWithText(tree, label);
  assert.ok(button !== undefined, `tab button "${label}" found`);
  button.props.onClick();
  dirty = true;
  await settle();
  tree = renderDashboard();
};
for (const label of ['请求', '台账', '费用', '总览', '请求']) {
  await clickTab(label);
}

assert.match(textOf(tree), /上一页/, 'requests pager rendered');

// Requests filters: provider/model/kind pickers share the session picker's
// chrome and open exclusively; the session picker loads nothing until
// opened (no eager context overview).
const pickerBtns = () => collectNodes(tree).filter(
  (n) => n.tag === 'button' && n.props.className === 'duc-pickerbtn');
const pickerBtn = () => pickerBtns()[3]; // provider / model / kind / session
assert.equal(pickerBtns().length, 4, 'four picker buttons rendered (provider/model/kind/session)');
assert.match(textOf(pickerBtns()[0]), /全部提供商/, 'provider picker defaults to all');
pickerBtns()[0].props.onClick();
dirty = true;
await settle();
tree = renderDashboard();
const providerRow = () => collectNodes(tree).find(
  (n) => n.tag === 'button' && n.props.className === 'duc-pickerrow' && textOf(n).includes('deepseek-account'));
assert.ok(providerRow() !== undefined, 'provider options populated');
// Outside pointer-down dismisses the open panel (native-select feel).
assert.ok((docListeners.mousedown ?? []).length > 0, 'open panel registered a document listener');
docListeners.mousedown.at(-1)({ target: { tag: 'outside' } });
dirty = true;
await settle();
tree = renderDashboard();
assert.ok(providerRow() === undefined, 'outside pointer-down closes the panel');
pickerBtns()[0].props.onClick(); // reopen without picking
dirty = true;
await settle();
tree = renderDashboard();
assert.ok(providerRow() !== undefined, 'provider panel reopened');
// Opening the model picker closes the provider panel (exclusive-open).
pickerBtns()[1].props.onClick();
dirty = true;
await settle();
tree = renderDashboard();
assert.ok(providerRow() === undefined, 'opening another picker closes the first panel');
const modelRow = collectNodes(tree).find(
  (n) => n.tag === 'button' && n.props.className === 'duc-pickerrow' && textOf(n).includes('glm-5.3'));
assert.ok(modelRow !== undefined, 'model options populated');
modelRow.props.onClick();
dirty = true;
await settle();
tree = renderDashboard();
assert.match(textOf(pickerBtns()[1]), /glm-5\.3/, 'model pick shows on the button');
assert.match(textOf(tree), /清除筛选/, 'clear button appears once a filter is set');
pickerBtns()[0].props.onClick();
dirty = true;
await settle();
tree = renderDashboard();
// Pointer-down inside the panel (on a row) keeps it open.
docListeners.mousedown.at(-1)({ target: providerRow() });
dirty = true;
await settle();
tree = renderDashboard();
assert.ok(providerRow() !== undefined, 'inside pointer-down keeps the panel open');
providerRow().props.onClick();
dirty = true;
await settle();
tree = renderDashboard();
assert.match(textOf(pickerBtns()[0]), /deepseek-account/, 'provider pick shows on the button');
findButtonWithText(tree, '清除筛选').props.onClick();
dirty = true;
await settle();
tree = renderDashboard();
assert.match(textOf(pickerBtns()[0]), /全部提供商/, 'clear resets the pickers');
assert.ok(
  !fetchedUrls.some((u) => u.endsWith('/context')),
  'no eager context-overview fetch on the requests page',
);
assert.ok(pickerBtn() !== undefined, 'session picker button rendered');
assert.match(textOf(pickerBtn()), /全部会话/, 'picker defaults to all sessions');

// Costs (unconfigured): unified table with per-category price columns ("–").
await clickTab('费用');
assert.match(textOf(tree), /模型用量/, 'unconfigured costs table rendered');
assert.match(textOf(tree), /未配置价格/, 'pending notice guides to the reference-price button');
assert.match(textOf(tree), /输入 \/1M/, 'input price column present');
assert.match(textOf(tree), /输出 \/1M/, 'output price column present');
assert.match(textOf(tree), /缓存读 \/1M/, 'cache-read price column present');

// Costs (configured): estimate cards + labeled price cells.
costsConfigured = true;
await clickTab('总览');
await clickTab('费用');
assert.match(textOf(tree), /USD/, 'configured cost view rendered');
assert.match(textOf(tree), /1\.10/, 'configured price cell rendered');
assert.match(textOf(tree), /回溯估算/, 'retro-pricing note rendered when retro rows exist');

// Configured but nothing covered yet (the list starts today, history is not
// priced retroactively): the page must explain, not read as "no data".
costsZeroPriced = true;
await clickTab('总览');
await clickTab('费用');
assert.ok(!textOf(tree).includes('暂无数据'), 'usage present → not the bare empty state');
assert.match(textOf(tree), /此前的请求不计价/, 'retroactive-pricing explanation rendered');
assert.match(textOf(tree), /0%/, 'coverage card shows 0 of 600');
assert.match(textOf(tree), /glm\/glm-5\.3/, 'usage table still lists models from usage facts');
costsZeroPriced = false;

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
assert.equal(boxes.length, 5, 'one checkbox per suggestion');
assert.equal(boxes[2].props.disabled, true, 'unmatched row disabled');
assert.equal(boxes[3].props.checked, false, 'normalized match not pre-checked');
assert.equal(boxes[3].props.disabled, false, 'sole normalized candidate importable');
assert.equal(boxes[4].props.checked, false, 'ambiguous row not pre-checked');
assert.equal(boxes[4].props.disabled, true, 'ambiguous row disabled until a candidate is picked');
const normTip = collectNodes(tree).find(
  (n) => n.tag === 'td' && String(n.props.title ?? '').includes('claude5-5 → anthropic/claude5.5'));
assert.ok(normTip !== undefined, 'normalized reason tooltip rendered');
// Single-line cell like every other row; pending mark visible, detail in tooltip.
assert.match(textOf(tree), /归一化 · 待确认/, 'unchecked normalized row marked pending');
const candSelect = collectNodes(tree).find(
  (n) => n.tag === 'select' && textOf(n).includes('选择候选'));
assert.ok(candSelect !== undefined, 'manual-pick select rendered');
const ambTip = collectNodes(tree).find(
  (n) => n.tag === 'td' && String(n.props.title ?? '').includes('存在多个候选'));
assert.ok(ambTip !== undefined, 'ambiguity reason kept in the tooltip');
assert.deepEqual(
  collectNodes(candSelect).filter((n) => n.tag === 'option').map((n) => n.props.value),
  ['', 'openrouter/qwen-4.6', 'qwenlab/qwen-4.6'],
  'sorted candidate options, no auto-pick');
candSelect.props.onChange({ target: { value: 'qwenlab/qwen-4.6' } });
dirty = true;
await settle();
tree = renderDashboard();
const boxes2 = collectNodes(tree).filter((n) => n.tag === 'input' && n.props.type === 'checkbox');
assert.equal(boxes2[4].props.disabled, false, 'ambiguous row enabled after the manual pick');
assert.equal(boxes2[4].props.checked, false, 'manual pick does not auto-check');
boxes2[1].props.onClick(); // uncheck deepseek-flash
boxes2[3].props.onClick(); // confirm the normalized single
boxes2[4].props.onClick(); // confirm the manually picked candidate
dirty = true;
await settle();
tree = renderDashboard();
// History choice: three options when pre-history exists; retro mode rides along.
assert.match(textOf(tree), /早于今天的请求/, 'history facts surfaced in the dialog');
const radios = collectNodes(tree).filter((n) => n.tag === 'input' && n.props.type === 'radio');
assert.equal(radios.length, 3, 'three history choices offered');
const retroRadio = radios.find((r) => r.props.value === 'retro');
assert.ok(retroRadio !== undefined, 'retroactive option present');
retroRadio.props.onClick();
dirty = true;
await settle();
tree = renderDashboard();
const importButton = findButtonWithText(tree, '导入所选');
assert.ok(importButton !== undefined, 'import button rendered');
assert.match(textOf(importButton), /\(3\)/, 'three rows selected after unchecking and confirms');
importButton.props.onClick();
dirty = true;
await settle();
tree = renderDashboard();
assert.ok(importedBody !== null, 'import request posted');
assert.equal(importedBody.models.length, 3, 'only the checked rows posted');
assert.equal(importedBody.models[0].model, 'glm-5.3');
assert.equal(importedBody.models[0].cacheWrite, 0.7);
const claudeRow = importedBody.models.find((m) => m.model === 'claude5-5');
assert.equal(claudeRow?.input, 3, 'normalized single posts its catalog prices');
assert.equal(claudeRow?.sourceModel, 'anthropic/claude5.5', 'normalized row records its catalog source');
const qwenRow = importedBody.models.find((m) => m.model === 'qwen-4-6');
assert.equal(qwenRow?.input, 0.6, 'manual pick posts the chosen candidate prices');
assert.equal(qwenRow?.output, 2.4);
assert.equal(qwenRow?.sourceModel, 'qwenlab/qwen-4.6', 'manual pick records the chosen candidate as source');
assert.equal(importedBody.models[0]?.sourceModel, 'z-ai/glm-5.3', 'cross-namespace suffix match records its source');
assert.equal(importedBody.retroactive, true, 'the retro choice rides along with the import');
assert.match(textOf(tree), /参考价已写入配置/, 'imported notice rendered');

// Context diagnostics live INSIDE the requests page: the session picker
// (lazy /sessions on open, searchable tree) embeds the panel on pick.
await clickTab('请求');
pickerBtn().props.onClick();
dirty = true;
await settle();
tree = renderDashboard();
const pickerSearch = () => collectNodes(tree).find(
  (n) => n.tag === 'input' && typeof n.props.onChange === 'function'
    && String(n.props.placeholder ?? '').includes('搜索会话'),
);
assert.ok(pickerSearch() !== undefined, 'picker search input rendered');
assert.match(textOf(tree), /子代理/, 'subagent badge shown in the picker tree');
assert.ok(
  fetchedUrls.some((u) => u.includes('/sessions')),
  'picker lazy-loaded the session list on open',
);
const pickRow = (label) => collectNodes(tree).find(
  (n) => n.tag === 'button' && n.props.className === 'duc-pickerrow' && textOf(n).includes(label),
);
const run2 = pickRow('run 2');
assert.ok(run2 !== undefined, 'session options labeled with titles');
run2.props.onClick();
dirty = true;
await settle();
tree = renderDashboard();
assert.match(textOf(pickerBtn()), /run 2/, 'picker shows the picked session');
assert.match(textOf(tree), /seq 10/, 'context series chart rendered');
assert.match(textOf(tree), /seq 18/, 'chart spans the whole series by default');
assert.match(textOf(tree), /所选会话/, 'panel metrics bound to the selected session');
assert.match(textOf(tree), /历史最大输入/, 'max-input metric rendered');
assert.match(textOf(tree), /较上次/, 'delta metric rendered');
assert.match(textOf(tree), /窗口剩余/, 'window headroom disclaimer rendered');

// Diagnostics chrome: range selector, attempts layer, window segments.
assert.match(textOf(tree), /最近 50/, 'range selector rendered');
assert.match(textOf(tree), /全部/, 'all-range option rendered');
assert.match(textOf(tree), /尝试\/重试/, 'attempts toggle rendered');
assert.match(textOf(tree), /8 \/ 9/, 'attempts hidden by default');
assert.match(textOf(tree), /100万/, 'first window segment labeled');
assert.match(textOf(tree), /200万/, 'window drawn as segments, not one max line');
assert.match(textOf(tree), /⇄/, 'model-switch marker rendered');
assert.match(textOf(tree), /悬停查看数值/, 'persistent chart hint rendered');
const compactionMarks = collectNodes(tree)
  .filter((n) => n.tag === 'line' && n.props['stroke-dasharray'] === '2 3');
assert.equal(compactionMarks.length, 2, 'both compactions carry a vertical mark');
// Single overlay event layer: hover/click compute the NEAREST sample from
// the mouse x (per-point strips overlapped below ~6px spacing and the
// topmost strip silently selected the wrong request).
const overlay = () => collectNodes(tree).find(
  (n) => n.tag === 'rect' && typeof n.props.onMouseMove === 'function' && typeof n.props.onClick === 'function',
);
assert.ok(overlay() !== undefined, 'single overlay event layer present');
assert.ok(
  !collectNodes(tree).some((n) => n.tag === 'rect' && typeof n.props.onMouseEnter === 'function'),
  'no per-point hit strips remain',
);
const evAt = (i, n) => ({
  clientX: 52 + i * (660 / (n - 1)),
  currentTarget: { getBoundingClientRect: () => ({ left: 0, width: 720 }) },
});

// Hover a point: tooltip with time/seq/model/input and delta.
overlay().props.onMouseMove(evAt(2, 8)); // seq 12: switch point, delta +15,000
dirty = true;
await settle();
tree = renderDashboard();
assert.match(textOf(tree), /glm-5\.3-flash/, 'tooltip shows the model at the point');
assert.match(textOf(tree), /\+1\.5万/, 'tooltip shows the delta vs previous request');
assert.match(textOf(tree), /点击查看请求详情/, 'tooltip hints the drill-down');
overlay().props.onMouseLeave();
dirty = true;
await settle();
tree = renderDashboard();

// Click a point: full request detail from the enriched observation row.
overlay().props.onClick(evAt(2, 8));
dirty = true;
await settle();
tree = renderDashboard();
assert.match(textOf(tree), /请求详情 · seq 12/, 'drill-down panel pinned');
assert.match(textOf(tree), /输入明细/, 'input breakdown present');
assert.match(textOf(tree), /\$0\.0015/, 'per-request estimate joined from cost entries');
assert.ok(collectNodes(tree).some((n) => n.tag === 'circle' && n.props.r === 5), 'pinned point marked on the chart');
findButtonWithText(tree, '关闭').props.onClick();
dirty = true;
await settle();
tree = renderDashboard();
assert.ok(!textOf(tree).includes('请求详情 · seq 12'), 'drill-down closes');

// Exact-text match: the range chip is plain "全部", while the filter
// pickers now read "全部提供商 / 全部模型 / 全部类型".
const allRangeBtn = () => collectNodes(tree).find(
  (n) => n.tag === 'button' && textOf(n) === '全部' && typeof n.props.onClick === 'function');
// Click a compaction mark: marker row, its duration and estimate.
overlay().props.onClick(evAt(3, 8)); // seq 13 compaction
dirty = true;
await settle();
tree = renderDashboard();
assert.match(textOf(tree), /请求详情 · seq 13/, 'compaction drill-down pinned');
assert.match(textOf(tree), /压缩点（无输入数据）/, 'marker flagged instead of a fake 0 input');
assert.match(textOf(tree), /8\.5 s/, 'compaction duration joined');
assert.match(textOf(tree), /\$0\.0003/, 'compaction estimate joined');
findButtonWithText(tree, '关闭').props.onClick();
dirty = true;
await settle();
tree = renderDashboard();

// Compaction diagnostics list: observed before/after drop, not "savings".
assert.match(textOf(tree), /压缩诊断/, 'diagnostics section rendered');
assert.match(textOf(tree), /压缩前后观测差额/, 'drop column labeled as observed difference');
assert.match(textOf(tree), /非实际节省量/, 'not-savings disclaimer rendered');
assert.match(textOf(tree), /\+3\.7万/, 'first drop 45,000 → 8,000');
assert.match(textOf(tree), /18%/, 'first after/before ratio');
assert.match(textOf(tree), /6500/, 'second drop 9,500 → 3,000');
assert.match(textOf(tree), /32%/, 'second after/before ratio');

// Attempts layer: toggle on, hollow dot, error badge on drill-down.
findButtonWithText(tree, '尝试/重试').props.onClick();
dirty = true;
await settle();
tree = renderDashboard();
assert.match(textOf(tree), /9 \/ 9/, 'attempt joins the series when toggled');
assert.ok(collectNodes(tree).some((n) => n.tag === 'circle' && n.props.fill === 'none'), 'attempt plotted as hollow dot');
// seq 15 attempt (9 samples with the layer on), errorCode SERVER.
overlay().props.onClick(evAt(5, 9));
dirty = true;
await settle();
tree = renderDashboard();
assert.match(textOf(tree), /请求详情 · seq 15/, 'attempt drill-down pinned');
assert.match(textOf(tree), /SERVER/, 'failed attempt shows its error code');
findButtonWithText(tree, '关闭').props.onClick();
dirty = true;
await settle();
tree = renderDashboard();

// Range switching works and keeps the view consistent.
allRangeBtn().props.onClick();
dirty = true;
await settle();
tree = renderDashboard();
assert.match(textOf(tree), /9 \/ 9/, 'all-range keeps every sample');
findButtonWithText(tree, '最近 50').props.onClick();
dirty = true;
await settle();
tree = renderDashboard();
assert.match(textOf(tree), /seq 10/, 'narrow range still renders the series');

// Clearing via the picker's "all sessions" entry removes the panel.
pickerBtn().props.onClick();
dirty = true;
await settle();
tree = renderDashboard();
pickRow('全部会话').props.onClick();
dirty = true;
await settle();
tree = renderDashboard();
assert.ok(!textOf(tree).includes('压缩诊断'), 'context panel leaves with the session filter');
assert.match(textOf(tree), /上一页/, 'requests table back to the unfiltered view');

// Dense series (130 samples, ~5.1px spacing): nearest-point precision and
// segment edges that stop at unknown-window regions. Found via SEARCH.
pickerBtn().props.onClick();
dirty = true;
await settle();
tree = renderDashboard();
pickerSearch().props.onChange({ target: { value: 'dense' } });
dirty = true;
await settle();
tree = renderDashboard();
const denseRow = pickRow('Dense series');
assert.ok(denseRow !== undefined, 'search narrows the picker to the dense session');
denseRow.props.onClick();
dirty = true;
await settle();
tree = renderDashboard();
allRangeBtn().props.onClick(); // range state persists across sessions
dirty = true;
await settle();
tree = renderDashboard();
assert.match(textOf(tree), /130 \/ 130/, 'dense series fully visible');
const segLines = collectNodes(tree).filter((n) => n.tag === 'line' && n.props['stroke-dasharray'] === '6 4');
assert.ok(segLines.length >= 1, 'window segment rendered');
const segX1 = Math.min(...segLines.map((l) => l.props.x1));
const segX2 = Math.max(...segLines.map((l) => l.props.x2));
assert.ok(segX1 > 55, `window segment stops before the leading unknown region (x1=${segX1.toFixed(1)})`);
assert.ok(segX2 < 710, `window segment stops before the trailing unknown region (x2=${segX2.toFixed(1)})`);
// Click 2.3px right of point 100 (spacing 5.1px): nearest-point math keeps
// seq 101; the old 6px strips would have been covered by strip 101 there.
overlay().props.onClick(evAt(100.45, 130));
dirty = true;
await settle();
tree = renderDashboard();
assert.match(textOf(tree), /请求详情 · seq 101/, 'nearest point wins where strips used to overlap');
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

// Ledger tree: sub-agents are grouped under their parent and expand in place.
await clickTab('台账');
let ledgerText = textOf(tree);
assert.match(ledgerText, /子代理 1/, 'parent row carries a sub-agent count badge');
assert.ok(!ledgerText.includes('proj'), 'child row hidden until expanded');
const expander = collectNodes(tree).find((n) => n.tag === 'button' && n.props.className === 'duc-expander');
assert.ok(expander !== undefined, 'expander button rendered');
expander.props.onClick();
dirty = true;
await settle();
tree = renderDashboard();
assert.match(textOf(tree), /proj/, 'child session expands under its parent');

console.log(`client render drive ok — ${fetchedUrls.length} api calls, tabs exercised`);
