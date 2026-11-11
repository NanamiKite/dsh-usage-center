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
| `context_samples` | 窗口声明流（每个 `request/context` 事件一行：seq + contextWindow + 模型元数据） |
| `context_observations` | 派生逐请求观测（schema v6）：每条有输入用量的请求一行 + 压缩标记行；`missing_mask` 记录缺失类别，窗口按声明顺序关联 |
| `price_lists` / `prices` | 从配置同步的版本化价格表，按内容哈希去重 |
| `cost_entries` | 派生费用缓存；主键 `request_id`，每请求一行，四类 token 各一列整数微货币单位 + `missing_mask` |
| `meta` | schema 版本与聚合戳 |

防护：`PRAGMA application_id`（`'dshu'`）拒绝打开无关数据库；`user_version` 驱动步进迁移（当前 v7：v4 窗口声明表，v5 会话标题，v6 观测派生表，v7 价格表峰谷窗口列），遇到更新的 schema 版本拒绝打开。

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
- **峰谷窗口**：表可声明每日重复的 `windows`（`from`/`to` HH:MM，可跨零点，`multiplier` 乘全部单价）；重建时按每条记录时间在**表存储的时区**（显式 `tz`，缺省为配置机器时区、解析后随表入库）选窗口——同一账本在任何机器重算结果一致；窗口外按原价；解析期校验重叠与时区合法性并整表拒绝（歧义不接受）。
- **现价回溯**（`costRetroactive`，默认关）：早于首张表的记录按首张表单价计价并打 `MISSING_RETRO`（bit 16）标记，覆盖率单列 `retroPriced`，界面标注"回溯估算（近似口径）"。锚点是**首张表生效时刻的正常解析**：同 `effectiveFrom` 先入库者优先，首张表匹配不到该模型或缺少某类单价时不跨表拼凑；开关进入价格戳：切换即触发重建。
- 算术：`micro = round(tokens × 每百万单价)`，窗口乘数在类目取整后相乘再取整，整数微货币单位（1e-6）累加，聚合无浮点漂移。
- 某类 token 有量而无价 → 该类不计价并置 missing 标记；覆盖率 = 已计价请求 / 总请求。
- 费用视图在聚合中附上最新生效价格表的单价（含通配 provider 条目），表格呈现 输入/输出/缓存读三列单价 × 用量 → 费用。
- 参考价导入是配置的便捷入口而非独立价格来源：匹配、确认、写入的完整流程见[配置说明](CONFIGURATION.md)；匹配器为 `domain/openrouter.ts` 纯函数，分层：完整 id 相等 > 精确命名空间（账号限定名取首段）> 尾段一致 > 版本归一化 > 近似包含。归一化层只在前面全部落空后尝试：仅把"单个数字-单个数字"的连字符视作版本点（`claude5-5` ↔ `claude5.5`），两侧整体键相等才算命中，不做 `includes()` 猜测；候选再按供应商对齐与否分层，对齐候选排他。多候选时服务端不裁决（不取最短 id、不依赖目录顺序），按 id 排序后整体下发，由用户在下拉里手选。同排名取更短 id 的旧规则只作用于确定性层。导入行键为本地账本 (provider, model)，价格来自不同目录条目时附 `sourceModel` 审计字段（引擎忽略）。

## 上下文观测（逐请求输入趋势）

数据基础是**派生缓存** `context_observations`（schema v6，同 daily_stats 模式，从 `usage_records` × 窗口声明重建）：

