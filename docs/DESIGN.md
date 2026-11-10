# dsh-usage-center 设计说明

数据流：会话事件（实时 + 历史）→ SessionNormalizer → SQLite 账本（`usage_records`，唯一事实源）→ 派生缓存（`daily_stats`、`cost_entries`）→ QueryService → HTTP API → Web 面板。

## 采集与归一化

实时路径监听 Host 的 `session/event`；历史路径经 `ctx.sessionQuery.readSession()` 读会话日志。两条路径把事件交给同一个 SessionNormalizer，因此对同一事件流的归一化结果相同。

消费的事件类型（v4 日志）：

| 事件 | 用途 |
|---|---|
| `step/start` | 步骤计时锚点（时长与首字延迟的起点） |
| `assistant/message` | 已完成的对话调用：usage + 内嵌流 |
| `compaction/summary` | 压缩摘要器自身的 LLM 调用（自带 usage/provider/model） |
| `assistant/attempt` | 失败/重试/取消的尝试：token 与 finish/failure 在内嵌流的 terminal chunk |
| `llm/retry` | 对同一 (turn, step) 尝试的补充：provider、失败码、重试计数；按同主键修正合并 |
| `request/context` | 每次请求的 `{provider, model, contextWindow}`，写入 `context_samples` |
| `session/title` | 会话标题（`{title, messageSeqs, source}`），写入 `sessions.title` |

归一化规则：

- 记录主键 `requestId = sessionId:seq`，重放幂等；`llm/retry` 修正属同键更新，账本行数不变。
- 跨启动边界：实时 tracker 对无主的 `llm/retry` 直接忽略（该尝试属于启动前的历史，归历史导入所有）；历史回放仍会把真正丢失尝试的 retry 记为兜底行（`source_event='llm/retry'`）。当同 (turn, step) 的真实尝试行落库时，账本自动清除对应兜底行——已产生的重复也会在下次重导时愈合。
- 首字延迟按官方 `isTokenDelta` 语义从内嵌流重建：text/reasoning 非空增量、tool-call 非空参数或带名即计；packed run 用 `time0 + dt` 还原时间。
- usage 字段缺失存 NULL；`rawUsage` 保留原始 JSON 供日后重解析。
- 会话头部的 `parentSession` / `origin` / seed 标记随记录入库，子代理流量可按谱系区分。

## 存储

SQLite（`node:sqlite`，无原生依赖），默认 `$DSH_HOME/dsh-usage-center/usage-center.db`，WAL 模式。

| 表 | 内容 |
|---|---|
| `usage_records` | 每次 LLM 调用一条；主键 `request_id`；timestamp / session / model / kind 建索引 |
| `sessions` | 会话元数据（含 `title`）与导入水位（`last_seq`） |
| `daily_stats` | 派生日聚合；主键 `(day, provider, model)`；day 为本地日历日 |
| `context_samples` | 每请求上下文采样；主键 `(session_id, seq)`；水位回填见"上下文监控" |
| `price_lists` / `prices` | 从配置同步的版本化价格表（生效日期 + 每 1M token 单价），按内容哈希去重 |
| `cost_entries` | 派生费用缓存；主键 `request_id`，每请求一行，四类 token 各一列整数微货币单位 + `missing_mask` |
| `meta` | schema 版本与聚合戳 |

防护：`PRAGMA application_id`（`'dshu'`）拒绝打开无关数据库；`user_version` 驱动步进迁移（当前 v5：v4 加 `context_samples`，v5 给 `sessions` 加 `title`），遇到更新的 schema 版本拒绝打开。

### daily_stats 的维护

写路径零额外开销；读侧在查询前检查脏否并按需重建。

- 脏检测双通道：进程内写标记（覆盖同毫秒写）+ `MAX(updated_at)` 与 `meta.stats_stamp` 比较（覆盖进程重启）。
- 重建是单事务全量重算（DELETE + INSERT），任何修正路径（含 `llm/retry`）都收敛，不存在增量漂移。
- 日分桶在 Node 本地时区完成：SQLite 的 `localtime` 修饰符在 Windows 回退 UTC，不能用于分桶。
- 趋势区间按日历日（`setDate`）推进并零填充，跨夏令时不断轴。

