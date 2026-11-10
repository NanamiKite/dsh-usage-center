# dsh-usage-center

DeepSeek Harness（DSH）插件：把所有会话的 LLM 用量收进一个本地 SQLite 账本，并在 Web 界面里查看统计。

DSH 自带的 token 显示只覆盖当前会话。想在一天结束后看"今天总共用了多少 token""哪个模型用得最多""那次失败的调用到底报了什么错"，就需要一份跨会话、可核对的账。这个插件做的就是这件事：实时监听会话事件、启动时导入历史会话日志，把每一次模型调用归一成一条记录存进本地账本，再从账本出统计。
## 为啥要写这玩意

下午问群友DSH的token-usage哪个好用，群友说自己写。
于是乎缝合了一下功能。
顺便品一下风味国模GLM5.3的长程任务能力。

## 它能做什么

- **统计**：按天趋势（缓存命中率、首字延迟）、按模型/提供商/类型分解、26 周活跃热力图
- **请求明细**：每次调用一行——四类 token、时长、首字延迟、结束原因、错误信息，可按供应商/模型/类型下拉筛选
- **台账**：逐会话汇总，子代理归入所属对话、可展开收起
- **费用估算**：配置价格表后按"单价 × 用量"推算（永远是估算，不是账单）；价格可手写，也可从 OpenRouter 参考价逐条确认后导入
- **上下文监控**：逐请求输入观测——最近一次请求送入了多少内容、较上次增减多少、历史最高多少；压缩事件计数；窗口占比仅作辅助参考。子代理归入所属会话可展开
- **导出与对账**：CSV/JSON 导出；独立重读全部会话日志与账本逐字段对账
- **多种取数方式**：Web 面板（中/英）、HTTP API、`/usage` 命令、`usage_center` 工具、独立 CLI

缺失字段一律存 NULL 不冒充 0；重复导入零增量；除"参考价"按钮外不联网。

## 快速开始

前置：DSH 桌面版（Web GUI）。

```sh
git clone <本仓库> dsh-usage-center
cd dsh-usage-center
pnpm install
pnpm build        # 生成 lib/
```

在 DSH 会话中通过 `plugin_manager` 以本地目录安装（`install_bundle`，目标为该目录绝对路径），刷新页面后侧栏出现"用量中心"。

费用估算需要在配置里维护价格表，最简示例（完整格式见[配置说明](docs/CONFIGURATION.md)）：

```yaml
prices:
  - currency: USD
    effectiveFrom: '2026-11-01'
    models:
      - { provider: glm, model: glm-5.3, input: 0.5, output: 1.5, cacheRead: 0.05 }
```

## 文档

- [配置说明](docs/CONFIGURATION.md) —— 全部字段、价格表格式与匹配规则、参考价导入
- [API 参考](docs/API.md) —— HTTP 端点、`/usage` 命令、Agent 工具、CLI
- [设计说明](docs/DESIGN.md) —— 数据流、存储模型、归一化与费用/上下文的派生规则
- [开发指南](docs/DEVELOPMENT.md) —— 构建与测试门禁、宿主契约的踩坑记录

## 边界

- 历史导入每次启动全量重读会话日志（`sessionQuery` 无增量信号，用幂等换性能）
- 账本只在本机 SQLite，不上传；费用是估算，与任何供应商账单无关
- 上下文观测是日志派生值（输入用量合计），不是模型侧精确计量；不做压缩阈值与剩余轮次预测

## License

GPL-3.0-or-later，见 [LICENSE](LICENSE)。