- **采样规则**：每条有输入用量（input/cacheRead/cacheWrite 任一非空）的请求产生一个观测点；压缩调用（`kind='compaction'`）即使无用量也保留为标记行；完全无用量的普通请求不产生观测。`missing_mask` 标记缺失类别（bit1 input / bit2 cacheRead / bit4 cacheWrite），缺失不冒充 0。
- **窗口关联**：`request/context` 声明只提供窗口与模型元数据，按事件顺序（声明 seq ≤ 记录 seq 的最近一条）关联到请求；首条声明之前的请求窗口未知（NULL），不用未来声明回填历史；最近一条声明自身无窗口值时同样未知（如切换到未上报窗口的模型），不沿用更早声明的值。
- **一致性**：观测不入采集写路径——实时与历史重放都只写账本，观测从账本派生，天然一致；用量修正后重建即收敛。脏检测三通道：进程内记录写标记 + 声明修订号 + `MAX(updated_at)` 戳。
- **读取时补全**：`contextObservations` 在查询时按 `request_id`（主键，1:1）LEFT JOIN `usage_records`（输出/耗时/首字延迟/错误码/输入三分类原值）与 `cost_entries`（该请求估算费用），观测表本身只存派生最小列；联表前先确保观测与费用两个缓存都已按最新写入重建（写后读一致），无价格表时费用字段为 null，不是 0。
- 总览聚合（`contextOverview`）：每会话最近输入/上次输入/增减（含模型切换标记）/历史最大输入/观测数/压缩数/窗口；无观测但有记录的会话保留并提示。

界面按此回答三个问题：最近一次请求实际送入多少、何时明显增长、压缩发生了什么。“窗口占比”是辅助信息，界面明确标注窗口剩余不是可安全使用的输入预算；不做压缩阈值预测。会话名回退顺序：`sessions.title` > 工作区目录名 > id 前 16 位；台账按谱系把子代理归入父会话并可展开。上下文不再独立成页：请求页的会话选择器（搜索型树，子代理缩进带徽标；**懒加载**轻量 `/sessions`，打开时才取，平时零上下文请求）即入口，选定会话即在请求表格上方嵌入诊断面板；面板摘要卡**从观测序列自身推导**（记录总数由详情接口附带），清除筛选即移除。

请求页内嵌的会话面板把观测序列做成诊断视图：

- **逐点交互**：每个观测一条透明命中条——悬停显示时间/序号/模型/输入/较上次增减（含部分缺失标记），点击固定该请求并展开完整明细（输入三分类原值、输出、耗时、首字延迟、错误码、窗口、该请求估算费用、请求 ID）。明细全部来自上述读时联表，不发起第二次请求。
- **窗口分段**：窗口线按声明区段绘制（每段一条虚线并标注数值），不再全程一条线；窗口远超数据峰值时该段钉在图表顶部并标 ↑。
- **压缩标记与诊断**：每次压缩一条竖线标记，可点击；诊断列表给出压缩前最后输入、压缩后首次输入、**压缩前后观测差额**与比例（压缩后÷压缩前）、耗时与该次估算费用——差额是两次观测之差，界面明确“不代表实际节省量”；无数据处显示 –（不造 0），压缩后无观测时后值留空。
- **分层与范围**：尝试/重试（`kind='attempt'`）默认隐藏，可切换为空心点层（失败 attempt 的错误码在下钻中展示）；范围可切最近 50/200/全部。增减与模型切换（⇄）在完整序列上预计算，切窄范围后首个可见点仍知道自己的上次。

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

面板配色采用运行时自适应：启动时探测宿主主题令牌是否可达，可达则 `var(--token, 字面量)` 跟随主题，不可达则落到同一套字面量配色；`<style data-theme>` 标记当前模式。引擎侧的实现约束（禁 color-mix、颜色必经 style 属性等）见[开发指南](DEVELOPMENT.md)。

## 会话内集成

`/usage` 斜杠命令与 `usage_center` 只读 Agent 工具经声明式 `ctx.inject(['commands'|'tools'], cb)` 注册。注册结果写入 meta 并经 `/health` 的 `integrations` 字段暴露，注册失败不依赖宿主日志即可诊断。命令行入口 `bin/usage-center.mjs` 以只读方式打开同一账本（跳过迁移与惰性重建）。工具定义的输出契约（`output.render` 必须返回内容块数组）见[开发指南](DEVELOPMENT.md)。

## 已知边界

- `listSessions` 返回的会话头不含增量或更新信号，历史导入只能全量重读；幂等保证正确性。
- `reasoningTokens` 字段保留，但本地 provider 未上报过该值（恒为 NULL）。
- 费用估算依赖用户配置的价格表；未配置或未覆盖的时段/类别不计价，不猜价。
- 上下文观测是日志派生值（请求的 input+缓存读+缓存写），不是模型侧精确上下文计量；窗口远大于实际用量时走势图按数据定刻度，窗口分段以贴顶虚线示意。