## 查询

QueryService 是唯一统计出口，HTTP API 与 Web 面板都不自行计算。除明细与汇总外：

- `summary(filters)` 的 totals/byModel/byKind/costs 应用同一套筛选；`today` 与传入 from/to 取交集而非覆盖；`ledger` 与 `sessions` 是全局元信息，不受筛选影响。
- `trend(days)`：逐日聚合，含 cacheHitRate、平均首字延迟、平均时长、错误数；`trendSeries(by)` 按 provider/model 分组返回 Top 6 + 其余合并的逐日序列；
- `breakdown(by)`：`model` / `provider` / `kind` 分组，未知维度报错；
- `sessions`：逐会话汇总（LEFT JOIN，无记录的会话 requests=0），按最后活动排序；分页视图上限 200，导出走无上限通道。

## HTTP API

端点清单见 README。实现为 `webServer` 前缀路由，Node req/res 风格（非 fetch 风格）；数据查询仅 GET/HEAD，另有两个显式 POST（参考价 suggest/import）。

路由注册必须走声明式 `ctx.inject(['webServer'], cb)`：冷启动时本插件行可能先于 webServer 服务激活，`ctx.get()` 会静默扑空（面板随后 404），注入回调则等服务就绪才执行，且其 disposer 在服务消失时注销路由。

## 费用估算

价格来自插件配置（`prices` 数组），启动时同步进 `price_lists`/`prices` 表：追加式、按内容哈希去重，因此同一配置重复启动无副作用。

- 生效语义：任一时刻套用 `effectiveFrom` 不晚于该请求时间的最新一张表；早于首张表的请求不计价。
- 表内匹配：精确 provider+model > 通配 provider > 通配 model，取最具体条目。
- 算术：`micro = round(tokens × 每百万单价)`，整数微货币单位（1e-6）累加，聚合无浮点漂移。
- 某类 token 有量而无价 → 该类不计价并置 missing 标记；覆盖率 = 已计价请求 / 总请求。
- `cost_entries` 为派生缓存（同 `daily_stats` 模式）：写路径零开销，脏检测（内存写标记 + 记录戳×价格表版本戳）触发单事务全量重建，价格表变更后重算收敛。
- 费用视图在聚合中附上最新生效价格表的单价（含通配 provider 条目），表格呈现 单价 × 用量 → 费用。

### 参考价手动导入

价格表的第三个来源是费用页的"参考价…"按钮，全程显式：

- `POST /prices/suggest` 按需请求 `https://openrouter.ai/api/v1/models`（Node 内置 fetch，20 秒超时）。除此之外插件不出网；不点按钮就没有这次请求。
- 匹配规则（`domain/openrouter.ts`，纯函数）：完整 id 相等（账本 model 本身就是 `org/model` 形态时）> 精确 `provider/model` id > 账号限定名取首段（`deepseek-account` → `deepseek`）> id 尾段一致 > 显示名/id 尾段包含（近似）；同排名取更短 id。精确/一致默认勾选，近似与无匹配不勾选，最终以用户勾选为准。
- `POST /prices/import` 把勾选行经 `ctx.get('configEditor').edit(entry, …)` 追加为一张新价格表（`currency: USD`，`effectiveFrom` 默认今天，表名 `openrouter <日期>` 保留来源痕迹），走普通 Loader 路径持久化并触发插件重载。
- OpenRouter 价格是 per-token 字符串，入库前换算为每 1M 并保留 6 位小数；缺类别（如 `input_cache_write`）按未计价处理。
- 参考价 ≠ 你的实际账单（账号订阅、渠道折扣都不反映在 OpenRouter 牌价里），界面与导入确认页都写明这一点。

## 上下文监控

`request/context` 事件（`{provider, model, contextWindow}`）写入 `context_samples`（主键 session+seq）。上下文水位是派生值：某请求之后第一条带 usage 的记录，其 input+cacheRead+cacheWrite 即喂给模型的上下文，回填到该会话所有尚未回填且 seq 更小的采样（同一逻辑请求的重试/尝试共享该值）。重放时回填 UPDATE 匹配不到未填行，天然幂等。会话级视图取每会话最新采样与历史峰值，压缩次数由 `kind='compaction'` 记录数得出。

