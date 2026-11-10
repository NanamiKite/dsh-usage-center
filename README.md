# dsh-usage-center

DeepSeek Harness（DSH）插件：把所有会话的 LLM 用量收进一个本地 SQLite 账本，并在 Web 界面里查看统计。

DSH 自带的 token 显示只覆盖当前会话。想在一天结束后看"今天总共用了多少 token""哪个模型用得最多""那次失败的调用到底报了什么错"，就需要一份跨会话、可核对的账。这个插件做的就是这件事：实时监听会话事件、启动时导入历史会话日志，把每一次模型调用归一成一条记录存进本地账本，再从账本出统计。

## 功能

- **采集**：实时监听 `session/event`，启动时导入全部历史会话；两条路径走同一套归一化逻辑，对同一事件流结果一致。
- **账本**：每次 LLM 调用一条记录——输入/输出/缓存 token、时长、首字延迟、结束原因、错误信息、子代理谱系。主键 `sessionId:seq`，重复导入零增量；缺失字段存 NULL，不冒充 0。
- **统计**：按天趋势（含缓存命中率、平均首字延迟）、按模型/提供商/调用类型分解、逐会话台账。日聚合表从账本派生，随时可重建。
- **费用估算**：在配置里维护版本化价格表（生效日期 + 每 1M token 单价），按请求时间套用对应价格表，整数微单位累计，未覆盖时段与未配置的类别如实留空——估算永远是估算，不是账单。
- **导出**：请求明细 / 费用 / 会话汇总，CSV（UTF-8 BOM，Excel 直接打开）或 JSON。
- **对账**：`/report/reconcile` 独立重读全部会话日志并与账本逐字段比对，输出差异报告。
- **面板**：侧栏"用量中心"全局面板，整页仪表盘分总览/请求/台账/费用/上下文五个页签，趋势图与 26 周活跃热力图，界面语言跟随宿主（中/英）。
- **HTTP API**：只读 JSON 接口，供脚本和其他工具直接取数。

上下文监控还没有实现：上下文页只显示一行空态说明。

## 安装

前置：DSH 桌面版（Web GUI）。

```sh
git clone <本仓库> dsh-usage-center
cd dsh-usage-center
pnpm install
pnpm build        # 生成 lib/
```

然后在 DSH 会话中通过 `plugin_manager` 以本地目录方式安装（`install_bundle`，目标为该目录的绝对路径）。安装后刷新 Web 页面，侧栏出现"用量中心"图标。

## 配置（cordis.patch.yml 的 config 段）

| 字段 | 默认 | 说明 |
|---|---|---|
| `databasePath` | `$DSH_HOME/dsh-usage-center/usage-center.db` | SQLite 文件路径 |
| `importConcurrency` | `2` | 历史导入并发（1–8） |
| `historyImport` | `true` | 启动时导入历史会话 |
| `apiPath` | `/dsh-usage-center/v1` | HTTP 查询前缀（客户端面板按默认前缀取数） |
| `prices` | — | 价格表数组，见下 |
| `priceAliases` | 内置 `glm→z-ai` 等 | 账本 provider → 价格源 provider，覆盖内置别名 |
| `priceSourceUrl` | OpenRouter 模型 API | 参考价数据源 URL |

价格表格式（在 cordis.patch.yml 的 config 段，追加即生效、按内容去重）：

```yaml
prices:
  - name: 2026-11            # 可选
    currency: USD            # ISO 4217
    effectiveFrom: '2026-11-01'   # 本地日期或 epoch ms；此后的请求按本表计价
    models:
      - { provider: glm, model: glm-5.3, input: 0.5, output: 1.5, cacheRead: 0.05 }
      - { model: deepseek-flash, input: 0.27, output: 1.1 }   # 不写 provider 即通配
```

单价均为**每 1M token**。同一时刻生效日期最新的一张表生效；表内按 精确 provider+model > 通配 provider > 通配 model 取最具体的条目。某类 token 没配价就按未计价处理并计数（覆盖率可见），绝不猜价。

不想手抄价格的话，费用页（未配置价格时）有“参考价”：从 [OpenRouter](https://openrouter.ai/api/v1/models) 公开列表拉取市场参考价，把账本里的模型按别名表（`glm→z-ai`、`deepseek-account→deepseek`、`gpt→openai`，可用 `priceAliases` 覆盖）匹配出单价，生成可直接粘贴的 `prices` 配置。建议永不自动生效——源里找不到的模型会如实标为未匹配。同名字段 `priceSourceUrl` 可换数据源。参考价是聚合商市场价，不是你账户的账单价格。

## HTTP API

前缀默认 `/dsh-usage-center/v1`，全部为 GET，返回 JSON：

| 路径 | 参数 | 内容 |
|---|---|---|
| `/health` | — | 存活检查与数据库路径 |
| `/summary` | `sessionId` `provider` `model` `kind` `from` `to` `includeSeed` | 总量、今日、按模型/类型、费用估算汇总 |
| `/records` | 同上，另加 `limit` `offset` `order` | 请求明细（分页） |
| `/trend` | `days`（1–366） | 逐日聚合，区间零填充 |
| `/breakdown` | `by=model\|provider\|kind` | 分组统计 |
| `/sessions` | `limit` `offset` | 逐会话台账汇总 |
| `/prices` | — | 已同步的价格表 |
| `/prices/suggest` | — | 拉取公开列表，生成参考价建议与可粘贴 YAML（不落库） |
| `/costs` | `from` `to` | 估算费用（按币种/模型/天 + 覆盖率） |
| `/export` | `what=records\|costs\|sessions` `format=csv\|json` 及明细筛选 | 文件下载 |
| `/report/reconcile` | — | 账本 vs 会话日志对账报告（全量重读，秒级） |

## 局限

- 历史导入每次启动全量重读会话日志。`sessionQuery` 的会话列表不含增量信号，无法在不读日志的前提下判断某个会话没变，因此用幂等换性能。
- 账本只在本机 SQLite，不联网、不上传。
- 费用是按你配置的价格表得出的估算，与任何供应商账单无关；不配置价格就不显示金额。
- 上下文监控未实现。

## 文档

- [docs/DESIGN.md](docs/DESIGN.md) —— 架构、数据模型、归一化规则、客户端注册契约。

## 开发

```sh
pnpm check                          # typecheck + 单元测试 + 构建
node scripts/verify-vs-logs.mjs     # 账本与本机真实会话日志对账 + 重放幂等检查
node scripts/smoke-client.mjs       # 客户端注册形状检查
node scripts/render-client.mjs      # 客户端组件树渲染驱动（改 client/ 后必跑）
```

运行时零 npm 依赖（SQLite 用 Node 内置 `node:sqlite`）；开发依赖只有 TypeScript。

## License

GPL-3.0-or-later，见 [LICENSE](LICENSE)。
