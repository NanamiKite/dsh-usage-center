# API 参考

## HTTP API

前缀默认 `/dsh-usage-center/v1`（可用 `apiPath` 配置），返回 JSON。除参考价两个 POST 外全部为 GET/HEAD。

| 路径 | 方法 | 参数 | 内容 |
|---|---|---|---|
| `/health` | GET | — | 存活检查、数据库路径、`integrations`（命令/工具注册结果） |
| `/summary` | GET | `sessionId` `provider` `model` `kind` `from` `to` `includeSeed` | 总量、今日、按模型/类型、费用估算汇总；筛选一致作用于各视图，`today` 与 from/to 取交集 |
| `/records` | GET | 同上，另加 `limit` `offset` `order` | 请求明细（分页） |
| `/trend` | GET | `days`（1–366）`by=all\|provider\|model` | 逐日聚合；分组模式返回按 key 的序列（Top 6 + 其他） |
| `/breakdown` | GET | `by=model\|provider\|kind` | 分组统计 |
| `/sessions` | GET | `limit` `offset` | 逐会话台账汇总（上限 200/页） |
| `/prices` | GET | — | 已同步的价格表（含 `windows` 窗口配置）与回溯开关状态 `retroactive` |
| `/costs` | GET | `from` `to` `sessionId` `provider` `model` `kind` | 估算费用（按币种/模型/天 + 覆盖率 + 最新价格表生效时间 `effectiveFrom`，用于解释"已配置但尚无覆盖"） |
| `/context` | GET | `sessionId`（可选） | 各会话输入观测汇总（最近输入/增减/历史最大/观测数/压缩/窗口）；带 sessionId 时返回该会话逐请求观测序列与 `totalRequests`（该会话账本记录总数），每行在读时联表补全：`inputRaw`/`cacheRead`/`cacheWrite`/`outputTokens`/`durationMs`/`firstTokenLatencyMs`/`errorCode`（来自 `usage_records`）与 `costMicro`/`costCurrency`（来自 `cost_entries`，无价格表时为 null，不是 0） |
| `/export` | GET | `what=records\|costs\|sessions` `format=csv\|json` 及明细筛选 | 文件下载（CSV 带 UTF-8 BOM） |
| `/report/reconcile` | GET | — | 账本 vs 会话日志对账报告（全量重读，秒级） |
| `/prices/suggest` | POST | — | 拉取 OpenRouter 公开价，返回匹配建议与 `historyBefore`（早于当天本地零点的请求数及最早时间，供导入时选择生效方式）；不改任何状态 |
| `/prices/import` | POST | `{ models: [...], effectiveFrom?, retroactive? }` | 把勾选行写入配置为新价格表，插件重载后生效；`effectiveFrom` 可提前生效日，`retroactive: true` 同时开启回溯估算模式 |

两个 POST 只在费用页"参考价…"按钮触发时使用（见[配置说明](CONFIGURATION.md)）。

## `/usage` 命令

会话内斜杠命令，直接返回汇总（请求/token/缓存命中率/模型前三）。

## `usage_center` 工具

只读 Agent 工具，参数：

| 参数 | 取值 | 说明 |
|---|---|---|
| `view` | `summary`（默认）`today` `models` `context` | 返回哪类视图 |
| `sessionId` | 会话 id | `view=context` 时返回该会话的逐请求上下文序列 |

## CLI

```sh
node bin/usage-center.mjs                # 汇总（请求/token/缓存命中率/模型前三）
node bin/usage-center.mjs --view context # 各会话输入观测汇总
node bin/usage-center.mjs --view models --json
```

| 参数 | 说明 |
|---|---|
| `--db <path>` | 指定账本文件（默认同插件配置） |
| `--view <name>` | `summary` / `today` / `models` / `context` |
| `--json` | 输出 JSON 而非文本 |

CLI 以只读方式打开账本（跳过迁移与惰性重建），可在插件运行时安全使用。
