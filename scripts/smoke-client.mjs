/**
 * Client-half smoke check (ad hoc, no browser): loads client/index.js with a
 * stub module loader, stub React, and a stub Cordis context, then drives
 * `apply()` end to end and asserts the two registrations and the glyph
 * render. This catches factory/apply wiring errors that `node --check`
 * cannot; rendered visuals are still verified by a human in the Web GUI.
 *
 * Usage: node scripts/smoke-client.mjs
 */

import assert from 'node:assert/strict';
import { pathToFileURL } from 'node:url';
import { resolve } from 'node:path';
import { readFileSync } from 'node:fs';

// Static gate: color-mix() is permanently banned from the panel (this engine
// rejects it on SVG paints and everything falls back to black). Theme tokens
// are ALLOWED only through the adaptive probe path (buildColors/themeTokens-
// Reachable) so literal mode remains the guaranteed fallback.
{
  const source = readFileSync(resolve('client/index.js'), 'utf8');
  const codeOnly = source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '');
  assert.ok(!codeOnly.includes('color-mix('), 'panel code must not use color-mix()');
  assert.ok(codeOnly.includes('themeTokensReachable'), 'adaptive theme probe present');
  assert.ok(codeOnly.includes('buildColors'), 'adaptive color builder present');
  assert.ok(codeOnly.includes("style.dataset.theme"), 'theme mode stamped on the style tag');
}

const loads = [];
const styleTags = [];
globalThis.window = {
  __ModuleLoader__: { load(def) { loads.push(def); } },
};
globalThis.document = {
  createElement() {
    return {
      dataset: {},
      style: {},
      textContent: '',
      remove() { this.removed = true; },
    };
  },
  head: { appendChild(tag) { styleTags.push(tag); } },
  documentElement: {},
};
// Themed-mode probe: the stub reports a reachable brand token, so this
// harness exercises the var(--token, literal) path (the render drive runs
// without getComputedStyle and covers the literal path).
globalThis.getComputedStyle = () => ({
  getPropertyValue: (name) => (name === '--dsw-alias-brand-primary' ? '#123456' : ''),
});

const fakeReact = {
  createElement(type, props, ...children) {
    return { type, props: props ?? {}, children };
  },
  useState(initial) {
    return [typeof initial === 'function' ? initial() : initial, () => {}];
  },
  useEffect() {},
  useMemo(factory) {
    return factory();
  },
  useSyncExternalStore() {
    return 'zh-CN';
  },
};

const localeSubscribers = [];
const registrations = [];
const effects = [];
const ctx = {
  locale: {
    register(ns, dicts) {
      assert.equal(typeof dicts.zh, 'object');
      assert.equal(typeof dicts.en, 'object');
      return () => {};
    },
    subscribe(fn) {
      localeSubscribers.push(fn);
      return () => {};
    },
    getSnapshot() {
      return { active: 'zh-CN' };
    },
  },
  slots: {
    inject(slotKey, callback) {
      registrations.push([slotKey, callback()]);
      return () => {};
    },
    register(options, component) {
      return { options, component };
    },
  },
  effect(cleanup, label) {
    effects.push({ cleanup, label });
  },
  get(name) {
    return name === 'layout' ? { selectPanel() {} } : undefined;
  },
};

await import(pathToFileURL(resolve('client/index.js')).href);

assert.equal(loads.length, 1, 'one module registered with the loader');
const def = loads[0];
assert.equal(def.id, 'dsh-usage-center');

const mod = def.factory((name) => {
  if (name === 'react') return fakeReact;
  throw new Error(`unexpected require("${name}")`);
});
assert.deepEqual(mod.inject, ['slots', 'locale']);

mod.apply(ctx);

// Locale + style effects were installed with cleanups.
assert.equal(styleTags.length, 1, 'one style tag appended');
assert.equal(styleTags[0].dataset.plugin, 'dsh-usage-center');
assert.equal(styleTags[0].dataset.theme, 'on', 'probe detects the reachable token');
assert.ok(styleTags[0].textContent.includes('var(--dsw-alias-brand-primary'), 'themed css uses token with fallback');
assert.ok(styleTags[0].textContent.includes('#c3d0f7') === false, 'themed css does not use the literal-only ramp');
assert.ok(effects.some((e) => typeof e.cleanup === 'function' && /locale/.test(e.label ?? '')));

// sidebar.panellist: data options + glyph component ({size, active} props).
const panel = registrations.find(([key]) => key === 'sidebar.panellist');
assert.ok(panel !== undefined, 'sidebar.panellist registered');
assert.equal(panel[1].options.id, 'usage-center');
assert.equal(typeof panel[1].options.order, 'number');
assert.equal(panel[1].options.label(), '用量中心', 'label resolves via the zh dict');
const glyph = panel[1].component({ size: 16, active: true });
assert.equal(glyph.type, 'svg');
assert.equal(glyph.props['data-active'], 'true');

// main: keyed panel occupant.
const main = registrations.find(([key]) => key === 'main');
assert.ok(main !== undefined, 'main registered');
assert.equal(main[1].options.key, 'usage-center');
const dashboard = main[1].component();
assert.equal(dashboard.type.name ?? typeof dashboard.type, 'DashboardView', 'dashboard view rendered');

console.log('client smoke ok — registrations:', registrations.map(([k]) => k).join(', '));
