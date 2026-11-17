# Codex / DSH 接口核对

核对日期：2026-11-13。依据：本机 `codex-cli 0.167.2` 生成的稳定／实验 TypeScript 协议、官方 App Server 文档、安装的 DSH `0.2.2-rc.1` 与对应宿主源代码。

| 能力 | 接口与约束 | 插件策略 |
| --- | --- | --- |
| 菜单模型目录 | 分页 `model/list` 可在 `initialize` 响应后、`initialized` 通知前调用 | 插件启动时使用一次性连接发现并缓存，不创建 thread、不启动完整运行时；DSH 无缓存目录请求会等待发现完成，完成后发 `llm/models-updated` |
| 用量 | `thread/tokenUsage/updated` 的 `total` 为线程累计量，`last` 为最近请求；缓存包含在 input 中，reasoning 包含在 output 中 | 消耗使用累计量差分；上下文使用最近请求，分别保存 |
| 宿主统计 | StreamAssembler 在同一步中覆盖 usage；token-meter 对同一步替换、跨步骤累加，并将同一 usage 用作上下文锚点 | 原生循环无法用一个标准 usage 同时表达两个口径；新增 `tavloCodex` 投影和可重放插件记录作为权威统计，不将累计消耗传入标准 usage。旧界面原有 token-meter 不代表 Codex 原生统计 |
| 恢复统计 | resume/fork 响应没有累计用量；通知包含 turnId | 已知线程基线沿用；未知恢复基线第一次从 total 减 last 推导，标记估算边界；恢复通知可在响应前到达，需要暂存 |
| 上下文压缩 | `contextCompaction` item；`thread/compact/start`；容量来自用量通知 | Codex 唯一负责压缩；手动入口仅在空闲时使用，状态持久化；等待新快照时不沿用压缩前占用 |
| Plan | 实验 `collaborationMode`，`initialize.capabilities.experimentalApi`；与 sandbox 无关 | 显式选择模式，保留模型与推理强度；接口拒绝时不能静默降级执行 |
| Fast | `thread/start,resume,fork`、`turn/start` 与 `thread/settings/update` 的 `serviceTier`；`null` 清除档位，省略继承；0.169.0 将 `fast` 规范化为 `priority`；`thread/settings/updated` 提供实际档位 | `/codex fast on/off/status` 与可选 `fastMode` 默认值；兼容 `fast`／`priority`，会话选择持久化，保留原生默认设置；切换独立于模型、推理与权限，接口错误不伪装成功 |
| 计划内容 | `turn/plan/updated` 步骤与 `plan` item 正文不同 | 分别保存，最终 item 文本覆盖临时文本 |
| 名称 | `thread/name/set`、`thread/name/updated` | 人工命名优先，重命名错误独立于模型回合 |
| Goal | 实验 `thread/goal/get,set,clear`，线程级状态和预算，修改需 origin | 仅显式 set 创建，初始 paused；修改状态／预算不传 objective；resume 只执行一个受管 DSH 回合，边界自动暂停；不能把 turn/completed 当目标完成 |
| DSH 目标桥接 | `ctx.goals`、`goal/changed`、`goal/activation-changed`、`source.kind=goal` 与宿主 `goal` 投影 | 复用既有入口和目标栏；只转发当前版本的已准入回合，由宿主续轮。原生终态按版本回传，边界技术性暂停不暂停宿主；轮数不转换为 token 预算；Goal 服务是可选 peer，未加载时普通对话照常 |
| 子代理 | 原生事件、`thread/list.ancestorThreadId`、`thread/read`、`thread/turns/list` | Codex 派发；活动期间每秒只读发现／核对后代，处理嵌套、迟到事件和恢复；父边界等待实际停止终态，超时结束进程；不恢复子线程取得订阅 |
| 图片输入 | `model/list.inputModalities`；data URL input | 等待原生能力再提交；未知模型保守 text；旧模型缓存失效 |
| 图片输出 | imageGeneration 的 savedPath／直接结果，imageView 的绝对路径，部分结果仅有 fileId | 可读本地文件或直接 base64 导入宿主附件；等待存储完成再结束工具；fileId-only 明确无法下载 |
| 工具进度 | command outputDelta、MCP progress、patchUpdated、turn/diff | 有界尾部和消息数、100ms 合并写入，最终输出替换增量；投影与 `/codex progress` 查询，原有终端结果卡保留 |
| 执行中追加 | `turn/steer.expectedTurnId`、`clientUserMessageId` | 显式命令立即追加，普通输入排队；成功直接记用户消息，不再入队；明确拒绝可重试，传输不明不重放 |
| 权限 | DSH 预设与派生 custom、sandboxPolicy 实际配置、approval override；`thread/settings/update` 仅影响后续回合，0.169.0 的 `turn/settings/update` 不接受 sandboxPolicy／approvalPolicy | 支持只读／工作区可写／完整访问、额外可写目录及 never；运行中变更取消旧审批并中断原生回合，然后按最新权限在同一线程接续，不重发原始输入；空闲只更新设置。停止／设置失败则终止进程。Auto 仍明确拒绝 |
| 诊断 | 全局 warning/configWarning、MCP 启动、account/read、额度、Windows readiness、失败回合 | 保存有界诊断；自定义 provider 未要求 OpenAI 认证时不误报未登录；不持久账户邮箱或完整配置 |
| 界面入口 | DSH `0.2.2-rc.1` 的 `conversation.input.right`／`conversation.composer.dock`、共享 Toast、`remote.commands.execute` 与会话投影 | 保留 Fast 与统计，目标复用 DSH 既有目标栏；四项独立工作面板按用户反馈撤下，其余操作沿用 `/codex` 命令 |
| 底栏统计 | `tavloCodex.usage`；`turn/completed.turn.durationMs`、`startedAt`、`completedAt` | 消耗与缓存取累计增量，上下文取最近调用快照。均速使用同一回合的已观测输出 / 原生总耗时，含工具和等待，不表示纯生成速率。耗时按 `durationMs` → 起止时间 → 插件观测墙钟依次回退；完成后无 `turnId` 的晚到用量仍可配对，缺失计时的旧记录显示待更新 |

