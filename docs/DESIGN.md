# 设计说明

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
- 会话头部的 `parentSession` / `origin` / seed 标记随记录入库，子代理流量可按谱系区分；仅元数据（isSeed/cwd/origin/谱系/sourceEvent）变化的修正同样触发更新。

## 存储

SQLite（`node:sqlite`，无原生依赖），默认 `$DSH_HOME/dsh-usage-center/usage-center.db`，WAL 模式。

| 表 | 内容 |
|---|---|
| `usage_records` | 每次 LLM 调用一条；主键 `request_id`；timestamp / session / model / kind 建索引 |
| `sessions` | 会话元数据（含 `title`）与导入水位（`last_seq`） |
| `daily_stats` | 派生日聚合；主键 `(day, provider, model)`；day 为本地日历日 |
| `context_samples` | 每请求上下文采样；主键 `(session_id, seq)`；水位回填见"上下文监控" |
| `price_lists` / `prices` | 从配置同步的版本化价格表，按内容哈希去重 |
| `cost_entries` | 派生费用缓存；主键 `request_id`，每请求一行，四类 token 各一列整数微货币单位 + `missing_mask` |
| `meta` | schema 版本与聚合戳 |

防护：`PRAGMA application_id`（`'dshu'`）拒绝打开无关数据库；`user_version` 驱动步进迁移（当前 v5），遇到更新的 schema 版本拒绝打开。

### 派生缓存的维护（daily_stats / cost_entries 共用模式）

写路径零额外开销；读侧在查询前检查脏否并按需重建。

- 脏检测双通道：进程内写标记（覆盖同毫秒写）+ 戳比较（`MAX(updated_at)` vs `meta.stats_stamp`；费用侧为记录戳×价格表版本戳），覆盖进程重启。
- 重建是单事务全量重算（DELETE + INSERT），任何修正路径都收敛，不存在增量漂移。
- 日分桶在 Node 本地时区完成：SQLite 的 `localtime` 修饰符在 Windows 回退 UTC，不能用于分桶。
- 趋势区间按日历日（`setDate`）推进并零填充，跨夏令时不断轴。

## 查询

QueryService 是唯一统计出口，HTTP API 与 Web 面板都不自行计算。

- `summary(filters)` 的 totals/byModel/byKind/costs 应用同一套筛选；`today` 与传入 from/to 取交集而非覆盖；`ledger` 与 `sessions` 是全局元信息，不受筛选影响。
- `trend(days)`：逐日聚合，含 cacheHitRate、平均首字延迟、平均时长、错误数；`trendSeries(by)` 按 provider/model 分组返回 Top 6 + 其余合并的逐日序列。
- `breakdown(by)`：`model` / `provider` / `kind` 分组，未知维度报错。
- `sessions`：逐会话汇总（LEFT JOIN，无记录的会话 requests=0），按最后活动排序；分页视图上限 200，导出走无上限通道。

## 费用估算

价格来自插件配置（`prices` 数组），启动时同步进 `price_lists`/`prices` 表：追加式、按内容哈希去重，同一配置重复启动无副作用。

- 生效语义与表内匹配见[配置说明](CONFIGURATION.md)。
- 算术：`micro = round(tokens × 每百万单价)`，整数微货币单位（1e-6）累加，聚合无浮点漂移。
- 某类 token 有量而无价 → 该类不计价并置 missing 标记；覆盖率 = 已计价请求 / 总请求。
- 费用视图在聚合中附上最新生效价格表的单价（含通配 provider 条目），表格呈现 输入/输出/缓存读三列单价 × 用量 → 费用。
- 参考价导入是配置的便捷入口而非独立价格来源：匹配、确认、写入的完整流程见[配置说明](CONFIGURATION.md)；匹配器为 `domain/openrouter.ts` 纯函数（完整 id 相等 > 精确命名空间 > 账号限定名取首段 > 尾段一致 > 近似包含；同排名取更短 id）。

