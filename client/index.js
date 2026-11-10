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
      'trend.all': '总览',
      'trend.provider': '提供商',
      'trend.model': '模型',
      'trend.other': '其他',
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
      'costs.price': '单价 /1M',
      'costs.suggest': '参考价…',
      'costs.imported': '参考价已写入配置，插件重载后生效',
      'suggest.title': '导入参考价',
      'suggest.source': '来源：OpenRouter 公开价（USD / 1M tokens）',
      'suggest.disclaimer': '参考价仅供估算，不等于你的实际账单；只写入勾选的行。',
      'suggest.match': '匹配',
      'suggest.match.exact': '精确',
      'suggest.match.suffix': '一致',
      'suggest.match.fuzzy': '近似',
      'suggest.match.none': '无匹配',
      'suggest.fetching': '正在从 OpenRouter 拉取…',
      'suggest.import': '导入所选',
      'suggest.importing': '导入中…',
      'suggest.cancel': '取消',
      'context.pending': '上下文监控尚未提供',
      'context.window': '窗口',
      'context.compactions': '压缩',
      'context.back': '返回',
      'context.series': '上下文走势',
      'context.latest': '最新会话',
      'context.selected': '所选会话',
      'context.lastInput': '最近输入',
      'context.delta': '较上次',
      'context.prev': '上次',
      'context.maxInput': '历史最大输入',
      'context.modelSwitched': '期间切换过模型',
      'context.ofWindow': '占窗口',
      'context.noWindow': '窗口未知（无声明）',
      'context.windowNote': '窗口差额 ≠ 可安全使用的输入预算',
      'context.observed': '观测/请求',
      'context.noUsage': '无可观测用量',
      'ledger.subagents': '子代理',
      'ledger.expand': '展开/收起子代理',
      'ledger.capped': '会话超过 200，仅显示前 {n} 个',
      'table.updated': '更新',
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
      'trend.all': 'All',
      'trend.provider': 'Provider',
      'trend.model': 'Model',
      'trend.other': 'Other',
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
      'costs.price': 'Price /1M',
      'costs.suggest': 'Reference prices…',
      'costs.imported': 'Reference prices written to config; applies after the plugin reloads',
      'suggest.title': 'Import reference prices',
      'suggest.source': 'Source: OpenRouter public prices (USD / 1M tokens)',
      'suggest.disclaimer': 'Reference prices are estimates only, not your actual bill; only checked rows are written.',
      'suggest.match': 'Match',
      'suggest.match.exact': 'exact',
      'suggest.match.suffix': 'id match',
      'suggest.match.fuzzy': 'approx.',
      'suggest.match.none': 'no match',
      'suggest.fetching': 'Fetching from OpenRouter…',
      'suggest.import': 'Import selected',
      'suggest.importing': 'Importing…',
      'suggest.cancel': 'Cancel',
      'context.pending': 'Context monitor is not available yet',
      'context.window': 'Window',
      'context.compactions': 'Compactions',
      'context.back': 'Back',
      'context.series': 'Context series',
      'context.latest': 'Latest session',
      'context.selected': 'Selected session',
      'context.lastInput': 'Last input',
      'context.delta': 'vs previous',
      'context.prev': 'Previous',
      'context.maxInput': 'Max input',
      'context.modelSwitched': 'model changed in between',
      'context.ofWindow': 'of window',
      'context.noWindow': 'Window unknown (no declaration)',
      'context.windowNote': 'window headroom is not a safe input budget',
      'context.observed': 'observed/requests',
      'context.noUsage': 'no observable usage',
      'ledger.subagents': 'sub-agents',
      'ledger.expand': 'Expand/collapse sub-agents',
      'ledger.capped': 'More than 200 sessions; showing first {n}',
      'table.updated': 'Updated',
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

    function apiPost(path, body) {
      return fetch(API_BASE + path, {
        method: 'POST',
        headers: { 'content-type': 'application/json', accept: 'application/json' },
        body: JSON.stringify(body ?? {}),
      }).then(async (res) => {
        const payload = await res.json().catch(() => ({}));
        if (!res.ok) throw new Error(payload?.error ?? `HTTP ${res.status}`);
        return payload;
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

    // ------------------------------------------------------------- colors
    // Adaptive palette: at boot the client probes whether the host theme
    // tokens are reachable (computed custom property on the document root).
    // Themed mode paints with var(--token, literal-fallback); literal mode
    // paints with the same fallback literals directly. Either way the panel
    // is readable; themed mode additionally follows the host theme.
    // NEVER use color-mix() here: this engine rejects it on SVG paints.
    const LITERAL = {
      brand: '#4e6ef2',
      success: '#10b981',
      warn: '#f59e0b',
      error: '#ef4444',
      idle: '#94a3b8',
      labelSecondary: '#8b909d',
      borderL1: 'rgba(128,134,145,.28)',
      borderL2: 'rgba(128,134,145,.5)',
      bgLayer1: 'rgba(127,127,127,.05)',
      bgLayer2: 'rgba(127,127,127,.1)',
      hoverBg: 'rgba(127,127,127,.12)',
      rowHover: 'rgba(127,127,127,.07)',
    };

    function buildColors(themed) {
      if (!themed) {
        return {
          ...LITERAL,
          palette: ['#4e6ef2', '#10b981', '#f59e0b', '#8b5cf6', '#06b6d4', '#f43f5e', '#64748b'],
          seriesAll: [
            { color: 'rgba(78,110,242,.16)' },
            { color: 'rgba(78,110,242,.35)' },
            { color: 'rgba(78,110,242,.65)' },
            { color: 'rgba(78,110,242,.95)' },
          ],
          heatRamp: [
            { bg: '#c3d0f7' }, { bg: '#8fa6f4' }, { bg: '#4e6ef2' }, { bg: '#2c46c9' },
          ],
          // Opaque modal surfaces — the 5% translucent bgLayer1 fallback made
          // dialog text overlap the page behind it (looked like broken paint).
          modalBg: '#ffffff',
          modalBgDark: '#22252d',
          modalText: '#1f2328',
          modalTextDark: '#e6e8eb',
        };
      }
      const t = (token, literal) => `var(${token}, ${literal})`;
      const brand = t('--dsw-alias-brand-primary', LITERAL.brand);
      const success = t('--dsw-alias-state-success-primary', LITERAL.success);
      const warn = t('--dsw-alias-state-warn-primary', LITERAL.warn);
      const idle = t('--dsw-alias-state-idle-primary', LITERAL.idle);
      return {
        brand,
        success,
        warn,
        error: t('--dsw-alias-state-error-primary', LITERAL.error),
        idle,
        labelSecondary: t('--dsw-alias-label-secondary', LITERAL.labelSecondary),
        borderL1: t('--dsw-alias-border-l1', LITERAL.borderL1),
        borderL2: t('--dsw-alias-border-l2', LITERAL.borderL2),
        bgLayer1: t('--dsw-alias-bg-layer-1', LITERAL.bgLayer1),
        bgLayer2: t('--dsw-alias-bg-layer-2', LITERAL.bgLayer2),
        hoverBg: t('--dsw-alias-bg-layer-2', LITERAL.hoverBg),
        rowHover: t('--dsw-alias-bg-layer-1', LITERAL.rowHover),
        palette: [brand, success, warn, '#8b5cf6', '#06b6d4', '#f43f5e', idle],
        seriesAll: [
          { color: brand, opacity: 0.16 },
          { color: brand, opacity: 0.35 },
          { color: brand, opacity: 0.65 },
          { color: brand, opacity: 0.95 },
        ],
        heatRamp: [
          { bg: brand, opacity: 0.35 }, { bg: brand, opacity: 0.55 },
          { bg: brand, opacity: 0.78 }, { bg: brand, opacity: 0.95 },
        ],
        // Themed mode: the token IS an opaque surface color in every DSH
        // theme, so both schemes reference it directly.
        modalBg: t('--dsw-alias-bg-layer-1', '#ffffff'),
        modalBgDark: t('--dsw-alias-bg-layer-1', '#22252d'),
        modalText: t('--dsw-alias-label-primary', '#1f2328'),
        modalTextDark: t('--dsw-alias-label-primary', '#e6e8eb'),
      };
    }

    /** Probe host theme tokens from the client document. Never throws. */
    function themeTokensReachable() {
      try {
        const value = getComputedStyle(document.documentElement)
          .getPropertyValue('--dsw-alias-brand-primary');
        return typeof value === 'string' && value.trim().length > 0;
      } catch {
        return false;
      }
    }

    let C = buildColors(false);

    function buildCss(colors) {
      const ramp = (level) => {
        const entry = colors.heatRamp[level - 1];
        return `background:${entry.bg}${entry.opacity !== undefined ? `;opacity:${entry.opacity}` : ''}`;
      };
      return `
.duc-root{height:100%;min-height:0;display:flex;flex-direction:column;background:transparent;color:inherit;font-size:14px}
.duc-header{display:flex;align-items:center;gap:12px;padding:10px 20px;border-bottom:1px solid ${colors.borderL1};flex:none;flex-wrap:wrap}
.duc-back{border:none;background:transparent;color:${colors.labelSecondary};cursor:pointer;display:inline-flex;align-items:center;gap:6px;padding:6px 8px;border-radius:6px;font:inherit}
.duc-back:hover{background:${colors.hoverBg};color:inherit}
.duc-title{font-size:16px;font-weight:600;margin:0}
.duc-spacer{flex:1}
.duc-tabs{display:flex;gap:2px;padding:4px;background:${colors.bgLayer2};border-radius:8px}
.duc-tab{border:none;background:transparent;color:${colors.labelSecondary};cursor:pointer;padding:5px 12px;border-radius:6px;font:inherit}
.duc-tab:hover{color:inherit}
.duc-tab[aria-selected=true]{background:${colors.bgLayer1};color:inherit;box-shadow:0 1px 2px rgba(0,0,0,.08)}
.duc-range{display:inline-flex;gap:0;border:1px solid ${colors.borderL1};border-radius:6px;overflow:hidden}
.duc-range button{border:none;background:transparent;color:${colors.labelSecondary};padding:5px 10px;cursor:pointer;font:inherit}
.duc-range button[aria-pressed=true]{background:${colors.bgLayer2};color:inherit}
.duc-iconbtn{border:1px solid ${colors.borderL1};background:${colors.bgLayer1};color:${colors.labelSecondary};border-radius:6px;padding:5px 10px;cursor:pointer;font:inherit}
.duc-iconbtn:hover{color:inherit}
.duc-body{flex:1;min-height:0;overflow:auto;padding:16px 20px 24px}
.duc-grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(170px,1fr));gap:12px;margin-bottom:16px}
.duc-card{min-width:0;border:1px solid ${colors.borderL1};border-radius:10px;padding:14px 16px}
.duc-card-title{font-size:12px;color:${colors.labelSecondary};margin-bottom:6px;font-weight:500;letter-spacing:.02em}
.duc-stat-value{font-size:22px;font-weight:600;line-height:1.2}
.duc-stat-sub{font-size:12px;color:${colors.labelSecondary};margin-top:4px}
.duc-section{border:1px solid ${colors.borderL1};border-radius:10px;padding:14px 16px;margin-bottom:16px}
.duc-section-title{font-size:13px;font-weight:600;margin:0 0 10px}
.duc-section-head{display:flex;align-items:baseline;justify-content:space-between;gap:10px;margin:0 0 10px}
.duc-section-head .duc-section-title{margin:0}
.duc-small{font-size:12px}
.duc-pre{margin:10px 0 0;padding:10px 12px;background:${colors.bgLayer2};border:1px solid ${colors.borderL1};border-radius:8px;font-family:ui-monospace,Consolas,monospace;font-size:12px;line-height:1.5;white-space:pre;overflow:auto;max-height:260px}
.duc-bar{width:64px;height:6px;background:${colors.bgLayer2};border-radius:3px;overflow:hidden;display:inline-block;vertical-align:middle}
.duc-bar i{display:block;height:100%;background:${colors.brand}}
.duc-chips{display:flex;gap:6px;flex-wrap:wrap;margin-top:8px}
.duc-tablewrap{overflow:auto}
.duc-table{border-collapse:collapse;width:100%;font-size:13px}
.duc-table th{text-align:left;color:${colors.labelSecondary};font-weight:500;padding:6px 10px;border-bottom:1px solid ${colors.borderL2};white-space:nowrap}
.duc-table td{padding:7px 10px;white-space:nowrap;vertical-align:top}
.duc-table td.num,.duc-table th.num{text-align:right;font-variant-numeric:tabular-nums}
.duc-table tr:hover td{background:${colors.rowHover}}
.duc-table tr.clickable{cursor:pointer}
.duc-muted{color:${colors.labelSecondary}}
.duc-error{color:${colors.error}}
.duc-badge{display:inline-block;padding:1px 8px;border-radius:999px;font-size:11.5px;border:1px solid ${colors.borderL1};color:${colors.labelSecondary}}
.duc-badge.err{border-color:${colors.error};color:${colors.error}}
.duc-badge.ok{border-color:${colors.success};color:${colors.success}}
.duc-filters{display:flex;gap:8px;flex-wrap:wrap;margin-bottom:12px;align-items:center}
.duc-input{background:transparent;border:1px solid ${colors.borderL1};border-radius:6px;color:inherit;padding:5px 9px;font:inherit;min-width:130px}
.duc-input::placeholder{color:${colors.labelSecondary}}
.duc-input:focus{outline:2px solid ${colors.brand};outline-offset:-1px}
select.duc-input{min-width:100px}
.duc-pager{display:flex;align-items:center;gap:10px;justify-content:flex-end;margin-top:10px;color:${colors.labelSecondary};font-size:12.5px}
.duc-pager button{border:1px solid ${colors.borderL1};background:${colors.bgLayer1};color:inherit;border-radius:6px;padding:4px 10px;cursor:pointer;font:inherit}
.duc-pager button:disabled{opacity:.45;cursor:default}
.duc-state{padding:40px 0;text-align:center;color:${colors.labelSecondary}}
.duc-state button{margin-top:10px}
.duc-legend{display:flex;gap:14px;flex-wrap:wrap;font-size:12px;color:${colors.labelSecondary};margin-bottom:8px}
.duc-legend span{display:inline-flex;align-items:center;gap:5px}
.duc-swatch{width:10px;height:10px;border-radius:2px;display:inline-block}
.duc-trend{width:100%;height:auto;display:block}
.duc-heatwrap{display:flex;gap:8px}
.duc-heatgrid{display:grid;grid-auto-flow:column;grid-template-rows:repeat(7,1fr);gap:3px;overflow-x:auto;padding-bottom:4px}
.duc-cell{width:11px;height:11px;border-radius:2.5px;background:rgba(148,163,184,.25)}
.duc-cell[data-level="1"]{${ramp(1)}}
.duc-cell[data-level="2"]{${ramp(2)}}
.duc-cell[data-level="3"]{${ramp(3)}}
.duc-cell[data-level="4"]{${ramp(4)}}
.duc-heatlegend{display:flex;align-items:center;gap:4px;font-size:12px;color:${colors.labelSecondary};margin-top:8px}
.duc-expander{border:none;background:transparent;color:${colors.labelSecondary};cursor:pointer;padding:0 4px;font:inherit;width:14px;line-height:1}
.duc-expander:hover{color:inherit}
.duc-glyph{color:${colors.labelSecondary}}
.duc-glyph[data-active=true]{color:inherit}
.duc-mask{position:fixed;inset:0;background:rgba(0,0,0,.45);display:flex;align-items:center;justify-content:center;z-index:60}
.duc-modal{background:${colors.modalBg};color:${colors.modalText};border:1px solid ${colors.borderL2};border-radius:10px;width:min(92vw,680px);max-height:80vh;display:flex;flex-direction:column;padding:16px;box-shadow:0 12px 40px rgba(0,0,0,.25)}
@media (prefers-color-scheme: dark){.duc-modal{background:${colors.modalBgDark};color:${colors.modalTextDark}}}
.duc-modal-title{font-size:14px;font-weight:600;margin:0 0 4px}
.duc-modal-body{min-height:0;overflow:auto;margin-top:10px}
.duc-modal-foot{display:flex;gap:8px;justify-content:flex-end;margin-top:12px}
.duc-modal-foot .duc-iconbtn[disabled]{opacity:.5;cursor:default}
`;
    }

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

    // Token categories for the "all" view (stacked bottom-up). Colors come
    // from the adaptive set `C` (see buildColors): themed mode paints brand
    // with per-segment opacity, literal mode uses the fixed rgba ramp. Never
    // color-mix() — this engine rejects it on SVG paints.
    const SERIES = [
      { key: 'cacheWriteTokens', label: 'chart.cacheWrite' },
      { key: 'cacheReadTokens', label: 'chart.cacheRead' },
      { key: 'inputTokens', label: 'chart.input' },
      { key: 'outputTokens', label: 'chart.output' },
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

    /**
     * Stacked daily bars. `by === 'all'` stacks the four token categories per
     * day; provider/model views stack the per-key series (top keys + other).
     */
    function TrendChart({ points, series, by, t, fmt }) {
      const W = 720;
      const H = 190;
      const PAD_L = 46;
      const PAD_B = 18;
      const PAD_T = 6;
      const plotW = W - PAD_L - 8;
      const plotH = H - PAD_B - PAD_T;
      const days = by === 'all' ? points : (series[0]?.points ?? []);
      const dayTotal = (day) => {
        if (by === 'all') {
          const point = points.find((p) => p.day === day);
          return point === undefined ? 0 : point.totalTokens;
        }
        let sum = 0;
        for (const s of series) {
          const point = s.points.find((p) => p.day === day);
          if (point !== undefined) sum += point.totalTokens;
        }
        return sum;
      };
      const maxTotal = Math.max(...days.map((d) => dayTotal(d.day ?? d)), 0);
      const yMax = niceCeil(maxTotal);
      const barW = Math.max(1, (plotW / Math.max(days.length, 1)) * 0.72);
      const step = plotW / Math.max(days.length, 1);
      const y = (value) => PAD_T + plotH - (value / yMax) * plotH;
      const labelIdx = days.length <= 1 ? [] : [0, Math.floor((days.length - 1) / 2), days.length - 1];
      const legendItems = by === 'all'
        ? SERIES.map((s, i) => ({
          key: s.key, label: t(s.label), idx: i,
          color: C.seriesAll[i].color,
          opacity: C.seriesAll[i].opacity,
        }))
        : series.map((s, i) => ({
          key: s.key, label: s.key === 'other' ? t('trend.other') : s.key, idx: i,
          color: C.palette[i % C.palette.length],
        }));
      const segmentValue = (day, legend) => {
        if (by === 'all') {
          const point = points.find((p) => p.day === day);
          return Math.max(point?.[legend.key] ?? 0, 0);
        }
        const s = series[legend.idx];
        const point = s?.points.find((p) => p.day === day);
        return point === undefined ? 0 : point.totalTokens;
      };
      return h('div', null,
        h('div', { className: 'duc-legend' },
          legendItems.map((item) => h('span', { key: item.key },
            h('i', {
              className: 'duc-swatch',
              style: { background: item.color, opacity: item.opacity ?? 1 },
            }),
            item.label,
          )),
        ),
        h('svg', {
          className: 'duc-trend', viewBox: `0 0 ${W} ${H}`,
          role: 'img', 'aria-label': t('card.trend'),
        },
          [0, 0.5, 1].map((ratio) =>
            h('g', { key: ratio },
              h('line', {
                x1: PAD_L, x2: W - 8, y1: y(yMax * ratio), y2: y(yMax * ratio), strokeWidth: 1,
                style: { stroke: C.borderL1 },
              }),
              h('text', {
                x: PAD_L - 6, y: y(yMax * ratio) + 4, 'text-anchor': 'end', 'font-size': 10,
                style: { fill: C.labelSecondary },
              }, fmt.compact(yMax * ratio)),
            )),
          days.map((dayPoint, index) => {
            const day = dayPoint.day;
            const x = PAD_L + index * step + (step - barW) / 2;
            let stacked = 0;
            const total = dayTotal(day);
            const title = by === 'all'
              ? `${day} · ${fmt.int(total)} ${t('chart.tokensUnit')}`
              : `${day} · ${fmt.int(total)} ${t('chart.tokensUnit')}\n` + legendItems.map((item) => `${item.label}: ${fmt.int(segmentValue(day, item))}`).join('\n');
            return h('g', { key: day },
              h('title', null, title),
              legendItems.map((item) => {
                const value = segmentValue(day, item);
                if (value <= 0) return null;
                const y0 = y(stacked);
                stacked += value;
                const y1 = y(stacked);
                // y decreases as tokens grow: the segment height is y0 - y1
                // (y1 - y0 is negative for every positive segment).
                return h('rect', {
                  key: item.key, x, width: barW,
                  y: Math.min(y0, y1), height: Math.max(y0 - y1, 0.8),
                  opacity: item.opacity,
                  style: { fill: item.color },
                });
              }),
              stacked <= 0 && total > 0
                ? h('rect', { x, width: barW, y: y(total), height: 0.8, style: { fill: C.borderL2 } })
                : null,
            );
          }),
          labelIdx.map((index) =>
            h('text', {
              key: index,
              x: PAD_L + index * step + step / 2, y: H - 4, 'text-anchor': index === 0 ? 'start' : index === days.length - 1 ? 'end' : 'middle',
              'font-size': 10,
              style: { fill: C.labelSecondary },
            }, fmt.date(Date.parse(days[index].day + 'T00:00:00'))),
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

    function OverviewTab({ t, fmt, range, data, trendBy, setTrendBy }) {
      const { totals, today, byModel, trendPoints, heatPoints, costs, trendSeries } = data;
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
          h('div', { className: 'duc-section-head' },
            h('h3', { className: 'duc-section-title' },
              `${t('card.trend')} · ${t('card.rangeTotal')} ${fmt.compact(rangeTotals.tokens)} ${t('chart.tokensUnit')}`),
            h('div', { className: 'duc-range', role: 'group', 'aria-label': t('card.trend') },
              ['all', 'provider', 'model'].map((dim) => h('button', {
                key: dim, type: 'button', 'aria-pressed': trendBy === dim,
                onClick: () => setTrendBy(dim),
              }, t(`trend.${dim}`)))),
          ),
          h(TrendChart, {
            points: trendPoints, series: trendSeries ?? [], by: trendBy, t, fmt,
          }),
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
      // Dropdown facets: the distinct providers/models that actually exist in
      // the ledger (reuses the breakdown endpoints, busiest first).
      const facets = useLoad(
        () => [
          ['providers', api('/breakdown', { by: 'provider' })],
          ['models', api('/breakdown', { by: 'model' })],
        ],
        [],
      );
      const setInput = (field, value) => setFilters((prev) => ({ ...prev, [field]: value, page: 0 }));
      const providerOptions = (facets.data?.providers?.rows ?? [])
        .map((r) => r.key)
        .filter((key) => typeof key === 'string' && key.length > 0);
      const modelOptions = [...new Set((facets.data?.models?.rows ?? [])
        .map((r) => r.model)
        .filter((model) => typeof model === 'string' && model.length > 0))];
      const result = data?.res;
      const items = result?.items ?? [];
      const total = result?.total ?? 0;
      return h('div', null,
        h('div', { className: 'duc-filters' },
          h('select', {
            className: 'duc-input', value: filters.provider ?? '',
            onChange: (e) => setInput('provider', e.target.value),
          },
            h('option', { value: '' }, t('filter.provider')),
            providerOptions.map((p) => h('option', { key: p, value: p }, p)),
          ),
          h('select', {
            className: 'duc-input', value: filters.model ?? '',
            onChange: (e) => setInput('model', e.target.value),
          },
            h('option', { value: '' }, t('filter.model')),
            modelOptions.map((m) => h('option', { key: m, value: m }, m)),
          ),
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
      // Group subagents under their parent conversation and expand in place.
      // Loads up to 200 sessions (the paged ceiling) so the tree is complete.
      const { loading, data, error, refresh } = useLoad(
        () => [['res', api('/sessions', { limit: 200, offset: 0 })]],
        [],
      );
      const [expanded, setExpanded] = useState({});
      const result = data?.res;
      const items = result?.items ?? [];
      const total = result?.total ?? 0;

      const known = new Set(items.map((s) => s.sessionId));
      const byParent = new Map();
      for (const s of items) {
        if (s.parentSessionId === null || s.parentSessionId === undefined) continue;
        if (!known.has(s.parentSessionId)) continue; // orphan → root
        const list = byParent.get(s.parentSessionId) ?? [];
        list.push(s);
        byParent.set(s.parentSessionId, list);
      }
      for (const list of byParent.values()) {
        list.sort((a, b) => (a.lastTimestamp ?? 0) - (b.lastTimestamp ?? 0));
      }
      const roots = items.filter(
        (s) => s.parentSessionId === null || s.parentSessionId === undefined || !known.has(s.parentSessionId),
      );

      const renderRow = (s, depth) => {
        const kids = byParent.get(s.sessionId) ?? [];
        const isOpen = expanded[s.sessionId] === true;
        const row = h('tr', {
          key: s.sessionId, className: 'clickable',
          title: `${s.sessionId}${s.parentSessionId ? `\n← ${s.parentSessionId}` : ''}${s.cwd ? `\n${s.cwd}` : ''}`,
          onClick: () => onOpenSession(s.sessionId),
        },
          h('td', null,
            h('span', { style: { display: 'inline-flex', alignItems: 'center', gap: 6, paddingLeft: depth * 18 } },
              kids.length > 0
                ? h('button', {
                  type: 'button', className: 'duc-expander', 'aria-expanded': String(isOpen),
                  'aria-label': t('ledger.expand'),
                  onClick: (e) => {
                    e?.stopPropagation?.();
                    setExpanded((prev) => ({ ...prev, [s.sessionId]: !(prev[s.sessionId] === true) }));
                  },
                }, isOpen ? '▾' : '▸')
                : h('span', { style: { display: 'inline-block', width: 14 }, 'aria-hidden': 'true' }),
              h('span', null, sessionName(s)),
              kids.length > 0
                ? h('span', { className: 'duc-badge' }, `${t('ledger.subagents')} ${kids.length}`)
                : null,
              s.origin === 'subagent' ? h('span', { className: 'duc-badge' }, t('origin.subagent')) : null,
            )),
          h('td', null, s.cwd === null ? '' : s.cwd.split(/[\\/]/).pop() || s.cwd),
          h('td', null, fmt.date(s.createdAt)),
          h('td', { className: 'num' }, fmt.int(s.requests)),
          h('td', { className: 'num' }, fmt.compact(s.inputTokens)),
          h('td', { className: 'num' }, fmt.compact(s.outputTokens)),
          h('td', { className: 'num' }, fmt.compact(s.totalTokens)),
          h('td', { className: 'num' }, s.errorCount > 0 ? h('span', { className: 'duc-error' }, fmt.int(s.errorCount)) : h('span', { className: 'duc-muted' }, '–')),
          h('td', null, fmt.dateTime(s.lastTimestamp)),
          h('td', { className: 'duc-muted', 'aria-hidden': 'true' }, '›'),
        );
        const rows = [row];
        if (isOpen) {
          for (const kid of kids) rows.push(...renderRow(kid, depth + 1));
        }
        return rows;
      };

      return h('div', null,
        h(StateView, { loading, error, empty: !loading && total === 0, onRetry: refresh, t },
          total > items.length
            ? h('div', { className: 'duc-small duc-muted', style: { marginBottom: 8 } },
                t('ledger.capped', { n: items.length }))
            : null,
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
              h('tbody', null, roots.flatMap((s) => renderRow(s, 0))),
            ),
          ),
        ),
      );
    }

    /** Manual reference-price import: fetch OpenRouter on demand, write only
     *  the rows the user confirmed. Nothing here runs without a click. */
    function SuggestModal({ t, fmt, onClose, onImported }) {
      const [state, setState] = useState({ loading: true, error: null, suggestions: [] });
      const [checked, setChecked] = useState({});
      const [fetched, setFetched] = useState(false);
      const [importing, setImporting] = useState(false);
      const [importError, setImportError] = useState(null);
      useEffect(() => {
        if (fetched) return;
        setFetched(true);
        let alive = true;
        apiPost('/prices/suggest')
          .then((payload) => {
            if (!alive) return;
            const suggestions = Array.isArray(payload?.suggestions) ? payload.suggestions : [];
            const map = {};
            for (const s of suggestions) map[`${s.provider ?? ''}/${s.model}`] = s.checked === true;
            setChecked(map);
            setState({ loading: false, error: null, suggestions });
          })
          .catch((error) => {
            if (!alive) return;
            setState({ loading: false, error: String(error?.message ?? error), suggestions: [] });
          });
        return () => { alive = false; };
      }, []);
      const keyOf = (s) => `${s.provider ?? ''}/${s.model}`;
      const selected = state.suggestions.filter(
        (s) => checked[keyOf(s)] === true && s.matchId !== null
          && (s.input !== null || s.output !== null || s.cacheRead !== null || s.cacheWrite !== null),
      );
      const priceCell = (s) => {
        const line = (label, value) => (value === null || value === undefined ? null : `${label} $${value}`);
        const lines = [
          line(t('table.input'), s.input),
          line(t('table.output'), s.output),
          line(t('table.cacheRead'), s.cacheRead),
          line(t('chart.cacheWrite'), s.cacheWrite),
        ].filter((part) => part !== null);
        return lines.length > 0
          ? h('span', { style: { display: 'inline-block', lineHeight: 1.5, textAlign: 'left' } },
              lines.map((l, i) => h('div', { key: i }, l)))
          : '–';
      };
      const matchTag = (s) => s.matchQuality === null
        ? t('suggest.match.none')
        : t(`suggest.match.${s.matchQuality}`);
      const doImport = () => {
        setImporting(true);
        setImportError(null);
        apiPost('/prices/import', {
          models: selected.map((s) => ({
            provider: s.provider ?? undefined,
            model: s.model,
            input: s.input ?? undefined,
            output: s.output ?? undefined,
            cacheRead: s.cacheRead ?? undefined,
            cacheWrite: s.cacheWrite ?? undefined,
          })),
        })
          .then(() => { setImporting(false); onImported(); })
          .catch((error) => {
            setImporting(false);
            setImportError(String(error?.message ?? error));
          });
      };
      return h('div', { className: 'duc-mask' },
        h('div', { className: 'duc-modal', role: 'dialog', 'aria-label': t('suggest.title') },
          h('h3', { className: 'duc-modal-title' }, t('suggest.title')),
          h('div', { className: 'duc-small duc-muted' }, t('suggest.source')),
          h('div', { className: 'duc-small duc-muted' }, t('suggest.disclaimer')),
          h('div', { className: 'duc-modal-body' },
            state.loading
              ? h('div', { className: 'duc-state' }, t('suggest.fetching'))
              : state.error !== null
                ? h('div', { className: 'duc-state' },
                    `${t('state.error')} — ${state.error}`,
                    h('br'),
                    h('button', { type: 'button', className: 'duc-iconbtn', onClick: onClose }, t('suggest.cancel')),
                  )
                : h('div', { className: 'duc-tablewrap' },
                    h('table', { className: 'duc-table' },
                      h('thead', null, h('tr', null,
                        h('th', null),
                        h('th', null, t('table.model')),
                        h('th', null, t('suggest.match')),
                        h('th', { className: 'num' }, t('costs.price')),
                      )),
                      h('tbody', null, state.suggestions.map((s) => h('tr', { key: keyOf(s) },
                        h('td', null,
                          h('input', {
                            type: 'checkbox',
                            'aria-label': s.model,
                            checked: checked[keyOf(s)] === true,
                            disabled: s.matchId === null,
                            onClick: () => setChecked((prev) => ({ ...prev, [keyOf(s)]: !(prev[keyOf(s)] === true) })),
                          })),
                        h('td', null, `${s.provider ?? '?'} / ${s.model}`),
                        h('td', { className: 'duc-small', title: s.matchId ?? undefined },
                          s.matchId === null ? t('suggest.match.none') : `${s.matchId} (${matchTag(s)})`),
                        h('td', { className: 'num duc-small' }, priceCell(s)),
                      ))),
                    ),
                  ),
            importError !== null
              ? h('div', { className: 'duc-error duc-small', style: { marginTop: 8 } }, `${t('state.error')} — ${importError}`)
              : null,
          ),
          h('div', { className: 'duc-modal-foot' },
            h('button', {
              type: 'button', className: 'duc-iconbtn', onClick: doImport,
              disabled: importing || selected.length === 0,
            }, importing ? t('suggest.importing') : `${t('suggest.import')} (${selected.length})`),
            h('button', {
              type: 'button', className: 'duc-iconbtn', onClick: onClose, disabled: importing,
            }, t('suggest.cancel')),
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
      const [suggestOpen, setSuggestOpen] = useState(false);
      const [notice, setNotice] = useState(null);
      const costs = data?.costs;
      const basisRows = data?.basis?.rows ?? [];
      const configured = costs !== undefined && costs.configured;
      // One table in both states: usage facts, then the effective price and
      // the estimated cost it implies (both "–" until prices are configured).
      const rows = configured
        ? costs.byModel
        : basisRows.map((row) => ({ ...row, currency: null, totalMicro: null, price: null }));
      // Each price category gets its own column — a joined "a · b · c" string
      // left the mapping between number and category unreadable.
      const priceCol = (price, field) => {
        if (price === null || price === undefined) return '–';
        const value = price[field];
        return value === undefined || value === null ? '–' : fmt.money(value * 1e6, 'USD');
      };
      return h(StateView, { loading, error, empty: !loading && rows.length === 0, onRetry: refresh, t },
        configured
          ? h('div', { className: 'duc-grid' },
              costs.byCurrency.map((c) => h(StatCard, {
                key: c.currency,
                title: `≈ ${c.currency}`,
                value: fmt.money(c.totalMicro, c.currency),
                sub: `${t('costs.estimate')} · ${fmt.int(c.requests)}`,
              })),
              h(StatCard, {
                title: t('costs.coverage'),
                value: costs.coverage.totalRequests > 0
                  ? `${Math.round((costs.coverage.pricedRequests / costs.coverage.totalRequests) * 100)}%`
                  : '–',
                sub: `${fmt.int(costs.coverage.pricedRequests)} / ${fmt.int(costs.coverage.totalRequests)}`,
              }),
            )
          : null,
        notice !== null
          ? h('div', { className: 'duc-small duc-muted', style: { marginBottom: 8 } }, notice)
          : null,
        h('div', { className: 'duc-section' },
          h('div', { className: 'duc-section-head' },
            h('h3', { className: 'duc-section-title' }, t('costs.basis')),
            h('span', { style: { display: 'inline-flex', gap: '8px', alignItems: 'baseline' } },
              h('span', { className: 'duc-small duc-muted' },
                configured ? `≈ ${t('costs.estimate')} · ${costs.byCurrency.map((c) => c.currency).join(' · ')}` : t('costs.pending')),
              h('button', {
                type: 'button', className: 'duc-iconbtn duc-small', onClick: () => setSuggestOpen(true),
              }, t('costs.suggest')),
            ),
          ),
          h('div', { className: 'duc-tablewrap' },
            h('table', { className: 'duc-table' },
              h('thead', null, h('tr', null,
                h('th', null, t('table.model')),
                h('th', { className: 'num' }, t('table.requests')),
                h('th', { className: 'num' }, t('table.total')),
                h('th', { className: 'num', title: t('table.input') }, `${t('table.input')} /1M`),
                h('th', { className: 'num', title: t('table.output') }, `${t('table.output')} /1M`),
                h('th', { className: 'num', title: t('table.cacheRead') }, `${t('table.cacheRead')} /1M`),
                h('th', { className: 'num' }, `≈ ${t('table.cost')}`),
              )),
              h('tbody', null, rows.map((row) => h('tr', {
                key: `${row.key}|${row.currency ?? ''}`,
                title: `${t('costs.price')} /1M${row.missingCount > 0 ? `\n⚠ ${row.missingCount}` : ''}`,
              },
                h('td', null, row.key),
                h('td', { className: 'num' }, fmt.int(row.requests)),
                h('td', { className: 'num' }, fmt.compact(row.totalTokens)),
                h('td', { className: 'num' }, priceCol(row.price, 'input')),
                h('td', { className: 'num' }, priceCol(row.price, 'output')),
                h('td', { className: 'num' }, priceCol(row.price, 'cacheRead')),
                h('td', { className: 'num' },
                  row.totalMicro === null || row.totalMicro === undefined
                    ? '–'
                    : `${fmt.money(row.totalMicro, row.currency)}${row.missingCount > 0 ? ' ⚠' : ''}`),
              ))),
            ),
          ),
        ),
        suggestOpen
          ? h(SuggestModal, {
              t, fmt,
              onClose: () => setSuggestOpen(false),
              onImported: () => {
                setSuggestOpen(false);
                setNotice(t('costs.imported'));
                window.setTimeout(refresh, 4000);
              },
            })
          : null,
      );
    }


    /** Single-series context chart: token line against the window's dashed line. */
    function ContextChart({ samples, windowTokens, t, fmt }) {
      const W = 720;
      const H = 190;
      const PAD_L = 52;
      const PAD_B = 18;
      const PAD_T = 14;
      const plotW = W - PAD_L - 8;
      const plotH = H - PAD_B - PAD_T;
      const peak = Math.max(...samples.map((s) => s.contextTokens), 1);
      const hasWindow = windowTokens !== null && windowTokens > 0;
      // Scale to the data; include the window in scale only when it is near the peak,
      // otherwise an idle session (peak 1% of window) squashes the line to the floor
      // and pushes the window line+label outside the viewBox.
      const windowScaled = hasWindow && windowTokens <= peak * 2 ? windowTokens : null;
      const maxTokens = Math.max(peak * 1.1, windowScaled ?? 0, 1);
      const step = samples.length > 1 ? plotW / (samples.length - 1) : 0;
      const x = (i) => PAD_L + i * step;
      const y = (v) => PAD_T + plotH - (v / maxTokens) * plotH;
      const points = samples.map((s, i) => `${x(i)},${y(s.contextTokens)}`).join(' ');
      const first = samples[0];
      const last = samples[samples.length - 1];
      // The dashed window line: at its true height when scaled, pinned to the top
      // edge (meaning "above the plotted range") when the window far exceeds the peak.
      const windowLineY = windowScaled !== null ? y(windowScaled) : PAD_T;
      const windowLabelY = Math.min(windowLineY + 13, PAD_T + plotH - 2);
      return h('svg', {
        className: 'duc-trend', viewBox: `0 0 ${W} ${H}`,
        role: 'img', 'aria-label': t('context.series'),
      },
        [0, 0.5, 1].map((ratio) => h('g', { key: ratio },
          h('line', { x1: PAD_L, x2: W - 8, y1: y(maxTokens * ratio), y2: y(maxTokens * ratio), strokeWidth: 1, style: { stroke: C.borderL1 } }),
          h('text', { x: PAD_L - 6, y: y(maxTokens * ratio) + 4, 'text-anchor': 'end', 'font-size': 10, style: { fill: C.labelSecondary } }, fmt.compact(maxTokens * ratio)),
        )),
        hasWindow
          ? h('g', null,
              h('line', { x1: PAD_L, x2: W - 8, y1: windowLineY, y2: windowLineY, strokeWidth: 1, 'stroke-dasharray': '6 4', style: { stroke: C.warn } }),
              h('text', { x: W - 10, y: windowLabelY, 'text-anchor': 'end', 'font-size': 10, style: { fill: C.warn } },
                `${t('context.window')} ${fmt.compact(windowTokens)}${windowScaled !== null ? '' : ' ↑'}`),
            )
          : null,
        h('polyline', { points, fill: 'none', strokeWidth: 1.6, style: { stroke: C.brand } }),
        h('circle', { cx: x(samples.length - 1), cy: y(last.contextTokens), r: 3, style: { fill: C.brand } },
          h('title', null, `${fmt.int(last.contextTokens)} tokens @ seq ${last.seq}`)),
        h('text', { x: PAD_L, y: H - 4, 'font-size': 10, style: { fill: C.labelSecondary } }, `seq ${first.seq}`),
        h('text', { x: W - 8, y: H - 4, 'text-anchor': 'end', 'font-size': 10, style: { fill: C.labelSecondary } }, `seq ${last.seq}`),
      );
    }

    function sessionName(s) {
      if (s.title !== null && s.title !== undefined) return s.title;
      if (s.cwd !== null && s.cwd !== undefined) {
        const base = s.cwd.split(/[\\/]/).pop();
        if (base !== undefined && base.length > 0) return base;
      }
      return `${s.sessionId.slice(0, 16)}…`;
    }

    function ContextTab({ t, fmt }) {
      // Phase 2: overview is a session tree with ABSOLUTE input numbers (no
      // "random latest session" cards); selecting a row pins the metric row
      // and the trend to that session. Core questions answered: how much went
      // in on the last request, how it changed, the historical max — the
      // window ratio stays secondary and is never a "remaining budget".
      const [selected, setSelected] = useState(null);
      const [expanded, setExpanded] = useState({});
      const overview = useLoad(
        () => [['ctx', selected === null ? api('/context') : Promise.resolve({})]],
        [selected === null],
      );
      const detail = useLoad(
        () => [['d', selected !== null ? api('/context', { sessionId: selected.sessionId }) : Promise.resolve({})]],
        [selected],
      );

      if (selected !== null) {
        const row = selected.row;
        const observations = (detail.data?.d?.observations ?? [])
          .filter((o) => o.kind === 'chat' && o.inputTokens !== null);
        const chartSamples = observations.map((o) => ({ seq: o.seq, contextTokens: o.inputTokens }));
        const windowTokens = observations.length > 0
          ? observations[observations.length - 1].contextWindow
          : null;
        const ratio = row.lastInput !== null && row.contextWindow !== null
          ? row.lastInput / row.contextWindow : null;
        return h(StateView, {
          loading: detail.loading, error: detail.error,
          empty: !detail.loading && observations.length === 0, onRetry: detail.refresh, t,
        },
          h('div', { className: 'duc-small duc-muted', style: { marginBottom: 8 } },
            `${t('context.selected')} · ${sessionName(row)}`),
          h('div', { className: 'duc-grid' },
            h(StatCard, {
              title: t('context.lastInput'),
              value: row.lastInput === null ? '–' : fmt.compact(row.lastInput),
              sub: row.lastInputAt === null ? undefined : fmt.dateTime(row.lastInputAt),
            }),
            h(StatCard, {
              title: t('context.delta'),
              value: row.delta === null ? '–' : `${row.delta >= 0 ? '+' : ''}${fmt.compact(row.delta)}`,
              sub: row.modelSwitched ? t('context.modelSwitched')
                : row.prevInput === null ? undefined : `${t('context.prev')} ${fmt.compact(row.prevInput)}`,
            }),
            h(StatCard, {
              title: t('context.maxInput'),
              value: row.maxInput === null ? '–' : fmt.compact(row.maxInput),
              sub: `${fmt.int(row.observedRequests)} / ${fmt.int(row.totalRequests)} ${t('chart.requestsUnit')}`,
            }),
            h(StatCard, {
              title: t('context.compactions'),
              value: fmt.int(row.compactions),
            }),
          ),
          h('div', { className: 'duc-small duc-muted', style: { marginBottom: 12 } },
            row.contextWindow === null
              ? t('context.noWindow')
              : `${t('context.window')} ${fmt.compact(row.contextWindow)}${ratio === null ? '' : ` · ${t('context.ofWindow')} ${(ratio * 100).toFixed(0)}%`} · ${t('context.windowNote')}`),
          h('div', { className: 'duc-section' },
            h('div', { className: 'duc-section-head' },
              h('h3', { className: 'duc-section-title' }, t('context.series')),
              h('button', {
                type: 'button', className: 'duc-iconbtn',
                onClick: () => setSelected(null),
              }, `← ${t('context.back')}`),
            ),
            chartSamples.length > 0
              ? h(ContextChart, { samples: chartSamples, windowTokens, t, fmt })
              : h('div', { className: 'duc-state' }, t('context.noUsage')),
          ),
        );
      }

      const sessions = overview.data?.ctx?.sessions ?? [];
      const known = new Set(sessions.map((s) => s.sessionId));
      const byParent = new Map();
      for (const s of sessions) {
        if (s.parentSessionId === null || s.parentSessionId === undefined) continue;
        if (!known.has(s.parentSessionId)) continue;
        const list = byParent.get(s.parentSessionId) ?? [];
        list.push(s);
        byParent.set(s.parentSessionId, list);
      }
      const roots = sessions.filter(
        (s) => s.parentSessionId === null || s.parentSessionId === undefined || !known.has(s.parentSessionId),
      );
      const deltaCell = (s) => {
        if (s.delta === null) return '–';
        return h('span', null,
          `${s.delta >= 0 ? '+' : ''}${fmt.compact(s.delta)}`,
          s.modelSwitched ? h('span', { className: 'duc-badge', style: { marginLeft: 6 } }, '⇄') : null,
        );
      };
      const renderRow = (s, depth) => {
        const kids = byParent.get(s.sessionId) ?? [];
        const isOpen = expanded[s.sessionId] === true;
        const ratio = s.lastInput !== null && s.contextWindow !== null
          ? `${Math.round((s.lastInput / s.contextWindow) * 100)}%` : null;
        const rows = [h('tr', {
          key: s.sessionId, className: 'clickable',
          title: `${s.sessionId}${s.delta !== null ? `\n${t('context.prev')}: ${s.prevInput} → ${t('context.lastInput')}: ${s.lastInput}` : ''}`,
          onClick: () => setSelected({ sessionId: s.sessionId, row: s }),
        },
          h('td', null,
            h('span', { style: { display: 'inline-flex', alignItems: 'center', gap: 6, paddingLeft: depth * 18 } },
              kids.length > 0
                ? h('button', {
                  type: 'button', className: 'duc-expander', 'aria-expanded': String(isOpen),
                  'aria-label': t('ledger.expand'),
                  onClick: (e) => {
                    e?.stopPropagation?.();
                    setExpanded((prev) => ({ ...prev, [s.sessionId]: !(prev[s.sessionId] === true) }));
                  },
                }, isOpen ? '▾' : '▸')
                : h('span', { style: { display: 'inline-block', width: 14 }, 'aria-hidden': 'true' }),
              h('span', null, sessionName(s)),
              s.origin === 'subagent' ? h('span', { className: 'duc-badge' }, t('origin.subagent')) : null,
              s.observedRequests === 0 && s.totalRequests > 0
                ? h('span', { className: 'duc-badge' }, t('context.noUsage')) : null,
            )),
          h('td', null, s.model ?? '–'),
          h('td', { className: 'num' }, s.lastInput === null ? '–' : fmt.compact(s.lastInput)),
          h('td', { className: 'num' }, deltaCell(s)),
          h('td', { className: 'num' }, ratio === null ? '–' : ratio),
          h('td', { className: 'num' }, s.contextWindow === null ? '–' : fmt.compact(s.contextWindow)),
          h('td', { className: 'num' }, s.compactions > 0 ? fmt.int(s.compactions) : '–'),
          h('td', { className: 'num' }, `${fmt.int(s.observedRequests)}/${fmt.int(s.totalRequests)}`),
          h('td', null, s.lastObsAt === null ? '–' : fmt.dateTime(s.lastObsAt)),
          h('td', { className: 'duc-muted', 'aria-hidden': 'true' }, '›'),
        )];
        if (isOpen) for (const kid of kids) rows.push(...renderRow(kid, depth + 1));
        return rows;
      };
      return h(StateView, {
        loading: overview.loading, error: overview.error,
        empty: !overview.loading && sessions.length === 0, onRetry: overview.refresh, t,
      },
        h('div', { className: 'duc-section' },
          h('div', { className: 'duc-tablewrap' },
            h('table', { className: 'duc-table' },
              h('thead', null, h('tr', null,
                h('th', null, t('table.session')),
                h('th', null, t('table.model')),
                h('th', { className: 'num' }, t('context.lastInput')),
                h('th', { className: 'num' }, t('context.delta')),
                h('th', { className: 'num' }, t('context.ofWindow')),
                h('th', { className: 'num' }, t('context.window')),
                h('th', { className: 'num' }, t('context.compactions')),
                h('th', { className: 'num' }, t('context.observed')),
                h('th', null, t('table.updated')),
                h('th', { 'aria-hidden': 'true' }),
              )),
              h('tbody', null, roots.flatMap((s) => renderRow(s, 0))),
            ),
          ),
        ),
      );
    }

    // -------------------------------------------------------------- dashboard

    const TABS = ['overview', 'requests', 'ledger', 'costs', 'context'];

    function DashboardView({ env }) {
      const [tab, setTab] = useState('overview');
      const [range, setRange] = useState(30);
      const [trendBy, setTrendBy] = useState('all');
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
        () => {
          const trendParams = trendBy === 'all' ? { days: range } : { days: range, by: trendBy };
          return [
            ['summary', api('/summary')],
            ['models', api('/breakdown', { by: 'model' })],
            ['trend', api('/trend', trendParams)],
            ['heat', api('/trend', { days: 182 })],
          ];
        },
        [range, trendBy],
      );
      // Interpret the trend response by ITS OWN `by` marker, never by the
      // current trendBy state: between a dimension click and the reload there
      // is one render where the old response (other shape) is still in state.
      const trendResp = overview.data?.trend ?? {};
      const trendIsAll = trendResp.by === undefined || trendResp.by === 'all';
      const overviewData = overview.data !== null && overview.data !== undefined ? {
        totals: overview.data.summary.totals,
        today: overview.data.summary.today,
        byModel: overview.data.models.rows,
        trendPoints: trendIsAll
          ? (trendResp.points ?? [])
          : (trendResp.series?.[0]?.points ?? []).map((p) => ({ ...p, requests: 0 })),
        trendSeries: trendIsAll ? null : trendResp.series,
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
              t, fmt, range, data: overviewData, trendBy, setTrendBy,
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
          tab === 'context' ? h(ContextTab, { t, fmt }) : null,
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

      // Adaptive palette: probe the host theme once at boot. Themed mode
      // paints var(--token, literal); literal mode paints the literals. The
      // mode is stamped on the style tag for remote diagnosis.
      const themed = themeTokensReachable();
      C = buildColors(themed);
      console.log(`dsh-usage-center: theme tokens ${themed ? 'reachable — following host theme' : 'unreachable — literal palette'}`);
      const style = document.createElement('style');
      style.dataset.plugin = 'dsh-usage-center';
      style.dataset.theme = themed ? 'on' : 'off';
      style.textContent = buildCss(C);
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
