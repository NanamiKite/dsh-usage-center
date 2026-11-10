# 开发指南

运行时零 npm 依赖（SQLite 用 Node 内置 `node:sqlite`）；开发依赖只有 TypeScript。

## 构建与测试

```sh
pnpm check                          # typecheck + 单元测试 + 构建（tsc 输出 lib/）
node scripts/verify-vs-logs.mjs     # 账本与本机真实会话日志对账 + 重放幂等检查
node scripts/smoke-client.mjs       # 客户端注册形状 + 源码级配色门禁
node scripts/render-client.mjs      # 客户端组件树渲染驱动（改 client/ 后必跑）
```

门禁约定：`client/` 的任何改动都要过 smoke + render drive；宿主侧（`src/`）改动过 `pnpm check` + verify-vs-logs。渲染驱动用带钩子语义的迷你 React 渲染器驱动真实组件（数据态、页签切换、翻页、台账展开、价格导入全流程），驱动覆盖不了的（真实配色、主题跟随）明确标注"需实机确认"。

文件约定：源码一律 UTF-8 + LF。**不要用 PowerShell 管道改写含中文的源文件**——`Get-Content`/`Set-Content` 在本机会按系统代码页（GBK）解码 UTF-8 再以 ANSI 写回，造成不可逆乱码（发生过一次，靠 git 基线 + 重放编辑恢复）。改中文文本用编辑工具或 Node 脚本（显式 `utf8`）。

## 安装与热更（宿主的模块代规则）

- `plugin_manager` 的 `install_bundle` 安装本地目录（link 方式，源码即运行码）
- **替换已安装的包后必须重启 DSH**：宿主按"模块代"加载插件代码，重装+刷新页面拿到的仍可能是旧前端。改完代码：重装 → 重启 → 实机确认
- 冷启动顺序不可假设：可选服务的注册一律走声明式注入（见下）

## 宿主契约踩坑记录

这些是实机排障换来的规则，违反时症状往往"看起来是别的 bug"：

1. **服务用 `ctx.inject(['webServer'|'commands'|'tools'], cb)`，不要用 `ctx.get()`**。冷启动时本插件行可能先于 webServer 服务激活，`ctx.get()` 静默扑空 → 面板 404 且无报错；注入回调等服务就绪才执行，disposer 在服务消失时注销。
2. **工具定义必须带 `output: { schema, render }`，且 `render(args, value)` 返回内容块数组 `[{type:'text', text}]`**。缺 output 注册表直接拒绝；返回字符串会让呈现管线崩溃（`content.some is not a function`）。
3. **SVG 颜色必经 `style` 属性**：presentation 属性（`fill=`/`stroke=`）不做 CSS 变量替换，静默回退黑色。
4. **禁用 `color-mix()`**：该渲染引擎在 SVG paint 上整条拒绝 color-mix 声明并回退黑色。smoke 有源码级门禁，代码里出现 `color-mix(` 即失败。
5. **面板配色走运行时探测**（`buildColors` + `themeTokensReachable`）：令牌可达用 `var(--token, 字面量)`，不可达用同一套字面量兜底；不要退回裸 `var()`（面板容器可能不在令牌作用域，宿主彩色、面板悬空）。
6. **弹窗等悬浮面必须不透明底色**：半透明兜底（5% 灰）会让内容与页面叠字，像渲染错乱。
7. **SQLite 日分桶在 Node 侧做**：`localtime` 修饰符在 Windows 回退 UTC；跨日历日遍历用 `setDate` 防夏令时断轴。
8. **只读消费者（CLI）用 `readOnly` 打开**：跳过 mkdir/PRAGMA/迁移/惰性重建，避免对运行中账本写库。
9. **写入自身的配置走 `ctx.get('configEditor').edit(entry, fn)`**，不要自己改 `cordis.patch.yml`（那是用户的文件，还有别的插件行和注释）。

## 派生数据的收敛哲学

账本（`usage_records`）是唯一事实源；`daily_stats` / `cost_entries` / `context_observations` 都是可全量重建的派生值。所有修正路径（`llm/retry` 合并、元数据修正、参考价导入）都设计为"重放收敛"——重复执行零副作用，历史重导自动愈合（包括跨启动边界产生的重复行）。改写路径时保持这个性质，测试也要覆盖"修正后重放"。

## 仓库布局

```
src/
  collector/    事件归一化（normalizer）、历史导入、对账
  storage/      SQLite 账本（schema、迁移、派生缓存重建）
  query/        QueryService（唯一统计出口）
  domain/       纯逻辑：定价、CSV、首字延迟、OpenRouter 匹配
client/         Web 面板（单文件，无构建）
lib/            tsc 构建输出（运行时加载的是这里）
bin/            CLI 入口
scripts/        验证门禁（对账、冒烟、渲染驱动）
test/           单元测试（node:test）
```
