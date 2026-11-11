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
    const { useState, useEffect, useMemo, useRef } = React;

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
      'filter.allSessions': '全部会话',
      'filter.searchSession': '搜索会话（名称 / ID / 路径）…',
      'filter.clear': '清除筛选',
      'page.prev': '上一页',
      'page.next': '下一页',
      'page.status': '{from}–{to} / {total}',
      'kind.chat': '对话',
      'kind.compaction': '压缩',
      'kind.attempt': '尝试/重试',
      'kind.other': '其他',
      'origin.subagent': '子代理',
      'origin.main': '主任务',
      'origin.unknown': '未知来源',
      'status.ok': '完成',
      'status.error': '失败',
      'costs.basis': '模型用量',
      'costs.pending': '未配置价格 — 点「参考价…」导入后可估算',
      'costs.notCovered': '价格表自 {date} 起生效：此前的请求不追溯计价（没有公开历史价，不猜）。若价格在更早时段确实相同，把配置里该表的 effectiveFrom 改早即可覆盖那段历史',
      'costs.retroNote': '含 {n} 条回溯估算：早于首张价格表的请求按首张表单价估算（近似口径，非精确历史价）',
      'costs.price': '单价 /1M',
      'costs.suggest': '参考价…',
      'costs.imported': '参考价已写入配置，重启 DSH 后生效',
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
      'context.series': '上下文走势',
      'context.latest': '最新会话',
      'context.selected': '所选会话',
      'context.lastInput': '最近输入',
      'context.delta': '较上次',
      'context.prev': '上次',
      'context.maxInput': '历史最大输入',
      'context.modelSwitched': '期间切换过模型',
      'context.ofWindow': '占窗口',
      'context.noWindow': '窗口未知（无窗口信息）',
      'context.windowNote': '窗口剩余 ≠ 可安全使用的输入预算',
      'context.observed': '有用量/全部请求',
      'context.noUsage': '暂无用量数据',
      'context.range50': '最近 50',
      'context.range200': '最近 200',
      'context.rangeAll': '全部',
      'context.attempts': '尝试/重试',
      'context.clickDetail': '点击查看请求详情',
      'context.kindChat': '请求',
      'context.kindAttempt': '尝试',
      'context.kindCompaction': '压缩',
      'context.markerNoInput': '压缩点（无输入数据）',
      'context.missing': '部分用量缺失',
      'context.duration': '耗时',
      'context.latency': '首字延迟',
      'context.errorCode': '错误',
      'context.windowUnknown': '窗口未知',
      'context.requestDetail': '请求详情',
      'context.close': '关闭',
      'context.inputDetail': '输入明细',
      'context.estCost': '估算费用',
      'context.requestId': '请求 ID',
      'context.compactionDiag': '压缩诊断',
      'context.beforeLast': '压缩前最后输入',
      'context.afterFirst': '压缩后首次输入',
      'context.obsDiff': '压缩前后观测差额',
      'context.obsRatio': '比例',
      'context.obsDiffNote': '差额与比例来自压缩前后两次输入的对比，不代表实际节省量；费用为估算，非账单',
      'context.noCompactions': '无压缩记录',
      'context.emptyHint': '插件记录到用量后此处显示会话',
      'context.chartHint': '悬停查看数值 · 点击查看请求详情',
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
      'filter.allSessions': 'All sessions',
      'filter.searchSession': 'Search sessions (name / id / path)…',
      'filter.clear': 'Clear filters',
      'page.prev': 'Previous',
      'page.next': 'Next',
      'page.status': '{from}–{to} / {total}',
      'kind.chat': 'Chat',
      'kind.compaction': 'Compaction',
      'kind.attempt': 'Attempt/retry',
      'kind.other': 'Other',
      'origin.subagent': 'Subagent',
      'origin.main': 'Main',
      'origin.unknown': 'Unknown',
      'status.ok': 'OK',
      'status.error': 'Error',
      'costs.basis': 'Model usage',
      'costs.pending': 'No prices configured — click "Reference prices…" to import',
      'costs.notCovered': 'The price list applies from {date}: earlier requests are not priced retroactively (no public price history, so nothing is guessed). If the same price genuinely applied earlier, set an earlier effectiveFrom in the config',
      'costs.retroNote': 'Includes {n} retroactively priced requests: calls before the first price list are estimated at that list’s rates (an approximation, not exact historical prices)',
      'costs.price': 'Price /1M',
      'costs.suggest': 'Reference prices…',
      'costs.imported': 'Reference prices written to config; applies after DSH restarts',
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
      'context.series': 'Context series',
      'context.latest': 'Latest session',
      'context.selected': 'Selected session',
      'context.lastInput': 'Last input',
      'context.delta': 'vs previous',
      'context.prev': 'Previous',
      'context.maxInput': 'Max input',
      'context.modelSwitched': 'model changed in between',
      'context.ofWindow': 'of window',
      'context.noWindow': 'Window unknown (no window info)',
      'context.windowNote': 'window headroom is not a safe input budget',
      'context.observed': 'with usage/all requests',
      'context.noUsage': 'no usage data yet',
      'context.range50': 'Last 50',
      'context.range200': 'Last 200',
      'context.rangeAll': 'All',
      'context.attempts': 'Attempts/retries',
      'context.clickDetail': 'Click for request detail',
      'context.kindChat': 'Request',
      'context.kindAttempt': 'Attempt',
      'context.kindCompaction': 'Compaction',
      'context.markerNoInput': 'compaction point (no input data)',
      'context.missing': 'partial usage missing',
      'context.duration': 'Duration',
      'context.latency': 'First-token latency',
      'context.errorCode': 'Error',
      'context.windowUnknown': 'Window unknown',
      'context.requestDetail': 'Request detail',
      'context.close': 'Close',
      'context.inputDetail': 'Input detail',
      'context.estCost': 'Est. cost',
      'context.requestId': 'Request ID',
      'context.compactionDiag': 'Compaction diagnostics',
      'context.beforeLast': 'Last input before',
      'context.afterFirst': 'First input after',
      'context.obsDiff': 'Observed before/after drop',
      'context.obsRatio': 'Ratio',
      'context.obsDiffNote': 'The drop and ratio compare the inputs right before and after a compaction; they are not actual savings, and cost figures are estimates, not bills.',
      'context.noCompactions': 'No compaction records',
      'context.emptyHint': 'sessions appear here once the plugin records usage',
      'context.chartHint': 'Hover for values · Click for request detail',
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
      // A background poll (15s tick or the refresh button) must NOT swap the
      // panel for a loading state: replacing the content collapses the scroll
      // container and throws a scrolled-down user back to the top. Only the
      // first load — or changed inputs, where old data would be WRONG data —
      // shows the loading view; afterwards data stays mounted until the new
      // response replaces it.
      const depsKey = JSON.stringify(deps);
      const lastKey = useRef(null);
      const isBackground = lastKey.current === depsKey && state.data !== null;
      lastKey.current = depsKey;
      useEffect(() => {
        let alive = true;
        if (!isBackground) setState({ loading: true, data: null, error: null });
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
            // A failed background poll keeps the last good content; only a
            // failed initial load surfaces the error view.
            setState((prev) => (prev.data !== null
              ? prev
              : { loading: false, data: null, error: String(error?.message ?? error) }));
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
.duc-iconbtn[aria-pressed=true]{border-color:${colors.brand};color:inherit}
.duc-backbtn{display:inline-flex;align-items:center;gap:6px;border:1px solid ${colors.borderL2};background:${colors.bgLayer1};color:inherit;border-radius:8px;padding:7px 14px;cursor:pointer;font:inherit;font-weight:500}
.duc-backbtn:hover{background:${colors.hoverBg}}
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
.duc-chartwrap{position:relative}
.duc-charttip{position:absolute;z-index:5;pointer-events:none;background:${colors.modalBg};color:${colors.modalText};border:1px solid ${colors.borderL2};border-radius:8px;padding:7px 10px;font-size:12px;line-height:1.55;max-width:250px;box-shadow:0 6px 18px rgba(0,0,0,.2);transform:translate(-50%,-100%)}
@media (prefers-color-scheme: dark){.duc-charttip{background:${colors.modalBgDark};color:${colors.modalTextDark}}}
.duc-kv{display:grid;grid-template-columns:auto 1fr;gap:5px 18px;font-size:12.5px;margin:8px 0 0}
.duc-kv dt{color:${colors.labelSecondary};white-space:nowrap}
.duc-kv dd{margin:0;min-width:0;word-break:break-all}
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
.duc-picker{position:relative;display:inline-block}
.duc-pickerbtn{display:inline-flex;align-items:center;gap:8px;justify-content:space-between;min-width:190px;max-width:320px;border:1px solid ${colors.borderL1};background:${colors.bgLayer1};color:inherit;border-radius:6px;padding:5px 9px;cursor:pointer;font:inherit;text-align:left}
.duc-pickerbtn:hover{background:${colors.hoverBg}}
.duc-pickerbtn>span:first-child{overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.duc-pickerpanel{position:absolute;top:calc(100% + 6px);left:0;z-index:30;display:flex;flex-direction:column;min-width:360px;max-height:360px;background:${colors.modalBg};color:${colors.modalText};border:1px solid ${colors.borderL2};border-radius:8px;box-shadow:0 10px 32px rgba(0,0,0,.22);overflow:hidden}
@media (prefers-color-scheme: dark){.duc-pickerpanel{background:${colors.modalBgDark};color:${colors.modalTextDark}}}
.duc-pickersearch{padding:8px 8px 4px}
.duc-pickersearch .duc-input{width:100%;min-width:0}
.duc-pickerlist{overflow:auto;padding:0 4px 6px}
.duc-pickerrow{display:flex;align-items:center;gap:8px;width:100%;border:none;background:transparent;color:inherit;border-radius:6px;padding:6px 8px;cursor:pointer;font:inherit;text-align:left}
.duc-pickerrow:hover{background:${colors.hoverBg}}
.duc-pickerrow[aria-pressed=true]{font-weight:600}
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

    function StateView({ loading, error, empty, emptyText, onRetry, t, children }) {
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
      if (empty) return h('div', { className: 'duc-state' }, emptyText ?? t('state.empty'));
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

    /**
     * Searchable session picker. Loads the light `/sessions` list ONLY when
     * opened — the requests page's poll never pays for the context overview
     * (P1) — groups subagents under their parent with badges and indents,
     * and filters by title / id / path as you type; a match keeps its
     * parent and children visible (P2).
     */
    function SessionPicker({ t, fmt, value, label, onPick }) {
      const [open, setOpen] = useState(false);
      const [search, setSearch] = useState('');
      const [state, setState] = useState({ loading: false, error: null, items: null });
      useEffect(() => {
        if (!open) return;
        let alive = true;
        setState((prev) => ({ ...prev, loading: prev.items === null, error: null }));
        api('/sessions', { limit: 200, offset: 0 })
          .then((payload) => {
            if (!alive) return;
            setState({ loading: false, error: null, items: payload?.items ?? [] });
          })
          .catch((error) => {
            if (!alive) return;
            setState((prev) => ({
              loading: false, error: String(error?.message ?? error), items: prev.items,
            }));
          });
        return () => { alive = false; };
      }, [open]);
      const items = state.items ?? [];
      const q = search.trim().toLowerCase();
      const matches = (s) => q.length === 0
        || sessionName(s).toLowerCase().includes(q)
        || s.sessionId.toLowerCase().includes(q)
        || (s.cwd ?? '').toLowerCase().includes(q);
      const byParent = new Map();
      for (const s of items) {
        if (s.parentSessionId === null || s.parentSessionId === undefined) continue;
        const list = byParent.get(s.parentSessionId) ?? [];
        list.push(s);
        byParent.set(s.parentSessionId, list);
      }
      const visible = new Set();
      for (const s of items) {
        if (!matches(s)) continue;
        visible.add(s.sessionId);
        if (s.parentSessionId !== null && s.parentSessionId !== undefined) visible.add(s.parentSessionId);
        for (const kid of byParent.get(s.sessionId) ?? []) visible.add(kid.sessionId);
      }
      const known = new Set(items.map((s) => s.sessionId));
      const roots = items
        .filter((s) => visible.has(s.sessionId)
          && (s.parentSessionId === null || s.parentSessionId === undefined || !known.has(s.parentSessionId)))
        .sort((a, b) => (b.lastTimestamp ?? 0) - (a.lastTimestamp ?? 0));
      const row = (s, depth) => h('button', {
        type: 'button', className: 'duc-pickerrow', 'aria-pressed': String(s.sessionId === value),
        onClick: () => { onPick(s.sessionId, sessionName(s)); setOpen(false); },
      },
        h('span', { style: { paddingLeft: depth * 16, display: 'inline-flex', alignItems: 'center', gap: 6, minWidth: 0 } },
          h('span', { style: { overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' } },
            sessionName(s)),
          s.origin === 'subagent' ? h('span', { className: 'duc-badge' }, t('origin.subagent')) : null,
        ),
        h('span', { className: 'duc-small duc-muted', style: { marginLeft: 'auto', flex: 'none' } },
          `${fmt.int(s.requests)} ${t('chart.requestsUnit')}`),
      );
      return h('div', { className: 'duc-picker' },
        h('button', {
          type: 'button', className: 'duc-pickerbtn', title: value || undefined,
          onClick: () => setOpen((v) => !v),
        },
          h('span', null, value ? (label ?? `${value.slice(0, 16)}…`) : t('filter.allSessions')),
          h('span', { className: 'duc-muted', 'aria-hidden': 'true' }, open ? '▴' : '▾'),
        ),
        open
          ? h('div', { className: 'duc-pickerpanel' },
              h('div', { className: 'duc-pickersearch' },
                h('input', {
                  className: 'duc-input', placeholder: t('filter.searchSession'),
                  value: search,
                  onChange: (e) => setSearch(e.target.value),
                })),
              h('div', { className: 'duc-pickerlist' },
                h('button', {
                  type: 'button', className: 'duc-pickerrow', 'aria-pressed': String(value === ''),
                  onClick: () => { onPick('', null); setOpen(false); },
                }, h('span', null, t('filter.allSessions'))),
                state.items === null && state.loading
                  ? h('div', { className: 'duc-state duc-small' }, t('state.loading'))
                  : state.items === null && state.error !== null
                    ? h('div', { className: 'duc-state duc-small duc-error' }, `${t('state.error')} — ${state.error}`)
                    : roots.flatMap((s) => {
                        const kids = (byParent.get(s.sessionId) ?? []).filter((k) => visible.has(k.sessionId));
                        return [row(s, 0), ...kids.map((k) => row(k, 1))];
                      }),
                state.items !== null && roots.length === 0 && q.length > 0
                  ? h('div', { className: 'duc-state duc-small' }, t('state.empty'))
                  : null,
              ),
            )
          : null,
      );
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
      // The picker is the context panel's entry point; picking a session
      // keeps its display label so the panel header survives tab switches.
      const setSession = (sessionId, sessionLabel) => setFilters((prev) => ({
        ...prev,
        sessionId: sessionId === '' ? undefined : sessionId,
        sessionLabel: sessionLabel ?? undefined,
        page: 0,
      }));
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
          h(SessionPicker, {
            t, fmt,
            value: filters.sessionId ?? '',
            label: filters.sessionLabel,
            onPick: setSession,
          }),
          (filters.provider || filters.model || filters.kind || filters.sessionId)
            ? h('button', {
              type: 'button', className: 'duc-iconbtn',
              onClick: () => setFilters({ page: 0 }),
            }, t('filter.clear')) : null,
        ),
        filters.sessionId !== undefined && filters.sessionId !== ''
          ? h(ContextSessionPanel, {
              session: { sessionId: filters.sessionId, label: filters.sessionLabel },
              t, fmt,
            })
          : null,
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
      // Prices configured but nothing covered yet — the imported reference
      // list starts TODAY and earlier requests are deliberately not priced
      // retroactively. Fall back to usage facts so the page explains the
      // situation instead of reading as "no data".
      const noPriced = configured === true
        && (costs.byModel === undefined || costs.byModel.length === 0);
      const rows = configured === true && !noPriced
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
        noPriced
          ? h('div', { className: 'duc-small duc-muted', style: { marginBottom: 8 } },
              interpolate(t('costs.notCovered'), {
                date: typeof costs.effectiveFrom === 'number' ? fmt.date(costs.effectiveFrom) : '–',
              }))
          : null,
        configured === true && costs.coverage.retroPriced > 0
          ? h('div', { className: 'duc-small duc-muted', style: { marginBottom: 8 } },
              interpolate(t('costs.retroNote'), { n: fmt.int(costs.coverage.retroPriced) }))
          : null,
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
                configured
                  ? (costs.byCurrency.length > 0
                      ? `≈ ${t('costs.estimate')} · ${costs.byCurrency.map((c) => c.currency).join(' · ')}`
                      : `≈ ${t('costs.estimate')}`)
                  : t('costs.pending')),
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


    /**
     * Per-observation diagnostic chart. One hit strip per visible sample
     * (hover tooltip + click drill-down, no mouse-coordinate math), the chat
     * input line, an optional attempts layer (hollow dots), model-switch
     * markers (⇄), compaction marks (vertical dashed line) and the window
     * drawn as SEGMENTS — one dashed line per declaration run, never one
     * max-throughout line. Paints go through style props only; never
     * color-mix() (rejected on SVG paints by this engine).
     */
    function ContextChart({ samples, t, fmt, pinnedId, onPin }) {
      const [hover, setHover] = useState(null);
      const W = 720;
      const H = 210;
      const PAD_L = 52;
      const PAD_B = 18;
      const PAD_T = 16;
      const plotW = W - PAD_L - 8;
      const plotH = H - PAD_B - PAD_T;
      let peak = 1;
      for (const s of samples) {
        if (s.kind !== 'compaction' && s.inputTokens !== null && s.inputTokens > peak) peak = s.inputTokens;
      }
      const maxWindow = samples.reduce((m, s) => Math.max(m, s.contextWindow ?? 0), 0);
      const hasWindow = maxWindow > 0;
      // Include the window in the scale only when it is near the data, so an
      // idle session is not squashed to the floor.
      const windowScaled = hasWindow && maxWindow <= peak * 2 ? maxWindow : null;
      const maxTokens = Math.max(peak * 1.1, windowScaled ?? 0, 1);
      const step = samples.length > 1 ? plotW / (samples.length - 1) : 0;
      const x = (i) => PAD_L + i * step;
      const y = (v) => PAD_T + plotH - (v / maxTokens) * plotH;
      // Nearest sample from a mouse position — the ONLY hit mechanism. Per-
      // point strips overlap once spacing drops below their width and the
      // topmost (later) strip wins, silently selecting the wrong request.
      const nearestIndex = (clientX, target) => {
        const rect = target.getBoundingClientRect();
        const xSvg = ((clientX - rect.left) / rect.width) * W;
        const i = Math.round((xSvg - PAD_L) / (step || 1));
        return Math.max(0, Math.min(samples.length - 1, i));
      };
      const kindLabel = (s) => s.kind === 'compaction' ? t('context.kindCompaction')
        : s.kind === 'attempt' ? t('context.kindAttempt') : t('context.kindChat');
      // Chat input polyline (attempts stay as isolated dots).
      const linePts = [];
      let lastChat = null;
      samples.forEach((s, i) => {
        if (s.kind === 'chat' && s.inputTokens !== null) {
          linePts.push(`${x(i)},${y(s.inputTokens)}`);
          lastChat = { i, s };
        }
      });
      // Window segments: maximal runs of the same declared window.
      const segs = [];
      let cur = null;
      samples.forEach((s, i) => {
        const w = s.contextWindow;
        if (w === null || w === undefined) { cur = null; return; }
        if (cur === null || cur.w !== w) { cur = { w, from: i, to: i }; segs.push(cur); }
        else cur.to = i;
      });
      const hoverSample = hover === null ? null : samples[hover] ?? null;
      const pinnedIndex = pinnedId === null ? -1
        : samples.findIndex((s) => s.requestId === pinnedId);
      const hoverY = hoverSample !== null && hoverSample.kind !== 'compaction'
        && hoverSample.inputTokens !== null ? y(hoverSample.inputTokens) : PAD_T + plotH / 2;
      const tipLeft = `${Math.min(Math.max(((hover === null ? PAD_L : x(hover)) / W) * 100, 12), 84)}%`;
      const tipTop = `${Math.max((hoverY - 8) / H, 0.06) * 100}%`;
      return h('div', { className: 'duc-chartwrap' },
        h('svg', {
          className: 'duc-trend', viewBox: `0 0 ${W} ${H}`,
          role: 'img', 'aria-label': t('context.series'),
        },
          [0, 0.5, 1].map((ratio) => h('g', { key: ratio },
            h('line', { x1: PAD_L, x2: W - 8, y1: y(maxTokens * ratio), y2: y(maxTokens * ratio), strokeWidth: 1, style: { stroke: C.borderL1 } }),
            h('text', { x: PAD_L - 6, y: y(maxTokens * ratio) + 4, 'text-anchor': 'end', 'font-size': 10, style: { fill: C.labelSecondary } }, fmt.compact(maxTokens * ratio)),
          )),
          segs.map((seg, k) => {
            const segY = seg.w <= maxTokens ? y(seg.w) : PAD_T;
            // Segment edges come from the segment's OWN samples. A segment
            // reaches the chart edge only when it really contains the first
            // or last sample — never stretching into unknown-window regions.
            const x1 = seg.from === 0 ? PAD_L : Math.max(PAD_L, x(seg.from) - step / 2);
            const x2 = seg.to === samples.length - 1 ? W - 8 : Math.min(W - 8, x(seg.to) + step / 2);
            const width = x2 - x1;
            return h('g', { key: `seg${k}` },
              h('line', { x1, x2, y1: segY, y2: segY, strokeWidth: 1, 'stroke-dasharray': '6 4', style: { stroke: C.warn } },
                h('title', null, `${t('context.window')} ${fmt.compact(seg.w)}${seg.w > maxTokens ? ' ↑' : ''}`)),
              width > 64
                ? h('text', { x: x1 + 4, y: Math.min(segY + 12, PAD_T + plotH - 2), 'font-size': 10, style: { fill: C.warn } },
                    `${fmt.compact(seg.w)}${seg.w > maxTokens ? ' ↑' : ''}`)
                : null,
            );
          }),
          samples.map((s, i) => (s.kind === 'compaction'
            ? h('g', { key: `cmp${i}` },
                h('line', { x1: x(i), x2: x(i), y1: PAD_T, y2: PAD_T + plotH, strokeWidth: 1, 'stroke-dasharray': '2 3', style: { stroke: C.error, opacity: 0.75 } },
                  h('title', null, `${t('context.kindCompaction')} · ${fmt.dateTime(s.timestamp)}${s.durationMs !== null && s.durationMs !== undefined ? ` · ${t('context.duration')} ${fmt.ms(s.durationMs)}` : ''}`)),
                h('circle', { cx: x(i), cy: PAD_T - 6, r: 2.5, style: { fill: C.error } }),
              )
            : null)),
          linePts.length > 1 ? h('polyline', { points: linePts.join(' '), fill: 'none', strokeWidth: 1.6, style: { stroke: C.brand } }) : null,
          lastChat !== null
            ? h('circle', { cx: x(lastChat.i), cy: y(lastChat.s.inputTokens), r: 3, style: { fill: C.brand } },
                h('title', null, `${fmt.int(lastChat.s.inputTokens)} tokens @ seq ${lastChat.s.seq}`))
            : null,
          samples.map((s, i) => (s.kind === 'attempt' && s.inputTokens !== null
            ? h('circle', { key: `att${i}`, cx: x(i), cy: y(s.inputTokens), r: 2.5, fill: 'none', strokeWidth: 1.2, style: { stroke: C.labelSecondary } }) : null)),
          samples.map((s, i) => (s.switched === true
            ? h('text', { key: `sw${i}`, x: x(i), y: Math.max(y(s.inputTokens) - 8, PAD_T + 8), 'font-size': 11, 'text-anchor': 'middle', style: { fill: C.warn } }, '⇄',
                h('title', null, `${s.prevModel ?? '?'} → ${s.model ?? '?'}`)) : null)),
          hoverSample !== null
            ? h('g', { key: 'hover', pointerEvents: 'none' },
                h('line', { x1: x(hover), x2: x(hover), y1: PAD_T, y2: PAD_T + plotH, strokeWidth: 1, style: { stroke: C.brand, opacity: 0.45 } }),
                hoverSample.kind !== 'compaction' && hoverSample.inputTokens !== null
                  ? h('circle', { cx: x(hover), cy: y(hoverSample.inputTokens), r: 3.5, style: { fill: C.brand } }) : null,
              ) : null,
          pinnedIndex >= 0
            ? h('circle', { key: 'pin', cx: x(pinnedIndex), cy: samples[pinnedIndex].kind !== 'compaction' && samples[pinnedIndex].inputTokens !== null ? y(samples[pinnedIndex].inputTokens) : PAD_T + plotH / 2, r: 5, fill: 'none', strokeWidth: 2, style: { stroke: C.brand }, pointerEvents: 'none' })
            : null,
          h('text', { x: PAD_L, y: H - 4, 'font-size': 10, style: { fill: C.labelSecondary } }, `seq ${samples[0].seq}`),
          h('text', { x: W - 8, y: H - 4, 'text-anchor': 'end', 'font-size': 10, style: { fill: C.labelSecondary } }, `seq ${samples[samples.length - 1].seq}`),
          // Single transparent event layer for hover + click across the plot.
          h('rect', {
            x: PAD_L, y: PAD_T, width: plotW, height: plotH,
            style: { fill: 'transparent', cursor: 'pointer' },
            onMouseMove: (e) => setHover(nearestIndex(e.clientX, e.currentTarget)),
            onMouseLeave: () => setHover(null),
            onClick: (e) => onPin(samples[nearestIndex(e.clientX, e.currentTarget)].requestId),
          }),
        ),
        hoverSample !== null
          ? h('div', { className: 'duc-charttip', style: { left: tipLeft, top: tipTop } },
              h('div', null, fmt.dateTime(hoverSample.timestamp)),
              h('div', null,
                `seq ${hoverSample.seq} · ${kindLabel(hoverSample)} · ${hoverSample.model ?? '?'}`),
              h('div', null,
                hoverSample.kind === 'compaction'
                  ? t('context.markerNoInput')
                  : `${t('context.lastInput')} ${fmt.compact(hoverSample.inputTokens)}`),
              hoverSample.kind === 'chat'
                ? h('div', null,
                    `${t('context.delta')} ${hoverSample.delta === null ? '–'
                      : `${hoverSample.delta >= 0 ? '+' : ''}${fmt.compact(hoverSample.delta)}`}`,
                    hoverSample.missingMask > 0 ? h('span', { className: 'duc-badge', style: { marginLeft: 6 } }, t('context.missing')) : null)
                : null,
              h('div', null,
                hoverSample.contextWindow === null ? t('context.windowUnknown')
                  : `${t('context.window')} ${fmt.compact(hoverSample.contextWindow)}`),
              h('div', { className: 'duc-muted' }, t('context.clickDetail')),
            )
          : null,
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

    /** Context diagnostics for one session, embedded in the requests page
     *  while that session is selected in the filter row — the session
     *  dropdown IS the switcher (no separate context page anymore). Owns
     *  the range / attempts / pinned state. */
    function ContextSessionPanel({ session, t, fmt }) {
      const [range, setRange] = useState(200);
      const [showAttempts, setShowAttempts] = useState(false);
      const [pinnedId, setPinnedId] = useState(null);
      const detail = useLoad(
        () => [['d', api('/context', { sessionId: session.sessionId })]],
        [session.sessionId],
      );
      const observations = detail.data?.d?.observations ?? [];
      // Summary cards derive from the observation series itself — ONE fetch,
      // no context-overview call; only the record total comes from the
      // server (records without observable usage are not observations).
      const chatObs = observations.filter((o) => o.kind === 'chat' && o.inputTokens !== null);
      const last = chatObs.length > 0 ? chatObs[chatObs.length - 1] : null;
      const prev = chatObs.length > 1 ? chatObs[chatObs.length - 2] : null;
      const row = {
        sessionId: session.sessionId,
        title: session.label ?? null,
        cwd: null,
        lastInput: last === null ? null : last.inputTokens,
        lastInputAt: last === null ? null : last.timestamp,
        prevInput: prev === null ? null : prev.inputTokens,
        delta: last !== null && prev !== null ? last.inputTokens - prev.inputTokens : null,
        modelSwitched: last !== null && prev !== null
          && last.model !== null && prev.model !== null && last.model !== prev.model,
        maxInput: chatObs.reduce((m, o) => Math.max(m, o.inputTokens), 0) || null,
        observedRequests: chatObs.length,
        totalRequests: detail.data?.d?.totalRequests ?? chatObs.length,
        compactions: observations.filter((o) => o.kind === 'compaction').length,
        contextWindow: observations.length > 0 ? observations[observations.length - 1].contextWindow : null,
      };
        // Delta / model-switch over the FULL chat series, computed before any
        // range slicing so the first visible point still knows its previous.
        const chatMeta = new Map();
        let prevChat = null;
        for (const o of observations) {
          if (o.kind !== 'chat' || o.inputTokens === null) continue;
          chatMeta.set(o.requestId, {
            delta: prevChat === null ? null : o.inputTokens - prevChat.inputTokens,
            switched: prevChat !== null && prevChat.model !== null && o.model !== null && o.model !== prevChat.model,
            prevModel: prevChat === null ? null : prevChat.model,
          });
          prevChat = o;
        }
        const plainMeta = { delta: null, switched: false, prevModel: null };
        const layered = showAttempts ? observations : observations.filter((o) => o.kind !== 'attempt');
        const visible = range === 0 ? layered : layered.slice(-range);
        const samples = visible.map((o) => ({ ...o, ...(chatMeta.get(o.requestId) ?? plainMeta) }));
        // Compaction diagnostics over the full series: pair each marker with
        // the last input observed before it and the first after it. The drop
        // is an observed difference, never a "savings" claim.
        const diag = observations.filter((o) => o.kind === 'compaction')
          .map((m) => ({ m, before: null, after: null }));
        {
          let k = 0;
          let last = null;
          for (const o of observations) {
            if (o.kind === 'compaction') { diag[k].before = last; k += 1; }
            else if (o.kind === 'chat' && o.inputTokens !== null) last = o.inputTokens;
          }
        }
        {
          let k = diag.length - 1;
          let next = null;
          for (let i = observations.length - 1; i >= 0; i -= 1) {
            const o = observations[i];
            if (o.kind === 'compaction') { diag[k].after = next; k -= 1; }
            else if (o.kind === 'chat' && o.inputTokens !== null) next = o.inputTokens;
          }
        }
        const pinned = pinnedId === null
          ? null : observations.find((o) => o.requestId === pinnedId) ?? null;
        const pinnedMeta = pinned === null ? plainMeta : chatMeta.get(pinned.requestId) ?? plainMeta;
        const ratio = row.lastInput !== null && row.contextWindow !== null
          ? row.lastInput / row.contextWindow : null;
        const kindLabel = (o) => o.kind === 'compaction' ? t('context.kindCompaction')
          : o.kind === 'attempt' ? t('context.kindAttempt') : t('context.kindChat');
        const num = (v) => (v === null || v === undefined ? '–' : fmt.compact(v));
        const money = (o) => (o.costMicro === null || o.costMicro === undefined
          ? '–' : fmt.money(o.costMicro, o.costCurrency ?? 'USD'));
        return h(StateView, {
          loading: detail.loading, error: detail.error,
          empty: !detail.loading && observations.length === 0,
          emptyText: t('context.noUsage'),
          onRetry: detail.refresh, t,
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
            ),
            h('div', { className: 'duc-filters' },
              h('div', { className: 'duc-range', role: 'group' },
                [50, 200, 0].map((r) => h('button', {
                  key: r, type: 'button', 'aria-pressed': String(range === r),
                  onClick: () => setRange(r),
                }, r === 0 ? t('context.rangeAll') : t(`context.range${r}`)))),
              h('button', {
                type: 'button', className: 'duc-iconbtn', 'aria-pressed': String(showAttempts),
                onClick: () => setShowAttempts((v) => !v),
              }, t('context.attempts')),
              h('span', { className: 'duc-small duc-muted' }, `${fmt.int(samples.length)} / ${fmt.int(observations.length)}`),
            ),
            samples.length > 0
              ? h(ContextChart, { samples, t, fmt, pinnedId, onPin: setPinnedId })
              : h('div', { className: 'duc-state' }, t('context.noUsage')),
            samples.length > 0
              ? h('div', { className: 'duc-small duc-muted', style: { marginTop: 6 } }, t('context.chartHint'))
              : null,
            pinned !== null
              ? h('div', { className: 'duc-card', style: { marginTop: 12 } },
                  h('div', { className: 'duc-section-head' },
                    h('span', { className: 'duc-section-title' },
                      `${t('context.requestDetail')} · seq ${pinned.seq}`),
                    h('button', {
                      type: 'button', className: 'duc-iconbtn',
                      onClick: () => setPinnedId(null),
                    }, t('context.close')),
                  ),
                  h('dl', { className: 'duc-kv' },
                    h('dt', null, t('table.time')), h('dd', null, fmt.dateTime(pinned.timestamp)),
                    h('dt', null, t('table.model')),
                      h('dd', null, `${pinned.provider ?? '?'} / ${pinned.model ?? '?'}`),
                    h('dt', null, t('table.kind')),
                      h('dd', null, kindLabel(pinned),
                        pinned.errorCode !== null && pinned.errorCode !== undefined
                          ? h('span', { className: 'duc-badge err', style: { marginLeft: 6 } },
                              `${t('context.errorCode')} ${pinned.errorCode}`) : null),
                    h('dt', null, t('context.inputDetail')),
                      h('dd', null,
                        pinned.kind === 'compaction' ? t('context.markerNoInput')
                          : `${t('table.input')} ${num(pinned.inputRaw)} · ${t('table.cacheRead')} ${num(pinned.cacheRead)} · ${t('table.cacheWrite')} ${num(pinned.cacheWrite)}`,
                        pinned.missingMask > 0
                          ? h('span', { className: 'duc-badge', style: { marginLeft: 6 } }, t('context.missing')) : null),
                    h('dt', null, t('table.output')), h('dd', null, num(pinned.outputTokens)),
                    h('dt', null, t('context.duration')), h('dd', null, fmt.ms(pinned.durationMs)),
                    h('dt', null, t('context.latency')), h('dd', null, fmt.ms(pinned.firstTokenLatencyMs)),
                    h('dt', null, t('context.delta')),
                      h('dd', null, pinned.kind !== 'chat' || pinnedMeta.delta === null ? '–'
                        : `${pinnedMeta.delta >= 0 ? '+' : ''}${fmt.compact(pinnedMeta.delta)}`),
                    h('dt', null, t('context.window')),
                      h('dd', null, pinned.contextWindow === null ? t('context.windowUnknown') : fmt.compact(pinned.contextWindow)),
                    h('dt', null, t('context.estCost')), h('dd', null, money(pinned)),
                    h('dt', null, t('context.requestId')),
                      h('dd', { title: pinned.requestId }, pinned.requestId),
                  ),
                ) : null,
          ),
          diag.length > 0
            ? h('div', { className: 'duc-section' },
                h('div', { className: 'duc-section-head' },
                  h('h3', { className: 'duc-section-title' }, t('context.compactionDiag')),
                  h('span', { className: 'duc-small duc-muted' }, fmt.int(diag.length)),
                ),
                h('div', { className: 'duc-small duc-muted', style: { marginBottom: 8 } }, t('context.obsDiffNote')),
                h('div', { className: 'duc-tablewrap' },
                  h('table', { className: 'duc-table' },
                    h('thead', null, h('tr', null,
                      h('th', null, t('table.time')),
                      h('th', { className: 'num' }, t('context.beforeLast')),
                      h('th', { className: 'num' }, t('context.afterFirst')),
                      h('th', { className: 'num' }, t('context.obsDiff')),
                      h('th', { className: 'num', title: t('context.afterFirst') }, t('context.obsRatio')),
                      h('th', { className: 'num' }, t('context.duration')),
                      h('th', { className: 'num' }, `≈ ${t('table.cost')}`),
                    )),
                    h('tbody', null, diag.slice().reverse().map(({ m, before, after }) => {
                      const drop = before !== null && after !== null ? before - after : null;
                      const afterRatio = before !== null && after !== null && before > 0 ? after / before : null;
                      return h('tr', { key: m.requestId, title: m.requestId },
                        h('td', null, fmt.dateTime(m.timestamp)),
                        h('td', { className: 'num' }, num(before)),
                        h('td', { className: 'num' }, num(after)),
                        h('td', { className: 'num' }, drop === null ? '–' : `${drop >= 0 ? '+' : ''}${fmt.compact(drop)}`),
                        h('td', { className: 'num' }, afterRatio === null ? '–' : `${(afterRatio * 100).toFixed(0)}%`),
                        h('td', { className: 'num' }, fmt.ms(m.durationMs)),
                        h('td', { className: 'num' }, money(m)),
                      );
                    })),
                  ),
                ),
              ) : null,
        );
    }

    // -------------------------------------------------------------- dashboard

    const TABS = ['overview', 'requests', 'ledger', 'costs'];

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
