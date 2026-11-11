# 配置说明

配置写在 DSH profile 的 `cordis.patch.yml` 中 `dsh-usage-center` 行的 `config` 段。改完保存即重载；价格表追加即生效、按内容去重，重复写入无副作用。

## 字段

| 字段 | 默认 | 说明 |
|---|---|---|
| `databasePath` | `$DSH_HOME/dsh-usage-center/usage-center.db` | SQLite 文件路径 |
| `importConcurrency` | `2` | 历史导入并发（1–8） |
| `historyImport` | `true` | 启动时导入历史会话 |
| `apiPath` | `/dsh-usage-center/v1` | HTTP 查询前缀（客户端面板按默认前缀取数） |
| `prices` | — | 价格表数组，见下 |
| `costRetroactive` | `false` | 现价回溯估算：早于首张价格表的请求按首张表单价估算，界面标注"回溯估算"（近似口径）；默认关闭，历史不计价 |

## 价格表

单价均为**每 1M token**，四类分开（`input` / `output` / `cacheRead` / `cacheWrite`），缺哪类哪类不计价。

```yaml
prices:
  - name: 2026-11            # 可选，仅用于展示
    currency: USD            # ISO 4217
    effectiveFrom: '2026-11-01'   # 本地日期（YYYY-MM-DD）或 epoch ms
    models:
      - { provider: glm, model: glm-5.3, input: 0.5, output: 1.5, cacheRead: 0.05 }
      - { model: deepseek-flash, input: 0.27, output: 1.1 }   # 不写 provider 即通配
    windows:                 # 可选：每日重复的峰谷费率窗口
      - { from: '00:30', to: '16:00', multiplier: 1 }          # 常规价
      - { from: '16:00', to: '00:30', multiplier: 0.5 }        # 谷时半价（可跨零点）
    tz: Asia/Shanghai        # 可选：窗口所用 IANA 时区；缺省按配置机器时区解析并随表存储
```

生效与匹配规则：

- 任一时刻套用 `effectiveFrom` 不晚于该请求时间的**最新一张表**；早于首张表的请求不计价（除非开启 `costRetroactive`，见上）
- 表内按四档取最具体条目：**精确 provider+精确 model > 通配 provider+精确 model > 精确 provider+通配 model > 全通配**（model 精确优先于 provider 精确）
- 某类 token 有量而无价 → 该类不计价并计入未覆盖率（面板可见），绝不猜价
- `windows` 按请求时间在表声明（或解析后存储）的时区里选窗口，乘数作用于该表全部单价；跨零点合法；不在任何窗口内按原价；**窗口重叠或时区非法的表整张拒绝**
- 回溯模式的锚点 = **首张表生效时刻**的正常解析：同 `effectiveFrom` 时先入库者优先；首张表匹配不到该模型则该行不计价（不跨表拼凑条目或补类别）；缺类别照常标记
- `effectiveFrom` 严格校验：`2026-02-30`、`2026-13-01` 这类会被日历滚动的日期按非法处理（整表拒绝），不静默偏移
- 换价不改历史：调价请追加新表（新的 `effectiveFrom`），不要改旧表

## 参考价导入

价格可以手写，也可以在费用页点 **"参考价…"** 从 OpenRouter 公开价导入，全程显式：

1. 点按钮才会请求 `https://openrouter.ai/api/v1/models`；除此之外插件不出网
2. 弹窗把账本里的 (供应商、模型) 与 OpenRouter 条目匹配，标注匹配质量（精确 / 一致 / 近似 / 无匹配）；精确与一致默认勾选，近似和无匹配不勾选
3. 只把你**勾选的行**写入配置，成为一张新价格表（`currency: USD`、`effectiveFrom` 当天、表名 `openrouter <日期>` 保留来源），插件自动重载生效
4. 之后在 `cordis.patch.yml` 里能看到并可手工修改

OpenRouter 参考价不等于你的实际账单（订阅、渠道折扣都不反映在牌价里），它只是估算依据——界面与确认页都写明这一点。

导入的表自**当天**生效：此前的历史请求不追溯计价（没有公开的历史价数据，不猜）。两条出路：价格在更早时段确实相同时，把配置中该表的 `effectiveFrom` 改早即可覆盖那段历史；或开启 `costRetroactive: true`，让早于首张表的请求按首张表单价估算——界面会标注"回溯估算"（近似口径，非精确历史价）。价格变动过的时段应各自配一张表。

## 数据与隐私

- 账本是本机单个 SQLite 文件（WAL 模式），删除 `databasePath` 指向的文件即清空全部数据
- 不联网、不上传；唯一的出网请求是上文的参考价按钮，且只发生在你点击之后