## 上下文监控

`request/context` 事件写入 `context_samples`（主键 session+seq）。上下文水位是派生值：某请求之后第一条带 usage 的记录，其 input+cacheRead+cacheWrite 即喂给模型的上下文，回填到该会话所有尚未回填且 seq 更小的采样（同一逻辑请求的重试/尝试共享该值）。回填条件为 `context_tokens IS NULL OR request_id = 本记录`——账本修正后的重放也能收敛，且不抢占已归属其他请求的采样。会话级视图取每会话最新采样与历史峰值，压缩次数由 `kind='compaction'` 记录数得出。

走势图刻度按数据峰值 ×1.1 定，窗口虚线只在 ≤2×峰值时按真实高度画出；窗口远大于数据时虚线贴图顶、标签带 `↑` 表示在图示范围之上，标签始终钳制在绘图区内。会话在界面显示名称，回退顺序：`sessions.title` > 工作区目录名 > 会话 id 前 16 位；台账按谱系把子代理归入父会话并可展开。

## 对账

`/report/reconcile` 用一条独立于采集器的简化干路（只加总三类用量事件的 token 字段，attempt 从流末尾的 usage chunk 取数）重读全部会话日志，与账本逐会话逐字段比对；账本有而列表没有的会话也作为错误列出。独立性是有意的：采集器的 bug 不能被自己掩盖。

## 导出

`/export` 复用 QueryService 的行整形，CSV 按 RFC 4180 转义（含引号/逗号/换行），前置 UTF-8 BOM 便于 Excel 直接打开；JSON 输出同构对象数组。

## Web 客户端

单文件 `client/index.js`，纯 JavaScript，无构建步骤；React 取自页面模块表（`window.__ModuleLoader__.load`），文案注册进客户端 locale 服务（zh/en）。

注册契约（对照内置 ui-sidebar / ui-layout 客户端实现验证）：

- `sidebar.panellist` 是数据槽：宿主按注册项 `{id, order, label}` 渲染行（按钮、tooltip、激活态）并接 `layout.selectPanel(id)`；注册组件只画图标，收到 props `{size, active}`。
- `main` 为 keyed 插槽：以 activePanelId 为 entryKey 渲染；占用组件不收运行时 props，需自包含。
- 面板数据经同源 fetch 调 HTTP API，15 秒轮询；趋势维度（总览/提供商/模型）与价格导入等交互按响应自带的结构标记解读数据，避免用新查询参数解释旧响应。

面板配色采用运行时自适应：启动时探测宿主主题令牌是否可达，可达则 `var(--token, 字面量)` 跟随主题，不可达则落到同一套字面量配色；`<style data-theme>` 标记当前模式。引擎相关的实现约束（禁 color-mix、颜色必经 style 属性等）见[开发指南](DEVELOPMENT.md)。

## 会话内集成

`/usage` 斜杠命令与 `usage_center` 只读 Agent 工具经声明式 `ctx.inject(['commands'|'tools'], cb)` 注册。注册结果写入 meta 并经 `/health` 的 `integrations` 字段暴露，注册失败不依赖宿主日志即可诊断。命令行入口 `bin/usage-center.mjs` 以只读方式打开同一账本（跳过迁移与惰性重建）。工具定义的输出契约（`output.render` 必须返回内容块数组）见[开发指南](DEVELOPMENT.md)。

## 已知边界

- `listSessions` 返回的会话头不含增量或更新信号，历史导入只能全量重读；幂等保证正确性。
- `reasoningTokens` 字段保留，但本地 provider 未上报过该值（恒为 NULL）。
- 费用估算依赖用户配置的价格表；未配置或未覆盖的时段/类别不计价，不猜价。
- 上下文水位是日志派生值（请求的 input+缓存读+缓存写），不是模型侧精确上下文计量；窗口远大于实际用量时走势图按数据定刻度，窗口以贴顶虚线示意。
