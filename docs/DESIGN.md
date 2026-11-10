# dsh-usage-center 设计说明

数据流：会话事件（实时 + 历史）→ SessionNormalizer → SQLite 账本（`usage_records`，唯一事实源）→ `daily_stats`（派生缓存）→ QueryService → HTTP API → Web 面板。

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

归一化规则：

- 记录主键 `requestId = sessionId:seq`，重放幂等；`llm/retry` 修正属同键更新，账本行数不变。
- 首字延迟按官方 `isTokenDelta` 语义从内嵌流重建：text/reasoning 非空增量、tool-call 非空参数或带名即计；packed run 用 `time0 + dt` 还原时间。
- usage 字段缺失存 NULL；`rawUsage` 保留原始 JSON 供日后重解析。
- 会话头部的 `parentSession` / `origin` / seed 标记随记录入库，子代理流量可按谱系区分。

## 存储

SQLite（`node:sqlite`，无原生依赖），默认 `$DSH_HOME/dsh-usage-center/usage-center.db`，WAL 模式。

| 表 | 内容 |
|---|---|
| `usage_records` | 每次 LLM 调用一条；主键 `request_id`；timestamp / session / model / kind 建索引 |
| `sessions` | 会话元数据与导入水位（`last_seq`） |
| `daily_stats` | 派生日聚合；主键 `(day, provider, model)`；day 为本地日历日 |
| `meta` | schema 版本与聚合戳 |

防护：`PRAGMA application_id`（`'dshu'`）拒绝打开无关数据库；`user_version` 驱动迁移，遇到更新的 schema 版本拒绝打开。

### daily_stats 的维护

写路径零额外开销；读侧在查询前检查脏否并按需重建。

- 脏检测双通道：进程内写标记（覆盖同毫秒写）+ `MAX(updated_at)` 与 `meta.stats_stamp` 比较（覆盖进程重启）。
- 重建是单事务全量重算（DELETE + INSERT），任何修正路径（含 `llm/retry`）都收敛，不存在增量漂移。
- 日分桶在 Node 本地时区完成：SQLite 的 `localtime` 修饰符在 Windows 回退 UTC，不能用于分桶。
- 趋势区间按日历日（`setDate`）推进并零填充，跨夏令时不断轴。

## 查询

QueryService 是唯一统计出口，HTTP API 与 Web 面板都不自行计算。除明细与汇总外：

- `trend(days)`：逐日聚合，含 cacheHitRate、平均首字延迟、平均时长、错误数；
- `breakdown(by)`：`model` / `provider` / `kind` 分组，未知维度报错；
- `sessions`：逐会话汇总（LEFT JOIN，无记录的会话 requests=0），按最后活动排序。

## HTTP API

端点清单见 README。实现为 `webServer` 前缀路由，Node req/res 风格（非 fetch 风格），仅接受 GET/HEAD。

## 费用估算

价格来自插件配置（`prices` 数组），启动时同步进 `price_lists`/`prices` 表：追加式、按内容哈希去重，因此同一配置重复启动无副作用。

- 生效语义：任一时刻套用 `effectiveFrom` 不晚于该请求时间的最新一张表；早于首张表的请求不计价。
- 表内匹配：精确 provider+model > 通配 provider > 通配 model，取最具体条目。
- 算术：`micro = round(tokens × 每百万单价)`，整数微货币单位（1e-6）累加，聚合无浮点漂移。
- 某类 token 有量而无价 → 该类不计价并置 missing 标记；覆盖率 = 已计价请求 / 总请求。
- `cost_entries` 为派生缓存（同 `daily_stats` 模式）：写路径零开销，脏检测（内存写标记 + 记录戳×价格表版本戳）触发单事务全量重建，价格表变更后重算收敛。

## 参考价来源

`/prices/suggest` 拉取公开模型列表（默认 OpenRouter），把每 token 报价换算为每 1M，与账本模型匹配：

- 匹配三级：别名映射（provider 经 `priceAliases`/内置表，如 `glm→z-ai`）> 原名精确 > 模型名全源唯一；其余如实未匹配，不做模糊猜测。
- 输出匹配表（含置信度）与可直接粘贴进 `prices` 配置的 YAML；**建议不写库、不生效**——应用价格始终是用户对配置的一次显式修改。
- 源缺失的价格类别（如无 cacheWrite）在建议中留空，沿用"未计价"语义。

## 对账

`/report/reconcile` 用一条独立于采集器的简化干路（只加总三类用量事件的 token 字段，attempt 从流末尾的 usage chunk 取数）重读全部会话日志，与账本逐会话逐字段比对；账本有而列表没有的会话也作为错误列出。独立性是有意的：采集器的 bug 不能被自己掩盖。

## 导出

`/export` 复用 QueryService 的行整形，CSV 按 RFC 4180 转义（含引号/逗号/换行），前置 UTF-8 BOM 便于 Excel 直接打开；JSON 输出同构对象数组。

## Web 客户端

单文件 `client/index.js`，纯 JavaScript，无构建步骤；React 取自页面模块表（`window.__ModuleLoader__.load`）。样式只用 `--dsw-alias-*` 主题令牌；文案注册进客户端 locale 服务（zh/en）。

注册契约（对照内置 ui-sidebar / ui-layout 客户端实现验证）：

- `sidebar.panellist` 是数据槽：宿主按注册项 `{id, order, label}` 渲染行（按钮、tooltip、激活态）并接 `layout.selectPanel(id)`；注册组件只画图标，收到 props `{size, active}`。
- `main` 为 keyed 插槽：以 activePanelId 为 entryKey 渲染；占用组件不收运行时 props，需自包含。
- 面板数据经同源 fetch 调 HTTP API，15 秒轮询。

`scripts/render-client.mjs` 用带钩子语义的迷你渲染器驱动组件树（数据态、页签切换、翻页、台账跳转）；`scripts/smoke-client.mjs` 检查注册形状。两者都是 `client/` 改动后的必跑门禁。

## 已知边界

- `listSessions` 返回的会话头不含增量或更新信号，历史导入只能全量重读；幂等保证正确性。
- `reasoningTokens` 字段保留，但本地 provider 未上报过该值（恒为 NULL）。
- 费用估算依赖用户配置的价格表；未配置或未覆盖的时段/类别不计价，不猜价。
- 上下文监控未实现，对应面板页为空态。