走势图刻度按数据峰值 ×1.1 定，窗口虚线只在 ≤2×峰值时按真实高度画出；窗口远大于数据时虚线贴图顶、标签带 `↑` 表示在图示范围之上，标签始终钳制在绘图区内。会话在界面显示名称，回退顺序：`sessions.title` > 工作区目录名 > 会话 id 前 16 位。

## 对账

`/report/reconcile` 用一条独立于采集器的简化干路（只加总三类用量事件的 token 字段，attempt 从流末尾的 usage chunk 取数）重读全部会话日志，与账本逐会话逐字段比对；账本有而列表没有的会话也作为错误列出。独立性是有意的：采集器的 bug 不能被自己掩盖。

## 导出

`/export` 复用 QueryService 的行整形，CSV 按 RFC 4180 转义（含引号/逗号/换行），前置 UTF-8 BOM 便于 Excel 直接打开；JSON 输出同构对象数组。

## Web 客户端

单文件 `client/index.js`，纯 JavaScript，无构建步骤；React 取自页面模块表（`window.__ModuleLoader__.load`）。样式只用 `--dsw-alias-*` 主题令牌；文案注册进客户端 locale 服务（zh/en）。

面板配色策略（运行时自适应，四轮实机排障后的定论）：客户端启动时探测 `--dsw-alias-brand-primary` 是否可达（`getComputedStyle(document.documentElement)`）——可达则全面板用 `var(--token, 字面量)` 跟随宿主主题（图表用品牌色+分段 opacity），不可达则自动落到同一套字面量配色；`<style>` 的 `data-theme` 属性与控制台日志标记当前模式，便于诊断。`color-mix()` 永久禁用（该引擎在 SVG paint 上整条拒绝、回退黑色，smoke 有源码级门禁）；presentation 属性不写颜色，一律经 `style`。

注册契约（对照内置 ui-sidebar / ui-layout 客户端实现验证）：

- `sidebar.panellist` 是数据槽：宿主按注册项 `{id, order, label}` 渲染行（按钮、tooltip、激活态）并接 `layout.selectPanel(id)`；注册组件只画图标，收到 props `{size, active}`。
- `main` 为 keyed 插槽：以 activePanelId 为 entryKey 渲染；占用组件不收运行时 props，需自包含。
- 面板数据经同源 fetch 调 HTTP API，15 秒轮询。

`scripts/render-client.mjs` 用带钩子语义的迷你渲染器驱动组件树（数据态、页签切换、翻页、台账跳转）；`scripts/smoke-client.mjs` 检查注册形状。两者都是 `client/` 改动后的必跑门禁。

## 会话内集成

`/usage` 斜杠命令与 `usage_center` 只读 Agent 工具经声明式 `ctx.inject(['commands'|'tools'], cb)` 注册（Cordis 的服务注入方式，`ctx.get` 拿不到）。注册表对裸工具定义要求 `output: { schema, render }`，且 `render(args, value)` 必须返回内容块数组（`[{type:'text', text}]`），返回字符串会让呈现管线崩溃。注册结果写入 meta 并经 `/health` 的 `integrations` 字段暴露，注册失败不依赖宿主日志即可诊断。命令行入口 `bin/usage-center.mjs` 以只读方式打开同一账本（跳过迁移与惰性重建）。

## 已知边界

- `listSessions` 返回的会话头不含增量或更新信号，历史导入只能全量重读；幂等保证正确性。
- `reasoningTokens` 字段保留，但本地 provider 未上报过该值（恒为 NULL）。
- 费用估算依赖用户配置的价格表；未配置或未覆盖的时段/类别不计价，不猜价。
- 上下文水位是日志派生值（请求的 input+缓存读+缓存写），不是模型侧精确上下文计量；窗口远大于实际用量时走势图按数据定刻度，窗口以贴顶虚线示意。
