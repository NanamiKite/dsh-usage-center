/**
 * dsh-usage-center — Client half (Web dashboard).
 *
 * Loaded by the page module loader (`window.__ModuleLoader__.load`). React
 * comes from the browser module table; there is no bundler, no CDN, and no
 * second React copy. All styling uses the host theme tokens
 * (`--dsw-alias-*`), all visible text flows through the Client locale
 * service, and every number on screen comes from the Host half's read-only
 * HTTP API (`/dsh-usage-center/v1`) backed by the SQLite ledger.
 *
 * Registration contract (verified against the shipped ui-sidebar/ui-layout
 * clients, see docs/DESIGN.md):
 * - `sidebar.panellist` is a data slot: the host renders the row (button,
 *   tooltip, active state) from `{ id, order, label }` and calls
 *   `ctx.layout.selectPanel(id)` on click; the registered component only
 *   renders the glyph and receives `{ size, active }`.
 * - `main` is a keyed slot rendered for the active panel id; the occupant
 *   receives no props and must be self-contained.
 */

window.__ModuleLoader__.load({
  id: 'dsh-usage-center',
  factory(require) {
    const React = require('react');
    const h = React.createElement;
    const { useState, useEffect, useMemo } = React;

    // ------------------------------------------------------------------ i18n

    const NS = 'usage-center';

    const zh = {
      'panel.title': '用量中心',
      'nav.back': '返回会话',
      'nav.refresh': '刷新',
      'tabs.overview': '总览',
      'tabs.requests': '请求',
      'tabs.ledger': '台账',
      'tabs.costs': '费用',
      'tabs.context': '上下文',
      'range.label': '趋势范围',
      'range.7': '7 天',
      'range.30': '30 天',
      'range.90': '90 天',
      'state.loading': '加载中…',
      'state.empty': '暂无数据',
      'state.error': '读取失败',
      'state.retry': '重试',
      'stat.requests': '请求总数',
      'stat.tokens': 'Token 总量',
      'stat.cacheHit': '缓存命中率',
      'stat.firstToken': '平均首字延迟',
      'stat.errors': '失败请求',
      'stat.todayRequests': '今日请求',
      'stat.todayTokens': '今日 Token',
      'stat.estCost': '费用估算',
      'costs.estimate': '估算',
      'costs.coverage': '覆盖率',
      'stat.scope.all': '全部时间',
      'card.trend': '按天 Token 趋势',
      'card.heat': '活跃热力图（26 周）',
      'card.models': '模型用量',
      'card.rangeTotal': '区间合计',
      'chart.input': '输入',
      'chart.output': '输出',
      'chart.cacheRead': '缓存读',
      'chart.cacheWrite': '缓存写',
      'chart.tokensUnit': 'tokens',
      'chart.requestsUnit': '次请求',
      'heat.less': '少',
      'heat.more': '多',
      'table.model': '提供商 / 模型',
      'table.provider': '提供商',
      'table.kind': '类型',
      'table.requests': '请求',
      'table.input': '输入',
      'table.output': '输出',
      'table.cacheRead': '缓存读',
      'table.cacheWrite': '缓存写',
      'table.total': '合计',
      'table.cost': '费用',
      'table.cacheHit': '命中率',
      'table.avgFirstToken': '平均首字',
      'table.errors': '错误',
      'table.lastActivity': '最后活动',
      'table.time': '时间',
      'table.turnStep': '轮/步',
      'table.firstToken': '首字',
      'table.duration': '时长',
      'table.status': '状态',
      'table.session': '会话',
      'table.workspace': '工作区',
      'table.created': '创建',
      'table.parent': '父会话',
      'filter.provider': '提供商…',
      'filter.model': '模型…',
      'filter.kind': '类型…',
      'filter.session': '会话 ID…',
      'filter.clear': '清除筛选',
      'page.prev': '上一页',
      'page.next': '下一页',
      'page.status': '{from}–{to} / {total}',
      'kind.chat': '对话',
      'kind.compaction': '压缩',
      'kind.attempt': '尝试/失败',
      'kind.other': '其他',
      'origin.subagent': '子代理',
      'origin.main': '主任务',
      'origin.unknown': '未知来源',
      'status.ok': '完成',
      'status.error': '失败',
      'costs.basis': '模型用量',
      'costs.pending': '费用估算尚未提供',
      'costs.suggest': '参考价',
      'costs.fetch': '获取',
      'costs.matched': '匹配',
      'costs.unmatched': '未匹配',
      'costs.copy': '复制',
      'costs.copied': '已复制',
      'costs.paste': 'cordis.patch.yml → config.prices',
      'context.pending': '上下文监控尚未提供',
    };

    const en = {
      'panel.title': 'Usage center',
      'nav.back': 'Back to conversation',
      'nav.refresh': 'Refresh',
      'tabs.overview': 'Overview',
      'tabs.requests': 'Requests',
      'tabs.ledger': 'Ledger',
      'tabs.costs': 'Costs',
      'tabs.context': 'Context',
      'range.label': 'Trend range',
      'range.7': '7 days',
      'range.30': '30 days',
      'range.90': '90 days',
      'state.loading': 'Loading…',
      'state.empty': 'No data yet',
      'state.error': 'Failed to load',
      'state.retry': 'Retry',
      'stat.requests': 'Total requests',
      'stat.tokens': 'Total tokens',
      'stat.cacheHit': 'Cache hit rate',
      'stat.firstToken': 'Avg first token',
      'stat.errors': 'Failed requests',
      'stat.todayRequests': 'Requests today',
      'stat.todayTokens': 'Tokens today',
      'stat.estCost': 'Estimated cost',
      'costs.estimate': 'Estimates',
      'costs.coverage': 'Coverage',
      'stat.scope.all': 'all time',
      'card.trend': 'Daily token trend',
      'card.heat': 'Activity heatmap (26 weeks)',
      'card.models': 'Model usage',
      'card.rangeTotal': 'Range total',
      'chart.input': 'Input',
      'chart.output': 'Output',
      'chart.cacheRead': 'Cache read',
      'chart.cacheWrite': 'Cache write',
      'chart.tokensUnit': 'tokens',
      'chart.requestsUnit': 'requests',
      'heat.less': 'Less',
      'heat.more': 'More',
      'table.model': 'Provider / model',
      'table.provider': 'Provider',
      'table.kind': 'Kind',
      'table.requests': 'Requests',
      'table.input': 'Input',
      'table.output': 'Output',
      'table.cacheRead': 'Cache read',
      'table.cacheWrite': 'Cache write',
      'table.total': 'Total',
      'table.cost': 'Cost',
      'table.cacheHit': 'Hit rate',
      'table.avgFirstToken': 'Avg first token',
      'table.errors': 'Errors',
      'table.lastActivity': 'Last activity',
      'table.time': 'Time',
      'table.turnStep': 'Turn/step',
      'table.firstToken': 'First token',
      'table.duration': 'Duration',
      'table.status': 'Status',
      'table.session': 'Session',
      'table.workspace': 'Workspace',
      'table.created': 'Created',
      'table.parent': 'Parent',
      'filter.provider': 'Provider…',
      'filter.model': 'Model…',
      'filter.kind': 'Kind…',
      'filter.session': 'Session id…',
      'filter.clear': 'Clear filters',
      'page.prev': 'Previous',
      'page.next': 'Next',
      'page.status': '{from}–{to} / {total}',
      'kind.chat': 'Chat',
      'kind.compaction': 'Compaction',
      'kind.attempt': 'Attempt',
      'kind.other': 'Other',
      'origin.subagent': 'Subagent',
      'origin.main': 'Main',
      'origin.unknown': 'Unknown',
      'status.ok': 'OK',
      'status.error': 'Error',
      'costs.basis': 'Model usage',
      'costs.pending': 'Cost estimates are not available yet',
      'costs.suggest': 'Reference prices',
      'costs.fetch': 'Fetch',
      'costs.matched': 'Match',
      'costs.unmatched': 'No match',
      'costs.copy': 'Copy',
      'costs.copied': 'Copied',
      'costs.paste': 'cordis.patch.yml → config.prices',
      'context.pending': 'Context monitor is not available yet',
    };

    const DICTS = { zh, en };

    function languageOf(active) {
      return typeof active === 'string' && /^zh/i.test(active) ? 'zh' : 'en';
    }

    function interpolate(template, params) {
      if (params === undefined || params === null) return template;
      return String(template).replace(/\{(\w+)\}/g, (whole, key) =>
        Object.prototype.hasOwnProperty.call(params, key) ? String(params[key]) : whole,
      );
    }

    // ------------------------------------------------------------- formatting

    function makeFormatters(localeTag) {
      const tag = typeof localeTag === 'string' && localeTag.length > 0 ? localeTag : 'en';
      const compactFmt = new Intl.NumberFormat(tag, { notation: 'compact', maximumFractionDigits: 1 });
      const intFmt = new Intl.NumberFormat(tag);
      const dateFmt = new Intl.DateTimeFormat(tag, { month: 'short', day: 'numeric' });
      const dateTimeFmt = new Intl.DateTimeFormat(tag, {
        month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit',
      });
      return {
        compact: (n) => (Number.isFinite(n) ? compactFmt.format(n) : '–'),
        int: (n) => (Number.isFinite(n) ? intFmt.format(n) : '–'),
        date: (ts) => (typeof ts === 'number' ? dateFmt.format(new Date(ts)) : '–'),
        dateTime: (ts) => (typeof ts === 'number' ? dateTimeFmt.format(new Date(ts)) : '–'),
        pct: (x) => (typeof x === 'number' && Number.isFinite(x) ? `${(x * 100).toFixed(1)}%` : '–'),
        ms: (ms) => {
          if (typeof ms !== 'number' || !Number.isFinite(ms)) return '–';
          return ms >= 1000 ? `${(ms / 1000).toFixed(1)} s` : `${Math.round(ms)} ms`;
        },
      };
    }

    /** Micro currency units → localized amount (more digits for tiny values). */
    function makeMoneyFormatter(localeTag) {
      const cache = new Map();
      return (micro, currency) => {
        if (typeof micro !== 'number' || !Number.isFinite(micro)) return '–';
        const value = micro / 1e6;
        const digits = value >= 100 ? 2 : value >= 1 ? 3 : value >= 0.01 ? 4 : 6;
        const key = `${currency}|${digits}`;
        let formatter = cache.get(key);
        if (formatter === undefined) {
          formatter = new Intl.NumberFormat(localeTag, {
            style: 'currency', currency,
            minimumFractionDigits: digits, maximumFractionDigits: digits,
          });
          cache.set(key, formatter);
        }
        return formatter.format(value);
      };
    }

    // ------------------------------------------------------------------- API

    const API_BASE = '/dsh-usage-center/v1';

    function api(path, params) {
      const search = new URLSearchParams();
      if (params !== undefined) {
        for (const [key, value] of Object.entries(params)) {
          if (value !== undefined && value !== null && value !== '') search.set(key, String(value));
        }
      }
      const query = search.toString();
      const url = API_BASE + path + (query.length > 0 ? `?${query}` : '');
      return fetch(url, { headers: { accept: 'application/json' } }).then((res) => {
        if (!res.ok) throw new Error(`HTTP ${res.status} (${url})`);
        return res.json();
      });
    }

    // ------------------------------------------------------------------ data

    function useLoad(build, deps) {
      const [state, setState] = useState({ loading: true, data: null, error: null });
      const [tick, setTick] = useState(0);
      useEffect(() => {
        let alive = true;
        setState((prev) => ({ ...prev, loading: true, error: null }));
        const jobs = build();
        Promise.all(jobs.map(([, promise]) => promise))
          .then((values) => {
            if (!alive) return;
            const data = {};
            jobs.forEach(([key], index) => { data[key] = values[index]; });
            setState({ loading: false, data, error: null });
          })
          .catch((error) => {
            if (!alive) return;
            console.error('dsh-usage-center: dashboard load failed', error);
            setState({ loading: false, data: null, error: String(error?.message ?? error) });
          });
        return () => { alive = false; };
        // eslint-disable-next-line react-hooks/exhaustive-deps
      }, [...deps, tick]);
      useEffect(() => {
        const id = window.setInterval(() => { setTick((value) => value + 1); }, 15000);
        return () => { window.clearInterval(id); };
      }, []);
      const refresh = () => setTick((value) => value + 1);
      return { ...state, refresh };
    }

    // ------------------------------------------------------------ components

    const css = `
.duc-root{height:100%;min-height:0;display:flex;flex-direction:column;background:var(--dsw-alias-bg-base);color:var(--dsw-alias-label-primary);font-size:14px}
.duc-header{display:flex;align-items:center;gap:12px;padding:10px 20px;border-bottom:1px solid var(--dsw-alias-border-l1);flex:none;flex-wrap:wrap}
.duc-back{border:none;background:transparent;color:var(--dsw-alias-label-secondary);cursor:pointer;display:inline-flex;align-items:center;gap:6px;padding:6px 8px;border-radius:var(--dsw-radius-sm,6px);font:inherit}
.duc-back:hover{background:var(--dsw-alias-interactive-bg-hover,rgba(0,0,0,.05));color:var(--dsw-alias-label-primary)}
.duc-title{font-size:16px;font-weight:600;margin:0}
.duc-spacer{flex:1}
.duc-tabs{display:flex;gap:2px;padding:4px;background:var(--dsw-alias-bg-layer-2);border-radius:8px}
.duc-tab{border:none;background:transparent;color:var(--dsw-alias-label-secondary);cursor:pointer;padding:5px 12px;border-radius:6px;font:inherit}
.duc-tab:hover{color:var(--dsw-alias-label-primary)}
.duc-tab[aria-selected=true]{background:var(--dsw-alias-bg-layer-1);color:var(--dsw-alias-label-primary);box-shadow:0 1px 2px rgba(0,0,0,.08)}
.duc-range{display:inline-flex;gap:0;border:1px solid var(--dsw-alias-border-l1);border-radius:6px;overflow:hidden}
.duc-range button{border:none;background:transparent;color:var(--dsw-alias-label-secondary);padding:5px 10px;cursor:pointer;font:inherit}
.duc-range button[aria-pressed=true]{background:var(--dsw-alias-bg-layer-2);color:var(--dsw-alias-label-primary)}
.duc-iconbtn{border:1px solid var(--dsw-alias-border-l1);background:var(--dsw-alias-bg-layer-1);color:var(--dsw-alias-label-secondary);border-radius:6px;padding:5px 10px;cursor:pointer;font:inherit}
.duc-iconbtn:hover{color:var(--dsw-alias-label-primary)}
.duc-body{flex:1;min-height:0;overflow:auto;padding:16px 20px 24px}
.duc-grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(170px,1fr));gap:12px;margin-bottom:16px}
.duc-card{background:var(--dsw-alias-bg-layer-1);border:1px solid var(--dsw-alias-border-l1);border-radius:10px;padding:14px 16px}
.duc-card-title{font-size:12px;color:var(--dsw-alias-label-secondary);margin-bottom:8px;font-weight:500;letter-spacing:.02em}
.duc-stat-value{font-size:22px;font-weight:600;line-height:1.2}
.duc-stat-sub{font-size:12px;color:var(--dsw-alias-label-secondary);margin-top:4px}
.duc-section{background:var(--dsw-alias-bg-layer-1);border:1px solid var(--dsw-alias-border-l1);border-radius:10px;padding:14px 16px;margin-bottom:16px}
.duc-section-title{font-size:13px;font-weight:600;margin:0 0 10px}
.duc-section-head{display:flex;align-items:baseline;justify-content:space-between;gap:10px;margin:0 0 10px}
.duc-section-head .duc-section-title{margin:0}
.duc-small{font-size:12px}
.duc-pre{margin:10px 0 0;padding:10px 12px;background:var(--dsw-alias-bg-layer-2);border:1px solid var(--dsw-alias-border-l1);border-radius:8px;font-family:ui-monospace,Consolas,monospace;font-size:12px;line-height:1.5;white-space:pre;overflow:auto;max-height:260px}
.duc-chips{display:flex;gap:6px;flex-wrap:wrap;margin-top:8px}
.duc-tablewrap{overflow:auto}
.duc-table{border-collapse:collapse;width:100%;font-size:13px}
.duc-table th{text-align:left;color:var(--dsw-alias-label-secondary);font-weight:500;padding:6px 10px;border-bottom:1px solid var(--dsw-alias-border-l2);white-space:nowrap;position:sticky;top:0;background:var(--dsw-alias-bg-layer-1)}
.duc-table td{padding:6px 10px;border-bottom:1px solid var(--dsw-alias-border-l1);white-space:nowrap;vertical-align:top}
.duc-table td.num,.duc-table th.num{text-align:right;font-variant-numeric:tabular-nums}
.duc-table tr:hover td{background:var(--dsw-alias-interactive-bg-hover,rgba(0,0,0,.03))}
.duc-table tr.clickable{cursor:pointer}
.duc-muted{color:var(--dsw-alias-label-secondary)}
.duc-error{color:var(--dsw-alias-state-error-primary)}
.duc-badge{display:inline-block;padding:1px 8px;border-radius:999px;font-size:11.5px;border:1px solid var(--dsw-alias-border-l1);color:var(--dsw-alias-label-secondary)}
.duc-badge.err{border-color:var(--dsw-alias-state-error-primary);color:var(--dsw-alias-state-error-primary)}
.duc-badge.ok{border-color:var(--dsw-alias-state-success-primary);color:var(--dsw-alias-state-success-primary)}
.duc-filters{display:flex;gap:8px;flex-wrap:wrap;margin-bottom:12px;align-items:center}
.duc-input{background:var(--dsw-alias-bg-base);border:1px solid var(--dsw-alias-border-l1);border-radius:6px;color:var(--dsw-alias-label-primary);padding:5px 9px;font:inherit;min-width:130px}
.duc-input::placeholder{color:var(--dsw-alias-label-secondary)}
.duc-input:focus{outline:2px solid var(--dsw-alias-brand-primary);outline-offset:-1px}
select.duc-input{min-width:100px}
.duc-pager{display:flex;align-items:center;gap:10px;justify-content:flex-end;margin-top:10px;color:var(--dsw-alias-label-secondary);font-size:12.5px}
.duc-pager button{border:1px solid var(--dsw-alias-border-l1);background:var(--dsw-alias-bg-layer-1);color:var(--dsw-alias-label-primary);border-radius:6px;padding:4px 10px;cursor:pointer;font:inherit}
.duc-pager button:disabled{opacity:.45;cursor:default}
.duc-state{padding:40px 0;text-align:center;color:var(--dsw-alias-label-secondary)}
.duc-state button{margin-top:10px}
.duc-legend{display:flex;gap:14px;flex-wrap:wrap;font-size:12px;color:var(--dsw-alias-label-secondary);margin-bottom:8px}
.duc-legend span{display:inline-flex;align-items:center;gap:5px}
.duc-swatch{width:10px;height:10px;border-radius:2px;display:inline-block}
.duc-trend{width:100%;height:auto;display:block}
.duc-heatwrap{display:flex;gap:8px}
.duc-heatgrid{display:grid;grid-auto-flow:column;grid-template-rows:repeat(7,1fr);gap:3px;overflow-x:auto;padding-bottom:4px}
.duc-cell{width:11px;height:11px;border-radius:2.5px;background:var(--dsw-alias-state-idle-primary);opacity:.25}
.duc-cell[data-level="1"]{background:var(--dsw-alias-brand-primary);opacity:.22}
.duc-cell[data-level="2"]{background:var(--dsw-alias-brand-primary);opacity:.45}
.duc-cell[data-level="3"]{background:var(--dsw-alias-brand-primary);opacity:.7}
.duc-cell[data-level="4"]{background:var(--dsw-alias-brand-primary);opacity:.95}
.duc-heatlegend{display:flex;align-items:center;gap:4px;font-size:12px;color:var(--dsw-alias-label-secondary);margin-top:8px}
.duc-glyph{color:var(--dsw-alias-label-secondary)}
.duc-glyph[data-active=true]{color:var(--dsw-alias-label-primary)}
`;

    function StatCard({ title, value, sub, tone }) {
      return h('div', { className: 'duc-card' },
        h('div', { className: 'duc-card-title' }, title),
        h('div', { className: tone === 'error' ? 'duc-stat-value duc-error' : 'duc-stat-value' }, value),
        sub !== undefined && sub !== null ? h('div', { className: 'duc-stat-sub' }, sub) : null,
      );
    }

    function StateView({ loading, error, empty, onRetry, t, children }) {
      if (loading) return h('div', { className: 'duc-state' }, t('state.loading'));
      if (error !== null && error !== undefined) {
        return h('div', { className: 'duc-state' },
          h('div', { className: 'duc-error' }, `${t('state.error')} — ${error}`),
          h('br'),
          onRetry !== undefined ? h('button', {
            type: 'button', className: 'duc-iconbtn', onClick: onRetry,
          }, t('state.retry')) : null,
        );
      }
      if (empty) return h('div', { className: 'duc-state' }, t('state.empty'));
      return children;
    }

    // ---------------------------------------------------------------- charts

    const SERIES = [
      { key: 'cacheWriteTokens', label: 'chart.cacheWrite', alpha: '16%' },
      { key: 'cacheReadTokens', label: 'chart.cacheRead', alpha: '32%' },
      { key: 'inputTokens', label: 'chart.input', alpha: '60%' },
      { key: 'outputTokens', label: 'chart.output', alpha: '95%' },
    ];

    function niceCeil(value) {
      if (value <= 0) return 1;
      const exponent = Math.floor(Math.log10(value));
      const base = Math.pow(10, exponent);
      for (const step of [1, 2, 5, 10]) {
        if (value <= step * base) return step * base;
      }
      return 10 * base;
    }

    function TrendChart({ points, t, fmt }) {
      const W = 720;
      const H = 190;
      const PAD_L = 46;
      const PAD_B = 18;
      const PAD_T = 6;
      const plotW = W - PAD_L - 8;
      const plotH = H - PAD_B - PAD_T;
      const maxTotal = Math.max(...points.map((p) => p.totalTokens), 0);
      const yMax = niceCeil(maxTotal);
      const barW = Math.max(1, (plotW / points.length) * 0.72);
      const step = plotW / points.length;
      const y = (value) => PAD_T + plotH - (value / yMax) * plotH;
      const labelIdx = points.length <= 1 ? [] : [0, Math.floor((points.length - 1) / 2), points.length - 1];
      return h('div', null,
        h('div', { className: 'duc-legend' },
          SERIES.map((series) => h('span', { key: series.key },
            h('i', {
              className: 'duc-swatch',
              style: { background: `color-mix(in srgb, var(--dsw-alias-brand-primary) ${series.alpha}, transparent)` },
            }),
            t(series.label),
          )),
        ),
        h('svg', {
          className: 'duc-trend', viewBox: `0 0 ${W} ${H}`,
          role: 'img', 'aria-label': t('card.trend'),
        },
          [0, 0.5, 1].map((ratio) =>
            h('g', { key: ratio },
              h('line', {
                x1: PAD_L, x2: W - 8, y1: y(yMax * ratio), y2: y(yMax * ratio),
                stroke: 'var(--dsw-alias-border-l1)', strokeWidth: 1,
              }),
              h('text', {
                x: PAD_L - 6, y: y(yMax * ratio) + 4, 'text-anchor': 'end',
                fill: 'var(--dsw-alias-label-secondary)', 'font-size': 10,
              }, fmt.compact(yMax * ratio)),
            )),
          points.map((point, index) => {
            const x = PAD_L + index * step + (step - barW) / 2;
            let stacked = 0;
            const title = `${point.day} · ${fmt.int(point.totalTokens)} ${t('chart.tokensUnit')} · ${fmt.int(point.requests)} ${t('chart.requestsUnit')}` +
              (point.errorCount > 0 ? ` · ${point.errorCount} ✕` : '');
            return h('g', { key: point.day },
              h('title', null, title),
              SERIES.map((series) => {
                const value = Math.max(point[series.key] ?? 0, 0);
                if (value <= 0) return null;
                const y0 = y(stacked);
                stacked += value;
                const y1 = y(stacked);
                return h('rect', {
                  key: series.key, x, width: barW,
                  y: Math.min(y0, y1), height: Math.max(y1 - y0, 0.8),
                  fill: `color-mix(in srgb, var(--dsw-alias-brand-primary) ${series.alpha}, transparent)`,
                });
              }),
            );
          }),
          labelIdx.map((index) =>
            h('text', {
              key: index,
              x: PAD_L + index * step + step / 2, y: H - 4, 'text-anchor': index === 0 ? 'start' : index === points.length - 1 ? 'end' : 'middle',
              fill: 'var(--dsw-alias-label-secondary)', 'font-size': 10,
            }, fmt.date(Date.parse(points[index].day + 'T00:00:00'))),
          ),
        ),
      );
    }

    function Heatmap({ points, t, fmt }) {
      // points: 182 chronological TrendPoint-like {day, totalTokens, requests}
      const byDay = new Map(points.map((p) => [p.day, p]));
      const maxTokens = Math.max(...points.map((p) => p.totalTokens), 1);
      const cells = [];
      if (points.length > 0) {
        const firstDate = new Date(points[0].day + 'T00:00:00');
        // Align to the Monday of the first week (local time).
        const cursor = new Date(firstDate);
        cursor.setDate(cursor.getDate() - ((cursor.getDay() + 6) % 7));
        const lastDate = new Date(points[points.length - 1].day + 'T00:00:00');
        for (; cursor <= lastDate; cursor.setDate(cursor.getDate() + 1)) {
          const day = `${cursor.getFullYear()}-${String(cursor.getMonth() + 1).padStart(2, '0')}-${String(cursor.getDate()).padStart(2, '0')}`;
          const point = byDay.get(day);
          const tokens = point?.totalTokens ?? 0;
          const ratio = tokens / maxTokens;
          const level = tokens <= 0 ? 0 : ratio > 0.5 ? 4 : ratio > 0.2 ? 3 : ratio > 0.04 ? 2 : 1;
          cells.push(h('div', {
            key: day, className: 'duc-cell', 'data-level': String(level),
            title: `${day} · ${fmt.int(tokens)} ${t('chart.tokensUnit')}${point ? ` · ${fmt.int(point.requests)} ${t('chart.requestsUnit')}` : ''}`,
          }));
        }
      }
      return h('div', null,
        h('div', { className: 'duc-heatwrap' },
          h('div', { className: 'duc-heatgrid', role: 'img', 'aria-label': t('card.heat') }, cells),
        ),
        h('div', { className: 'duc-heatlegend' },
          t('heat.less'),
          [0, 1, 2, 3, 4].map((level) => h('i', {
            key: level, className: 'duc-cell', 'data-level': String(level), style: { display: 'inline-block', marginRight: 2 },
          })),
          t('heat.more'),
        ),
      );
    }

    // ------------------------------------------------------------------ tabs

    function OverviewTab({ t, fmt, range, data }) {
      const { totals, today, byModel, trendPoints, heatPoints, costs } = data;
      const rangeTotals = trendPoints.reduce((acc, p) => ({
        tokens: acc.tokens + p.totalTokens, requests: acc.requests + p.requests,
      }), { tokens: 0, requests: 0 });
      return h('div', null,
        h('div', { className: 'duc-grid' },
          h(StatCard, { title: t('stat.requests'), value: fmt.int(totals.requests), sub: t('stat.scope.all') }),
          h(StatCard, { title: t('stat.tokens'), value: fmt.compact(totals.totalTokens) }),
          h(StatCard, { title: t('stat.cacheHit'), value: fmt.pct(totals.cacheHitRate) }),
          h(StatCard, { title: t('stat.firstToken'), value: fmt.ms(totals.firstTokenMsCount > 0 ? totals.firstTokenMsTotal / totals.firstTokenMsCount : null) }),
          h(StatCard, { title: t('stat.errors'), value: fmt.int(byModel.reduce((acc, r) => acc + r.errorCount, 0)), tone: 'error' }),
          costs !== null && costs !== undefined && costs.length > 0
            ? h(StatCard, {
              title: `≈ ${t('stat.estCost')}`,
              value: costs.map((c) => fmt.money(c.totalMicro, c.currency)).join(' · '),
              sub: t('costs.estimate'),
            })
            : null,
          h(StatCard, { title: t('stat.todayRequests'), value: fmt.int(today.requests), sub: `${t('stat.todayTokens')} ${fmt.compact(today.totalTokens)}` }),
        ),
        h('div', { className: 'duc-section' },
          h('h3', { className: 'duc-section-title' },
            `${t('card.trend')} · ${t('card.rangeTotal')} ${fmt.compact(rangeTotals.tokens)} ${t('chart.tokensUnit')} / ${fmt.int(rangeTotals.requests)} ${t('chart.requestsUnit')}`),
          h(TrendChart, { points: trendPoints, t, fmt }),
        ),
        h('div', { className: 'duc-section' },
          h('h3', { className: 'duc-section-title' }, t('card.heat')),
          h(Heatmap, { points: heatPoints, t, fmt }),
        ),
        h('div', { className: 'duc-section' },
          h('h3', { className: 'duc-section-title' }, t('card.models')),
          h('div', { className: 'duc-tablewrap' },
            h('table', { className: 'duc-table' },
              h('thead', null, h('tr', null,
                h('th', null, t('table.model')),
                h('th', { className: 'num' }, t('table.requests')),
                h('th', { className: 'num' }, t('table.input')),
                h('th', { className: 'num' }, t('table.output')),
                h('th', { className: 'num' }, t('table.cacheRead')),
                h('th', { className: 'num' }, t('table.total')),
                h('th', { className: 'num' }, t('table.cacheHit')),
                h('th', { className: 'num' }, t('table.avgFirstToken')),
                h('th', { className: 'num' }, t('table.errors')),
              )),
              h('tbody', null, byModel.map((row) =>
                h('tr', { key: row.key },
                  h('td', null, row.key),
                  h('td', { className: 'num' }, fmt.int(row.requests)),
                  h('td', { className: 'num' }, fmt.int(row.inputTokens)),
                  h('td', { className: 'num' }, fmt.int(row.outputTokens)),
                  h('td', { className: 'num' }, fmt.int(row.cacheReadTokens)),
                  h('td', { className: 'num' }, fmt.compact(row.totalTokens)),
                  h('td', { className: 'num' }, fmt.pct(row.cacheHitRate)),
                  h('td', { className: 'num' }, fmt.ms(row.avgFirstTokenMs)),
                  h('td', { className: 'num' }, row.errorCount > 0 ? h('span', { className: 'duc-error' }, fmt.int(row.errorCount)) : h('span', { className: 'duc-muted' }, '–')),
                ))),
            ),
          ),
        ),
      );
    }

    const KIND_OPTIONS = ['chat', 'compaction', 'attempt', 'other'];

    function kindLabel(kind, t) {
      const key = `kind.${kind}`;
      const localized = t(key);
      return localized === key ? kind : localized;
    }

    function RequestsTab({ t, fmt, filters, setFilters }) {
      const limit = 50;
      const page = filters.page ?? 0;
      const query = {
        provider: filters.provider, model: filters.model, kind: filters.kind,
        sessionId: filters.sessionId, limit, offset: page * limit, order: 'desc',
      };
      const { loading, data, error, refresh } = useLoad(
        () => [['res', api('/records', query)]],
        [filters.provider, filters.model, filters.kind, filters.sessionId, page],
      );
      const setInput = (field, value) => setFilters((prev) => ({ ...prev, [field]: value, page: 0 }));
      const result = data?.res;
      const items = result?.items ?? [];
      const total = result?.total ?? 0;
      return h('div', null,
        h('div', { className: 'duc-filters' },
          h('input', {
            className: 'duc-input', placeholder: t('filter.provider'), value: filters.provider ?? '',
            onChange: (e) => setInput('provider', e.target.value),
          }),
          h('input', {
            className: 'duc-input', placeholder: t('filter.model'), value: filters.model ?? '',
            onChange: (e) => setInput('model', e.target.value),
          }),
          h('select', {
            className: 'duc-input', value: filters.kind ?? '',
            onChange: (e) => setInput('kind', e.target.value),
          },
            h('option', { value: '' }, t('filter.kind')),
            KIND_OPTIONS.map((kind) => h('option', { key: kind, value: kind }, kindLabel(kind, t))),
          ),
          h('input', {
            className: 'duc-input', placeholder: t('filter.session'),
            value: filters.sessionId ?? '', title: filters.sessionId || undefined,
            onChange: (e) => setInput('sessionId', e.target.value.trim()),
          }),
          (filters.provider || filters.model || filters.kind || filters.sessionId)
            ? h('button', {
              type: 'button', className: 'duc-iconbtn',
              onClick: () => setFilters({ page: 0 }),
            }, t('filter.clear')) : null,
        ),
        h(StateView, { loading, error, empty: !loading && total === 0, onRetry: refresh, t },
          h('div', { className: 'duc-tablewrap' },
            h('table', { className: 'duc-table' },
              h('thead', null, h('tr', null,
                h('th', null, t('table.time')),
                h('th', null, t('table.model')),
                h('th', null, t('table.kind')),
                h('th', { className: 'num' }, t('table.turnStep')),
                h('th', { className: 'num' }, t('table.input')),
                h('th', { className: 'num' }, t('table.output')),
                h('th', { className: 'num' }, t('table.cacheRead')),
                h('th', { className: 'num' }, t('table.total')),
                h('th', { className: 'num' }, t('table.firstToken')),
                h('th', { className: 'num' }, t('table.duration')),
                h('th', null, t('table.status')),
              )),
              h('tbody', null, items.map((r) => h('tr', { key: r.requestId, title: `${r.requestId}${r.errorMessage ? `\n${r.errorMessage}` : ''}` },
                h('td', null, fmt.dateTime(r.timestamp)),
                h('td', null, `${r.provider ?? '?'} / ${r.model ?? '?'}${r.origin === 'subagent' ? ' ⌥' : ''}`),
                h('td', null, kindLabel(r.kind, t)),
                h('td', { className: 'num' }, `${r.turn ?? '–'}/${r.step ?? '–'}`),
                h('td', { className: 'num' }, r.inputTokens === null ? '–' : fmt.compact(r.inputTokens)),
                h('td', { className: 'num' }, r.outputTokens === null ? '–' : fmt.compact(r.outputTokens)),
                h('td', { className: 'num' }, r.cacheReadTokens === null ? '–' : fmt.compact(r.cacheReadTokens)),
                h('td', { className: 'num' }, fmt.compact(r.totalTokens)),
                h('td', { className: 'num' }, fmt.ms(r.firstTokenLatencyMs)),
                h('td', { className: 'num' }, fmt.ms(r.durationMs)),
                h('td', null,
                  r.errorCode !== null && r.errorCode !== undefined
                    ? h('span', { className: 'duc-badge err', title: `${r.errorCode}: ${r.errorMessage ?? ''}` }, `${t('status.error')} ${r.errorCode}`)
                    : h('span', { className: 'duc-badge ok' }, t('status.ok')),
                ),
              ))),
            ),
          ),
          h('div', { className: 'duc-pager' },
            h('button', { type: 'button', disabled: page === 0, onClick: () => setFilters((prev) => ({ ...prev, page: page - 1 })) }, t('page.prev')),
            h('span', null, t('page.status', {
              from: total === 0 ? 0 : page * limit + 1,
              to: Math.min((page + 1) * limit, total),
              total,
            })),
            h('button', { type: 'button', disabled: (page + 1) * limit >= total, onClick: () => setFilters((prev) => ({ ...prev, page: page + 1 })) }, t('page.next')),
          ),
        ),
      );
    }

    function LedgerTab({ t, fmt, onOpenSession }) {
      const limit = 50;
      const [page, setPage] = useState(0);
      const { loading, data, error, refresh } = useLoad(
        () => [['res', api('/sessions', { limit, offset: page * limit })]],
        [page],
      );
      const result = data?.res;
      const items = result?.items ?? [];
      const total = result?.total ?? 0;
      return h('div', null,
        h(StateView, { loading, error, empty: !loading && total === 0, onRetry: refresh, t },
          h('div', { className: 'duc-tablewrap' },
            h('table', { className: 'duc-table' },
              h('thead', null, h('tr', null,
                h('th', null, t('table.session')),
                h('th', null, t('table.workspace')),
                h('th', null, t('table.created')),
                h('th', { className: 'num' }, t('table.requests')),
                h('th', { className: 'num' }, t('table.input')),
                h('th', { className: 'num' }, t('table.output')),
                h('th', { className: 'num' }, t('table.total')),
                h('th', { className: 'num' }, t('table.errors')),
                h('th', null, t('table.lastActivity')),
                h('th', { 'aria-hidden': 'true' }),
              )),
              h('tbody', null, items.map((s) =>
                h('tr', {
                  key: s.sessionId, className: 'clickable',
                  title: `${s.sessionId}${s.parentSessionId ? `\n← ${s.parentSessionId}` : ''}${s.cwd ? `\n${s.cwd}` : ''}`,
                  onClick: () => onOpenSession(s.sessionId),
                },
                  h('td', null,
                    h('span', { className: 'duc-muted' }, `${s.sessionId.slice(0, 16)}… `),
                    h('span', { className: 'duc-badge' },
                      s.origin === 'subagent' ? t('origin.subagent') : s.origin === null ? t('origin.main') : s.origin),
                  ),
                  h('td', null, s.cwd === null ? '' : s.cwd.split(/[\\/]/).pop() || s.cwd),
                  h('td', null, fmt.date(s.createdAt)),
                  h('td', { className: 'num' }, fmt.int(s.requests)),
                  h('td', { className: 'num' }, fmt.compact(s.inputTokens)),
                  h('td', { className: 'num' }, fmt.compact(s.outputTokens)),
                  h('td', { className: 'num' }, fmt.compact(s.totalTokens)),
                  h('td', { className: 'num' }, s.errorCount > 0 ? h('span', { className: 'duc-error' }, fmt.int(s.errorCount)) : h('span', { className: 'duc-muted' }, '–')),
                  h('td', null, fmt.dateTime(s.lastTimestamp)),
                  h('td', { className: 'duc-muted', 'aria-hidden': 'true' }, '›'),
                ))),
            ),
          ),
          h('div', { className: 'duc-pager' },
            h('button', { type: 'button', disabled: page === 0, onClick: () => setPage(page - 1) }, t('page.prev')),
            h('span', null, t('page.status', {
              from: total === 0 ? 0 : page * limit + 1,
              to: Math.min((page + 1) * limit, total),
              total,
            })),
            h('button', { type: 'button', disabled: (page + 1) * limit >= total, onClick: () => setPage(page + 1) }, t('page.next')),
          ),
        ),
      );
    }

    function CostsTab({ t, fmt, range }) {
      const from = Date.now() - range * 86_400_000;
      const { loading, data, error, refresh } = useLoad(
        () => [
          ['costs', api('/costs', { from })],
          ['basis', api('/breakdown', { by: 'model' })],
        ],
        [range],
      );
      const costs = data?.costs;
      const basisRows = data?.basis?.rows ?? [];
      if (costs !== undefined && costs.configured) {
        const { byCurrency, byModel, coverage } = costs;
        return h(StateView, { loading, error, empty: !loading && byModel.length === 0, onRetry: refresh, t },
          h('div', { className: 'duc-grid' },
            byCurrency.map((c) => h(StatCard, {
              key: c.currency,
              title: `≈ ${c.currency}`,
              value: fmt.money(c.totalMicro, c.currency),
              sub: `${t('costs.estimate')} · ${fmt.int(c.requests)}`,
            })),
            h(StatCard, {
              title: t('costs.coverage'),
              value: coverage.totalRequests > 0
                ? `${Math.round((coverage.pricedRequests / coverage.totalRequests) * 100)}%`
                : '–',
              sub: `${fmt.int(coverage.pricedRequests)} / ${fmt.int(coverage.totalRequests)}`,
            }),
          ),
          h('div', { className: 'duc-section' },
            h('div', { className: 'duc-section-head' },
              h('h3', { className: 'duc-section-title' }, `≈ ${t('costs.estimate')}`),
              h('span', { className: 'duc-small duc-muted' }, byCurrency.map((c) => c.currency).join(' · ')),
            ),
            h('div', { className: 'duc-tablewrap' },
              h('table', { className: 'duc-table' },
                h('thead', null, h('tr', null,
                  h('th', null, t('table.model')),
                  h('th', { className: 'num' }, t('table.requests')),
                  h('th', { className: 'num' }, t('table.total')),
                  h('th', { className: 'num' }, `≈ ${t('table.cost')}`),
                )),
                h('tbody', null, byModel.map((row) => h('tr', {
                  key: `${row.key}|${row.currency}`,
                  title: row.missingCount > 0 ? `⚠ ${row.missingCount}` : undefined,
                },
                  h('td', null, row.key),
                  h('td', { className: 'num' }, fmt.int(row.requests)),
                  h('td', { className: 'num' }, fmt.compact(row.totalTokens)),
                  h('td', { className: 'num' },
                    fmt.money(row.totalMicro, row.currency),
                    row.missingCount > 0 ? ' ⚠' : ''),
                ))),
              ),
            ),
          ),
        );
      }
      // No price lists configured: pricing basis + reference-price suggestions.
      return h(StateView, { loading, error, empty: !loading && basisRows.length === 0, onRetry: refresh, t },
        h('div', { className: 'duc-section' },
          h('div', { className: 'duc-section-head' },
            h('h3', { className: 'duc-section-title' }, t('costs.basis')),
            h('span', { className: 'duc-small duc-muted' }, t('costs.pending')),
          ),
          h('div', { className: 'duc-tablewrap' },
            h('table', { className: 'duc-table' },
              h('thead', null, h('tr', null,
                h('th', null, t('table.model')),
                h('th', { className: 'num' }, t('table.requests')),
                h('th', { className: 'num' }, t('table.input')),
                h('th', { className: 'num' }, t('table.output')),
                h('th', { className: 'num' }, t('table.cacheRead')),
                h('th', { className: 'num' }, t('table.cacheWrite')),
                h('th', { className: 'num' }, t('table.total')),
              )),
              h('tbody', null, basisRows.map((row) => h('tr', { key: row.key },
                h('td', null, row.key),
                h('td', { className: 'num' }, fmt.int(row.requests)),
                h('td', { className: 'num' }, fmt.int(row.inputTokens)),
                h('td', { className: 'num' }, fmt.int(row.outputTokens)),
                h('td', { className: 'num' }, fmt.int(row.cacheReadTokens)),
                h('td', { className: 'num' }, fmt.int(row.cacheWriteTokens)),
                h('td', { className: 'num' }, fmt.compact(row.totalTokens)),
              ))),
            ),
          ),
        ),
        h(PriceSuggest, { t, fmt }),
      );
    }

    /** Fetch reference prices from the public listing; suggestions only. */
    function PriceSuggest({ t, fmt }) {
      const [state, setState] = useState({ loading: false, data: null, error: null });
      const [copied, setCopied] = useState(false);
      const load = () => {
        setState((prev) => ({ ...prev, loading: true, error: null }));
        api('/prices/suggest')
          .then((data) => { setCopied(false); setState({ loading: false, data, error: null }); })
          .catch((error) => setState({ loading: false, data: null, error: String(error?.message ?? error) }));
      };
      const data = state.data;
      return h('div', { className: 'duc-section' },
        h('div', { className: 'duc-section-head' },
          h('h3', { className: 'duc-section-title' }, t('costs.suggest')),
          h('span', { className: 'duc-small duc-muted' },
            'OpenRouter · USD',
            h('button', {
              type: 'button', className: 'duc-iconbtn', style: { marginLeft: 10 },
              onClick: load, disabled: state.loading,
            }, state.loading ? t('state.loading') : t('costs.fetch')),
          ),
        ),
        state.error !== null
          ? h('div', { className: 'duc-state' },
              h('div', { className: 'duc-error' }, `${t('state.error')} — ${state.error}`),
              h('br'),
              h('button', { type: 'button', className: 'duc-iconbtn', onClick: load }, t('state.retry')),
            )
          : null,
        data !== null
          ? h('div', { className: 'duc-tablewrap' },
              h('table', { className: 'duc-table' },
                h('thead', null, h('tr', null,
                  h('th', null, t('table.model')),
                  h('th', null, t('costs.matched')),
                  h('th', { className: 'num' }, t('table.input')),
                  h('th', { className: 'num' }, t('table.output')),
                  h('th', { className: 'num' }, t('table.cacheRead')),
                )),
                h('tbody', null, data.matches.map((m) => h('tr', { key: `${m.provider}/${m.model}` },
                  h('td', null, `${m.provider ?? '?'}/${m.model}`),
                  h('td', null,
                    h('span', { className: 'duc-badge' }, m.key),
                    ' ',
                    h('span', { className: 'duc-small duc-muted' }, m.confidence),
                  ),
                  h('td', { className: 'num' }, m.entry.input === undefined ? '–' : fmt.money(m.entry.input * 1e6, 'USD')),
                  h('td', { className: 'num' }, m.entry.output === undefined ? '–' : fmt.money(m.entry.output * 1e6, 'USD')),
                  h('td', { className: 'num' }, m.entry.cacheRead === undefined ? '–' : fmt.money(m.entry.cacheRead * 1e6, 'USD')),
                ))),
              ),
              data.unmatched.length > 0
                ? h('div', { className: 'duc-chips' },
                    data.unmatched.map((u) => h('span', {
                      key: `${u.provider}/${u.model}`,
                      className: 'duc-badge', title: t('costs.unmatched'),
                    }, `${u.provider ?? '?'}/${u.model ?? '?'} · ${t('costs.unmatched')}`)),
                  )
                : null,
              h('div', { className: 'duc-section-head', style: { marginTop: 10, marginBottom: 0 } },
                h('span', { className: 'duc-small duc-muted' }, t('costs.paste')),
                h('button', {
                  type: 'button', className: 'duc-iconbtn', onClick: () => {
                    if (data.yaml !== undefined && navigator.clipboard !== undefined) {
                      navigator.clipboard.writeText(data.yaml).then(
                        () => setCopied(true),
                        () => {},
                      );
                    }
                  },
                }, copied ? t('costs.copied') : t('costs.copy')),
              ),
              h('pre', { className: 'duc-pre' }, data.yaml),
            )
          : null,
      );
    }

    function ContextTab({ t }) {
      return h('div', { className: 'duc-state' }, t('context.pending'));
    }

    // -------------------------------------------------------------- dashboard

    const TABS = ['overview', 'requests', 'ledger', 'costs', 'context'];

    function DashboardView({ env }) {
      const [tab, setTab] = useState('overview');
      const [range, setRange] = useState(30);
      const [filters, setFilters] = useState({ page: 0 });
      const active = React.useSyncExternalStore(
        (callback) => env.locale.subscribe(callback),
        () => env.locale.getSnapshot().active,
      );
      const lang = languageOf(active);
      const t = useMemo(() => {
        const dict = DICTS[lang];
        return (key, params) => interpolate(dict[key] ?? DICTS.en[key] ?? key, params);
        // eslint-disable-next-line react-hooks/exhaustive-deps
      }, [lang]);
      const fmt = useMemo(() => ({
        ...makeFormatters(active),
        money: makeMoneyFormatter(typeof active === 'string' && active.length > 0 ? active : 'en'),
      }), [active]);
      const overview = useLoad(
        () => [
          ['summary', api('/summary')],
          ['models', api('/breakdown', { by: 'model' })],
          ['trend', api('/trend', { days: range })],
          ['heat', api('/trend', { days: 182 })],
        ],
        [range],
      );
      const overviewData = overview.data !== null && overview.data !== undefined ? {
        totals: overview.data.summary.totals,
        today: overview.data.summary.today,
        byModel: overview.data.models.rows,
        trendPoints: overview.data.trend.points,
        heatPoints: overview.data.heat.points,
        costs: overview.data.summary.costs,
      } : null;
      return h('div', { className: 'duc-root' },
        h('header', { className: 'duc-header' },
          env.layout !== undefined && env.layout !== null
            ? h('button', {
              type: 'button', className: 'duc-back',
              onClick: () => env.layout.selectPanel(null),
              title: t('nav.back'),
            }, '← ', t('nav.back'))
            : null,
          h('h1', { className: 'duc-title' }, t('panel.title')),
          h('div', { className: 'duc-tabs', role: 'tablist' },
            TABS.map((key) => h('button', {
              key, type: 'button', className: 'duc-tab', role: 'tab',
              'aria-selected': tab === key,
              onClick: () => setTab(key),
            }, t(`tabs.${key}`))),
          ),
          h('div', { className: 'duc-spacer' }),
          (tab === 'overview' || tab === 'costs')
            ? h('div', { className: 'duc-range', role: 'group', 'aria-label': t('range.label') },
              [7, 30, 90].map((days) => h('button', {
                key: days, type: 'button', 'aria-pressed': range === days,
                onClick: () => setRange(days),
              }, t(`range.${days}`))))
            : null,
          tab === 'overview'
            ? h('button', {
              type: 'button', className: 'duc-iconbtn', title: t('nav.refresh'),
              onClick: () => { overview.refresh(); },
            }, '⟳')
            : null,
        ),
        h('main', { className: 'duc-body' },
          tab === 'overview'
            ? h(StateView, {
              loading: overview.loading, error: overview.error,
              empty: overviewData !== null && overviewData.totals.requests === 0,
              onRetry: overview.refresh, t,
            }, overviewData === null ? null : h(OverviewTab, {
              t, fmt, range, data: overviewData,
            }))
            : null,
          tab === 'requests' ? h(RequestsTab, { t, fmt, filters, setFilters }) : null,
          tab === 'ledger' ? h(LedgerTab, {
            t, fmt, onOpenSession: (sessionId) => {
              setFilters({ sessionId, page: 0 });
              setTab('requests');
            },
          }) : null,
          tab === 'costs' ? h(CostsTab, { t, fmt, range }) : null,
          tab === 'context' ? h(ContextTab, { t }) : null,
        ),
      );
    }

    // ------------------------------------------------------------ panel glyph

    function PanelGlyph({ size = 16, active = false }) {
      // Miniature of the package icon (ledger page + usage bars), currentColor.
      return h('svg', {
        className: 'duc-glyph', 'data-active': active ? 'true' : 'false',
        viewBox: '0 0 64 64', width: size, height: size,
        'aria-hidden': 'true', focusable: 'false',
      },
        h('rect', { x: 10, y: 6, width: 44, height: 52, rx: 6, fill: 'currentColor', opacity: 0.18 }),
        h('rect', { x: 10, y: 6, width: 44, height: 52, rx: 6, fill: 'none', stroke: 'currentColor', 'stroke-width': 4 }),
        h('rect', { x: 21, y: 36, width: 6, height: 12, rx: 2, fill: 'currentColor', opacity: 0.55 }),
        h('rect', { x: 29, y: 30, width: 6, height: 18, rx: 2, fill: 'currentColor', opacity: 0.75 }),
        h('rect', { x: 37, y: 22, width: 6, height: 26, rx: 2, fill: 'currentColor' }),
      );
    }

    // ------------------------------------------------------------------ apply

    const inject = ['slots', 'locale'];

    function apply(ctx) {
      const offLocale = ctx.locale.register(NS, DICTS);
      ctx.effect(() => offLocale, 'usage-center: locale dictionaries');

      const style = document.createElement('style');
      style.dataset.plugin = 'dsh-usage-center';
      style.textContent = css;
      document.head.appendChild(style);
      ctx.effect(() => () => { style.remove(); }, 'usage-center: styles');

      const panelLabel = () =>
        DICTS[languageOf(ctx.locale.getSnapshot().active)]['panel.title'];

      // Data slot: the sidebar renders the row (button, tooltip, active
      // state) from these options and wires the click to
      // ctx.layout.selectPanel('usage-center') itself.
      ctx.slots.inject('sidebar.panellist', () => ctx.slots.register({
        name: 'sidebar.panellist',
        id: 'usage-center',
        order: 40,
        label: panelLabel,
      }, PanelGlyph));

      // Keyed main panel: rendered while it is the active panel id.
      const env = { locale: ctx.locale, layout: ctx.get('layout') };
      ctx.slots.inject('main', () => ctx.slots.register({
        name: 'main',
        key: 'usage-center',
        label: panelLabel,
      }, () => h(DashboardView, { env })));
    }

    return { inject, apply };
  },
});
