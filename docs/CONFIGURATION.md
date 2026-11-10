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
```

生效与匹配规则：

- 任一时刻套用 `effectiveFrom` 不晚于该请求时间的**最新一张表**；早于首张表的请求不计价
- 表内按 精确 provider+model > 通配 provider > 通配 model 取**最具体**的条目
- 某类 token 有量而无价 → 该类不计价并计入未覆盖率（面板可见），绝不猜价
- 换价不改历史：调价请追加新表（新的 `effectiveFrom`），不要改旧表

## 参考价导入

价格可以手写，也可以在费用页点 **"参考价…"** 从 OpenRouter 公开价导入，全程显式：

1. 点按钮才会请求 `https://openrouter.ai/api/v1/models`；除此之外插件不出网
2. 弹窗把账本里的 (供应商， 模型) 与 OpenRouter 条目匹配，标注匹配质量（精确 / 一致 / 近似 / 无匹配）；精确与一致默认勾选，近似和无匹配不勾选
3. 只把你**勾选的行**写入配置，成为一张新价格表（`currency: USD`、`effectiveFrom` 当天、表名 `openrouter <日期>` 保留来源），插件自动重载生效
4. 之后在 `cordis.patch.yml` 里能看到并可手工修改

OpenRouter 参考价不等于你的实际账单（订阅、渠道折扣都不反映在牌价里），它只是估算依据——界面与确认页都写明这一点。

## 数据与隐私

- 账本是本机单个 SQLite 文件（WAL 模式），删除 `databasePath` 指向的文件即清空全部数据
- 不联网、不上传；唯一的出网请求是上文的参考价按钮，且只发生在你点击之后
