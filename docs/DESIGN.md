# dsh-usage-center 设计说明

数据流：会话事件（实时 + 历史）→ SessionNormalizer → SQLite 账本（`usage_records`，唯一事实源）→ `daily_stats`（派生缓存）→ QueryService → HTTP API → Web 面板。

## 采集与归一化

实时路径监听 Host 的 `session/event`；历史路径经 `ctx.sessionQuery.readSession()` 读会话日志。两条路径把事件交给同一个 SessionNormalizer，因此对同一事件流的归一化结果相同。

消费的事件类型（v4 日志实测）：

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
- 价格引擎与上下文监控未实现，对应面板页只显示说明。