插件记录使用 DSH `appendPluginRecord` / `pluginRecordOf`，声明为可忽略的非模型表面事件，整份状态写入日志。投影恢复验证历史数据，避免未知字段或损坏记录影响模型会话。不会修改 DSH 内置 `tokenUsage` / `contextPressure` 投影。

## 已验证与待验收

| 验证层 | 结果与范围 |
| --- | --- |
| 自动测试 | 真实 DSH 插件日志与投影、工具 schema/render、可控 App Server、原生控制和故障恢复；详细数字见进度记录 |
| 本机协议 | Windows、codex-cli 0.169.0：初始化、9 模型、线程、Fast 切换及权限保持、Plan、名称、暂停 Goal、预算保留用量与清除；独立临时 CODEX_HOME，0 模型回合 |
| 运行中权限 | 本机 Codex 0.169.0 + loopback 模拟 Responses 服务，5 个真实原生回合验证只读→完整访问→只读、已出现审批的取消及续接；原生 turn_context 权限逐项一致，同一线程、原始输入各提交一次，0 付费模型调用。全量 164 项测试与类型检查通过；用户于 2026-11-17 确认实机验证成功 |
| Goal／子代理生命周期 | Codex 0.169.0 + loopback：两轮 Goal 累计 130→260 token，预算与用量跨重启保留；主动断开 active 目标后恢复先暂停；两个真实子代理在父边界确认停止，重启不复活，0 子线程 resume |
| DSH 目标桥接 | 真实 DSH 0.2.2-rc.1 + Codex 0.169.0 + loopback：宿主自动两轮、目标栏投影完成、暂停／清除、原生受阻及模型失败；6 次本地模型请求、0 付费调用。自动测试覆盖版本竞态和限制保留；未含目标栏浏览器点击 |
| 工作面板（历史） | 曾通过实际 DSH Host 的隔离浏览器验收；随后用户明确不需要四项独立面板，现已撤下，对应截图不代表当前界面 |
| Fast 客户端 | 18 文件 135 项测试、类型检查与构建通过；隔离浏览器加载客户端产物，验证默认／开启／禁用、等待服务端更新、失败提示和 360px 布局不溢出。预览使用宿主控件源码与模拟命令服务；用户于 2026-11-17 另行明确确认 Fast 开关实机验证通过 |
| 底栏统计客户端 | 全量 19 文件 152 项测试通过；覆盖三项详情卡片、耗时回退、turn id 晚确认、晚到无 `turnId` 用量和零输出不发布速度；隔离浏览器验证浅色／深色主题控件和 360px 布局。用户于 2026-11-17 另行明确确认统计底栏实机验证通过 |
| 真实 DSH | DSH 0.2.2-rc.1，独立 DSH_HOME，已登录本机 Codex，只读 + never：收到 CODEX_DSH_OK，正常完成；日志保存统计、上下文容量、原生边界和诊断，子进程退出 |
| 待验收 | 既有目标栏浏览器操作、宿主目标重启／分叉及其余真实图片／工具／审批的完整组合；更广泛进程故障、模型切换失败与旧 CLI 版本 |

真实文字回合耗时约 6 分钟。已观测配置警告和一个 MCP 启动失败被正常记录，未阻断最终回复；尚无足够证据判断等待主要原因。`requestTimeoutMs` 只限制单次 RPC 应答，不能作为整个模型回合的超时设置。

接口依据：<https://learn.chatgpt.com/docs/app-server>。当前工作区的生命周期证据与界面调整见 [验证记录](workspace-verification.md)；不宣称旧 CLI 或未测场景兼容。
