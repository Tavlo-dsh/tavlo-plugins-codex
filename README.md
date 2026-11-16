# dsh-plugin-codex-app-server

DeepSeek Harness（DSH）插件：通过本机 **`codex app-server`** 把 Codex 注册为模型提供方 `codex`。每个 DSH 会话拥有一个常驻进程和一个原生 Codex thread，使用标准输入／输出上的双向 JSON-RPC 通信。

Codex 自己负责 agent loop、system prompt、工具执行、AGENTS.md、原生配置与登录态、MCP、skills、子代理和自动压缩。DSH 负责展示文本与思考、镜像工具卡片、权限审批和用户提问。插件通过 `/codex` 提供 Plan、名称、Goal、子代理、用量与执行交互入口，并通过 `tavloCodex` 会话投影发布状态，供统一 UI 接入。

接口依据：[官方 Codex App Server 文档](https://learn.chatgpt.com/docs/app-server)。已在 Windows、DSH `0.2.2-rc.1`、本机 `codex-cli 0.167.2` 上通过真实已登录文字回合，返回 `CODEX_DSH_OK` 并正常结束；Plan、命名和暂停 Goal 的原生协议检查也已通过。完整图形交互及旧版 CLI 兼容性待验收。

后续能力接入见 [开发计划](docs/implementation-plan.md)；当前阶段、已知缺口、验证结果和继续开发入口见 [进度记录](docs/progress.md)。

## 安装

需要 Node.js 22+、DSH `>=0.2.2-rc.1 <0.3.0`，以及已安装、已配置认证的本机 Codex。

```bash
npm install -g @openai/codex
codex login
```

已有可用的 Codex 配置或登录态时，可直接使用。使用 npm 包安装：

```bash
dsh plugin --profile web add dsh-plugin-codex-app-server
```

从源码安装：

```bash
cd /path/to/tavlo-plugins-codex
pnpm install
pnpm build
dsh plugin --profile web add "$(pwd)"
```

插件启动时会短暂启动本机 App Server 查询 `model/list`，不创建 Codex thread；如果模型目录先来查询且还没有缓存，provider 会等待这次发现完成再返回列表。完成后菜单刷新并缓存模型及推理强度到 DSH home 的 `tavlo-codex/models.json`。查询完成前仍可选择 **Codex / Default**，它使用本机 Codex 配置的模型。若查询失败，检查 DSH 日志和 Codex CLI 登录状态，然后重启 DSH 重试。

## 运行行为

| 方面 | 行为 |
| --- | --- |
| 可执行文件 | 配置的 `executable` 优先，其次查找 PATH 和常见本地安装目录。Windows npm 的 `codex.cmd` 会解析到 `bin/codex.js`，通过 Node 启动，全程不经过 shell。找不到时给出安装提示，不自动下载 CLI。 |
| 原生会话 | `thread/start` 创建，`thread/resume` 恢复；thread id 与 turn id 写入 DSH assistant 消息的 `replayState`。 |
| 分叉 | 继承父会话的 replay state 时，使用 `thread/fork`，并传入保存的 `lastTurnId`。Codex 分叉粒度是原生回合；正在执行的原生回合可能被拒绝分叉。缺少回合边界时明确报错。 |
| 工具 | 顶层命令、文件修改、MCP、网页搜索、图片工具和子代理调用镜像为 `codex_tool`。命令显示终端卡片，文件修改显示 diff 卡片。实际操作始终由 Codex 执行。 |
| 审批 | 命令／文件审批映射为 DSH 审批卡片；允许一次返回 `accept`，拒绝返回 `decline`，取消返回 `cancel`。不写入 Codex 永久规则。额外权限申请最多授予本回合。 |
| 沙箱 | 每个新原生回合读取 DSH 的实际沙箱和审批设置，支持只读、工作区可写、完整访问及派生 `custom` 组合。额外工作区写目录保留；`never` 映射为 Codex `never`，其他支持的审批策略使用 `on-request`。DSH Auto 预设暂不支持，会明确报错。 |
| 提问 | `item/tool/requestUserInput` 转为 DSH 问题卡片，按原始问题 id 返回回答。无法展示时返回空回答，不捏造选择。 |
| MCP elicitation | 支持简单平面表单的字符串、枚举、数字、整数和布尔字段。URL 模式展示链接，等待用户手动完成后确认。复杂表单拒绝，密码字段不通过对话日志收集。 |
| 停止 | 图片准备阶段取消不提交消息；原生回合开始后调用 `turn/interrupt`，超过 `cancelGraceMs` 仍未完成则终止进程。插件停止或会话释放时由 DSH 回收子进程。 |
| 输入去重 | 只提交当前 DSH 回合里尚未发送的用户／日程消息。明确的模型／参数拒绝可重试；传输断开后不自动重放可能已执行的消息。 |
| 上下文与用量 | `total` 水位差分记录消耗，`last` 保存最近调用快照，容量来自 `modelContextWindow`。权威数据在 `tavloCodex.usage` 和 `/codex usage`；不向宿主标准 usage 写入混用两个口径的数据。 |
| Plan 与名称 | Plan / Default 独立于权限；结构化步骤与方案正文分别保存。确认执行先切回 Default，再提交确认。人工会话名称优先，原生自动名称不会覆盖人工修改。 |
| Goal | 仅显式创建，初始暂停；修改状态／预算先读取原生目标，保留已用量。resume 执行一个 DSH 回合，回合边界自动暂停，等待再次确认继续。 |
| 子代理 | Codex 原生派发，插件保存父子关系与状态，提供列表、历史详情、已知活跃回合的追加消息与中断。 |
| 图片与进度 | 图片输入按原生模型能力校验；可访问的图片结果存入 DSH 附件库。命令输出、MCP progress、补丁与 diff 写入持久投影，最终输出替换临时增量。 |

## 原生操作入口

在选择 Codex 模型的 DSH 会话中使用以下命令。设置模式、手动压缩、执行确认和 Goal 恢复需等待当前 DSH 任务结束。

| 命令 | 行为 |
| --- | --- |
| `/codex` 或 `/codex usage` | 查询消耗、最近上下文样本、容量、模式和计划步骤。 |
| `/codex plan`、`/codex default` | 设置后续消息使用的原生模式；接口不支持时明确报错。 |
| `/codex execute`、`/codex keep` | 确认执行最终 Plan，或保留当前计划和模式。 |
| `/codex name <名称>` | 人工命名并同步到原生 thread。 |
| `/codex compact` | 请求原生压缩；完成状态用 usage 查询。 |
| `/codex goal set <目标>`、`/codex goal get` | 创建暂停的原生目标，或读取当前状态。 |
| `/codex goal resume`、`pause`、`clear` | 显式继续一轮、暂停并停止当前 DSH 回合，或清除目标。 |
| `/codex goal budget <正整数或 none>` | 更新 token 预算，不重置已用量，也不自动恢复运行。 |
| `/codex agents`、`/codex agent <threadId>` | 列出已观测代理，或读取其最近三轮历史。 |
| `/codex agent-message <threadId> <消息>`、`/codex agent-interrupt <threadId>` | 对已知子代理的活跃回合追加消息或请求中断。 |
| `/codex progress [itemId]` | 查看已观测工具输出、MCP 消息与补丁；保留有界尾部并标注截断。 |
| `/codex steer <消息>` | 立即追加到当前原生回合；普通输入仍排队到下一轮。成功后记录用户消息，不再重复提交。 |
| `/codex diagnostics` | 查看认证、配置、MCP、额度、Windows 沙箱和原生回合错误。 |

统一 UI 可消费 `tavloCodex` 投影中的 `usage`、`compaction`、`mode`、`plan`、`name`、`goal`、`goalControl`、`agents`、`tools`、`diff`、`steering` 和 `diagnostics`。本项目提供后端与命令入口，图形面板尚未接入；具体约束见 [兼容矩阵](docs/compatibility.md)。

## 配置

在 DSH 的 cordis 配置中修改 `tavlo-codex`：

```yaml
- id: tavlo-codex
  name: dsh-plugin-codex-app-server
  config:
    executable: ''
    inheritCredentials: true
    env: {}
    requestTimeoutMs: 60000
    cancelGraceMs: 10000
    disposeGraceMs: 3000
    auxiliary:
      enabled: true
      routes: []
      discovery: true
```

| 字段 | 默认值 | 说明 |
| --- | --- | --- |
| `executable` | `''` | Codex 可执行文件或 JS 入口的路径；为空则自动查找。显式路径不存在或无法解析时直接报错。 |
| `inheritCredentials` | `true` | 传入 DSH 的完整环境变量；设为 false 时使用 DSH 过滤后的环境。此设置不会隔离磁盘上的 Codex 登录态。 |
| `env` | `{}` | 追加或覆盖 Codex 环境变量，可设置 `CODEX_HOME` 来选择另一份原生配置和登录态。 |
| `requestTimeoutMs` | `60000` | 单次 JSON-RPC 请求等待应答的上限，不是模型整个回合的执行时限。 |
| `cancelGraceMs` | `10000` | 中断后等待 `turn/completed` 的时长。 |
| `disposeGraceMs` | `3000` | DSH 终止子进程时的信号升级间隔。 |
| `auxiliary` | 上例 | 标题、摘要等辅助模型请求的路由。 |

辅助请求转交给其他普通模型提供方，避免进入用户真实的 Codex thread。先尝试 `auxiliary.routes` 中的 `{ provider, model }`，然后自动发现，记住首个成功路由。自动发现会跳过 `codex` 和 `claude-code`，防止两个原生会话插件互相转发。失败路由 60 秒内跳过；已经输出任何分片后不会换路重放。

例如，要固定标题生成路由，可设置：

```yaml
auxiliary:
  enabled: true
  routes:
    - provider: deepseek-official
      model: deepseek-flash
  discovery: false
```

## 当前限制

- 这是服务端接入，保留 Codex 的原生工具和指令。DSH 的 system prompt、工具定义及历史编辑不会重新注入 Codex 原生记录。
- 权限选择的沙箱映射在新原生回合开始时生效；回合中切换权限不会回溯修改正在运行的原生沙箱。已经发出的审批请求会读取当前 DSH 选择。
- DSH Auto 审查预设依赖宿主工具执行链；Codex 原生工具不经过该链，因此暂不支持。请使用明确的沙箱和审批组合。
- DSH 内置 token-meter 共用单次 usage 统计消耗与上下文，不能准确表示原生多次模型调用。Codex 权威统计使用独立投影；未知旧线程恢复／分叉首通知只计最近调用，标记 `inferred`，此前未观测调用可能少计。
- Goal 当前采用每个 DSH 回合结束自动暂停的有界策略，尚未开放无人干预的原生连续循环。真实跨回合／重启验收待完成。
- 子代理内部的文本与工具事件不逐条进入主聊天；详情按需读取，不为订阅而恢复子线程。父边界请求中断已观测的活跃子代理，真实并发订阅／父子停止／重启仍待验收；审批保留实际请求者身份。
- 图片输出支持可读的本地路径及直接 base64 结果。只有 `fileId` 的输出没有受支持的下载接口，会显示限制；图片预览与实时工具进度还需图形界面验收。
- 文件卡片展示 Codex 报告的补丁片段，不代表完整文件快照。没有在工具开始事件中提供的内容仍可在原始结果里查看。
- 进程崩溃后可恢复原生线程历史，但不会自动重放状态不明的请求；需要用户发送下一条消息。辅助路由不可用时由 DSH 使用兜底标题。
- 当前没有实现原生登录 UI、插件管理 UI、复杂 MCP 表单及 app-server 动态工具执行。请先在终端配置好 Codex；未支持的客户端请求会收到明确的 JSON-RPC 错误。

## 开发与验证

```bash
pnpm typecheck
pnpm test
pnpm build
pnpm test:local
pnpm pack
```

`test:local` 使用临时的独立 `CODEX_HOME` 验证真实 CLI 的初始化、模型列表、线程、Plan 设置、名称、暂停 Goal、预算修改和清除；不发送模型回合，不使用现有登录态。单元与集成测试使用可控的 App Server 消息验证会话、统计、审批、恢复／分叉、取消、进程失败、图片、原生控制和 DSH 辅助路由。

真实已登录文字验收使用独立 `DSH_HOME` 和工作目录，未修改用户默认 DSH profile。它验证装载、权限映射、回复、日志中的原生状态与进程退出；其他真实交互仍在 [开发计划](docs/implementation-plan.md) 中保留待验收状态。

设计细节见 [docs/design.md](docs/design.md)。
