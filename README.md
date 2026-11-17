# dsh-plugin-codex-app-server

[![npm version](https://img.shields.io/npm/v/dsh-plugin-codex-app-server.svg)](https://www.npmjs.com/package/dsh-plugin-codex-app-server)
[![npm downloads](https://img.shields.io/npm/dm/dsh-plugin-codex-app-server.svg)](https://www.npmjs.com/package/dsh-plugin-codex-app-server)
[![license](https://img.shields.io/npm/l/dsh-plugin-codex-app-server.svg)](https://www.npmjs.com/package/dsh-plugin-codex-app-server)

DeepSeek Harness（DSH）插件：通过本机 **`codex app-server`** 把 Codex 注册为模型提供方 `codex`。每个 DSH 会话拥有一个常驻进程和一个原生 Codex thread，使用标准输入／输出上的双向 JSON-RPC 通信。

Codex 自己负责 agent loop、system prompt、工具执行、AGENTS.md、原生配置与登录态、MCP、skills、子代理和自动压缩。DSH 负责展示文本与思考、镜像工具卡片、权限审批和用户提问。插件在模型选择器左侧提供 **闪电 Fast 开关**，通过 `/codex` 提供 Fast、Plan、名称、Goal、子代理、用量与执行交互入口，并通过 `tavloCodex` 会话投影发布状态。

接口依据：[官方 Codex App Server 文档](https://learn.chatgpt.com/docs/app-server)。

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

`web` 应替换成实际使用的 profile；安装后重启该 DSH profile，让会话启动新的 Codex App Server 进程。

插件启动时会短暂启动本机 App Server 查询 `model/list`，不创建 Codex thread；如果模型目录先来查询且还没有缓存，provider 会等待这次发现完成再返回列表。完成后菜单刷新并缓存模型及推理强度到 DSH home 的 `tavlo-codex/models.json`。查询完成前仍可选择 **Codex / Default**，它使用本机 Codex 配置的模型。若查询失败，检查 DSH 日志和 Codex CLI 登录状态，然后重启 DSH 重试。

## 运行方式

| 方面 | 行为 |
| --- | --- |
| 可执行文件 | 配置的 `executable` 优先，其次查找 PATH 和常见本地安装目录。Windows npm 的 `codex.cmd` 会解析到 `bin/codex.js`，通过 Node 启动，全程不经过 shell。找不到时给出安装提示，不自动下载 CLI。 |
| 原生会话 | `thread/start` 创建，`thread/resume` 恢复；thread id 与 turn id 写入 DSH assistant 消息的 `replayState`。 |
| 分叉 | 继承父会话的 replay state 时，使用 `thread/fork`，并传入保存的 `lastTurnId`。Codex 分叉粒度是原生回合；正在执行的原生回合可能被拒绝分叉。缺少回合边界时明确报错。 |
| 工具 | 顶层命令、文件修改、MCP、网页搜索、图片工具和子代理调用镜像为 `codex_tool`。命令显示终端卡片，文件修改显示 diff 卡片。实际操作始终由 Codex 执行。 |
| 审批 | 命令／文件审批映射为 DSH 审批卡片；允许一次返回 `accept`，拒绝返回 `decline`，取消返回 `cancel`。不写入 Codex 永久规则。额外权限申请最多授予本回合。 |
| 沙箱 | 读取 DSH 的实际沙箱和审批设置，支持只读、工作区可写、完整访问及派生 `custom` 组合。运行中调整权限会取消旧审批、停止当前原生回合，再在同一线程按新权限接续任务；无需手动发送下一条消息。额外工作区写目录保留；`never` 映射为 Codex `never`，其他支持的审批策略使用 `on-request`。DSH Auto 预设暂不支持，会明确报错。 |
| 提问 | `item/tool/requestUserInput` 转为 DSH 问题卡片，按原始问题 id 返回回答。无法展示时返回空回答，不捏造选择。 |
| MCP elicitation | 支持简单平面表单的字符串、枚举、数字、整数和布尔字段。URL 模式展示链接，等待用户手动完成后确认。复杂表单拒绝，密码字段不通过对话日志收集。 |
| 停止 | 图片准备阶段取消不提交消息；原生回合开始后调用 `turn/interrupt`，超过 `cancelGraceMs` 仍未完成则终止进程。插件停止或会话释放时由 DSH 回收子进程。 |
| 输入去重 | 只提交当前 DSH 回合里尚未发送的用户／日程消息。明确的模型／参数拒绝可重试；传输断开后不自动重放可能已执行的消息。 |
| 上下文与用量 | 输入框下方显示累计 token、缓存命中率、最近回合平均速度和上下文占用。`total` 水位差分记录消耗，`last` 保存最近调用快照，容量来自 `modelContextWindow`。读取 `tavloCodex.usage`，不向宿主标准 usage 写入混用两个口径的数据。 |
| Plan 与名称 | Plan / Default 独立于权限；结构化步骤与方案正文分别保存。确认执行先切回 Default，再提交确认。人工会话名称优先，原生自动名称不会覆盖人工修改。 |
| Fast | 点击模型选择器左侧的**闪电开关**，或使用 `/codex fast on` 开启、`off` 关闭、`status` 查询。会话选择覆盖插件 `fastMode` 默认值；均未设置时沿用原生 Codex 配置。选择持久化，在新建、恢复、分叉与后续回合传递，不改动模型、推理强度或权限。 |
| Goal | 仅显式创建，初始暂停；修改状态／预算先读取原生目标，保留已用量。resume 执行一个 DSH 回合，回合边界自动暂停，等待再次确认继续。 |
| 子代理 | Codex 原生派发，插件保存父子关系与状态，提供列表、历史详情、已知活跃回合的追加消息与中断。 |
| 图片与进度 | 图片输入按原生模型能力校验；可访问的图片结果存入 DSH 附件库。命令输出、MCP progress、补丁与 diff 写入持久投影，最终输出替换临时增量。 |

## 原生操作入口

选择 Codex 模型后，模型选择器左侧会显示独立的**闪电开关**，不会覆盖或占用模型按钮。闪电点亮表示 Fast 开启，描边表示关闭；点击即可为当前会话切换，后续回合使用该选择。切换中和任务运行中禁用；原生接口拒绝时显示错误并保留原设置。尚未读取原生默认值时，无障碍状态与提示会说明正在继承默认值，不把未知状态当成已确认关闭。此入口使用 DSH `0.2.2-rc.1` 已发布的输入栏扩展位，无需修改宿主。

输入框下方按 **轮数／步数 → 均速 → token／缓存命中率 → 上下文占用** 排列。Codex 统计读取持久化的原生数据；点击均速、token／缓存或上下文可打开与宿主统计卡片同类的详情面板，查看口径和精确计数，文字被截断时悬停或键盘聚焦仍可查看完整读数。累计 token 与缓存命中率使用已观测消耗，上下文百分比使用最近一次调用的输入与输出除以原生窗口容量；压缩后等待新快照。**“均速”是最近计时回合的输出 token / 原生回合总耗时，包含工具执行与等待，不是纯生成速率。** 回合耗时优先取 `durationMs`，缺失时依次使用原生 `startedAt/completedAt` 和插件观测到的回合墙钟时间；没有 `turnId` 的晚到用量仍会与刚完成的回合配对。旧日志完全缺少计时时显示 `—`，后续完成回合并收到用量及耗时后更新。缺失容量或快照也显示 `—`，不伪装成 0%。

在选择 Codex 模型的 DSH 会话中使用以下命令。切换 Fast、设置模式、手动压缩、执行确认和 Goal 恢复需等待当前 DSH 任务结束。

| 命令 | 行为 |
| --- | --- |
| `/codex` 或 `/codex usage` | 查询消耗、最近上下文样本、容量、Fast、模式和计划步骤。 |
| `/codex fast on`、`/codex fast off` | 开启或关闭当前会话的 Fast；后续回合使用该选择，恢复／分叉后仍保留。 |
| `/codex fast` 或 `/codex fast status` | 查询 Fast 的会话设置与最近观测到的原生档位；可在任务执行中查询，不启动原生线程。 |
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

Fast 通常消耗更多额度，模型服务商仍需支持该档位；原生接口拒绝切换时会显示错误并保留此前选择。图形开关和 `/codex fast on/off` 共用插件命令入口，不会把 `/fast` 当作普通提示词发给模型。

统一 UI 可消费 `tavloCodex` 投影中的 `usage`、`compaction`、`mode`、`speed`、`plan`、`name`、`goal`、`goalControl`、`agents`、`tools`、`diff`、`steering` 和 `diagnostics`。`speed` 保存会话选择（`inherit`／`fast`／`standard`）、原生 `effectiveTier` 和设置错误；`fastModeDefault` 仅在客户端视图中提供插件默认值，不写入会话历史。闪电 Fast 开关与底栏统计已接入，Plan、Goal、子代理等面板仍待接入；具体约束见 [兼容矩阵](docs/compatibility.md)。

## 配置

在 DSH 的 cordis 配置中修改 `tavlo-codex`：

```yaml
- id: tavlo-codex
  name: dsh-plugin-codex-app-server
  config:
    executable: ''
    clientName: codex_dsh
    # fastMode: true  # 默认开启 Fast；省略则跟随原生配置，false 则使用标准速度
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
| `clientName` | `codex_dsh` | Codex App Server 的集成名称，会影响上游 `originator` 与 `User-Agent`。供应商要求特定的集成名称时，使用其认可的值；不能保证供应商自动认可这个默认名称。修改后重启 DSH。 |
| `fastMode` | 未设置 | `true` 默认开启 Fast，`false` 默认使用标准速度；不设置时沿用原生 Codex 配置。会话内 `/codex fast on/off` 的选择优先。修改插件配置后重新加载或重启 DSH。 |
| `inheritCredentials` | `true` | 传入 DSH 的完整环境变量；设为 false 时使用 DSH 过滤后的环境。此设置不会隔离磁盘上的 Codex 登录态。 |
| `env` | `{}` | 追加或覆盖 Codex 环境变量，可设置 `CODEX_HOME` 来选择另一份原生配置和登录态。 |
| `requestTimeoutMs` | `60000` | 单次 JSON-RPC 请求等待应答的上限，不是模型整个回合的执行时限。 |
| `cancelGraceMs` | `10000` | 中断后等待 `turn/completed` 的时长。 |
| `disposeGraceMs` | `3000` | DSH 终止子进程时的信号升级间隔。 |
| `auxiliary` | 上例 | 标题、摘要等辅助模型请求的路由。 |

遇到 `unauthorized client detected` 时，先核对供应商要求的插件客户端名称（见上方 `clientName`），而不是重新登录。

供应商要求额外请求头时，在实际使用的 `CODEX_HOME/config.toml` 的 `[model_providers.<id>]` 中配置 `http_headers` 或 `env_http_headers`。具体名称和值以供应商文档为准；DSH 中其他模型适配器的请求头不会自动注入此插件启动的原生 Codex。

### 辅助请求（标题、摘要）

辅助请求转交给其他普通模型提供方，避免进入用户真实的 Codex thread。先尝试 `auxiliary.routes` 中的 `{ provider, model }`，然后自动发现，记住首个成功路由。自动发现会跳过 `codex` 和 `claude-code`，防止两个原生会话插件互相转发。失败路由 60 秒内跳过；已经输出任何分片后不会换路重放。

例如，要固定标题生成路由，可设置：

```yaml
- id: tavlo-codex
  name: dsh-plugin-codex-app-server
  config:
    auxiliary:
      enabled: true
      routes:
        - provider: deepseek-official
          model: deepseek-flash
      discovery: false
```

## 限制

- 这是服务端接入，保留 Codex 的原生工具和指令。DSH 的 system prompt、工具定义及历史编辑不会重新注入 Codex 原生记录。
- 权限选择的沙箱映射在新原生回合开始时生效；回合中切换权限不会回溯修改正在运行的原生沙箱。已经发出的审批请求会读取当前 DSH 选择。
- DSH Auto 审查预设依赖宿主工具执行链；Codex 原生工具不经过该链，因此暂不支持。请使用明确的沙箱和审批组合。
- DSH 内置 token-meter 共用单次 usage 统计消耗与上下文，不能准确表示原生多次模型调用。Codex 权威统计使用独立投影；未知旧线程恢复／分叉首通知只计最近调用，标记 `inferred`，此前未观测调用可能少计。
- Goal 采用每个 DSH 回合结束自动暂停的有界策略，暂不支持无人干预的连续循环。
- 子代理内部的文本与工具事件不逐条进入主聊天；详情按需读取，不为订阅而恢复子线程。可中断已观测的活跃子代理；并发订阅、父子停止和重启场景尚未支持。审批保留实际请求者身份。
- 图片输出支持可读的本地路径及直接 base64 结果。只有 `fileId` 的输出没有受支持的下载接口，会显示限制；图形界面尚未提供图片预览与实时工具进度。
- 文件卡片展示 Codex 报告的补丁片段，不代表完整文件快照。没有在工具开始事件中提供的内容仍可在原始结果里查看。
- 进程崩溃后可恢复原生线程历史，但不会自动重放状态不明的请求；需要用户发送下一条消息。辅助路由不可用时由 DSH 使用兜底标题。
- 当前没有实现原生登录 UI、插件管理 UI、复杂 MCP 表单及 app-server 动态工具执行。请先在终端配置好 Codex；未支持的客户端请求会收到明确的 JSON-RPC 错误。

## 开发

```bash
pnpm typecheck
pnpm test
pnpm build
pnpm test:local
pnpm test:local:permissions
pnpm pack
```

`test:local:permissions` 使用本机 Codex、独立临时配置和 loopback 模拟模型，验证运行中提升／收紧权限与取消待审批请求，不使用用户凭据或付费模型服务。切换权限会中断当时的命令；已产生的外部效果不会回滚，接续指令要求先核对不确定结果。停止超时或新权限被拒绝时，插件结束原生进程并报告错误。已有 DSH 进程需重新加载本插件才能使用更新后的 Host 代码。

设计说明见 [docs/design.md](docs/design.md)，权限行为与验证见 [docs/permissions-verification.md](docs/permissions-verification.md)。

变更记录见 [CHANGELOG.md](CHANGELOG.md)。
