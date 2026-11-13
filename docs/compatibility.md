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
| 计划内容 | `turn/plan/updated` 步骤与 `plan` item 正文不同 | 分别保存，最终 item 文本覆盖临时文本 |
| 名称 | `thread/name/set`、`thread/name/updated` | 人工命名优先，重命名错误独立于模型回合 |
| Goal | 实验 `thread/goal/get,set,clear`，线程级状态和预算，修改需 origin | 仅显式 set 创建，初始 paused；修改状态／预算不传 objective；resume 只执行一个受管 DSH 回合，边界自动暂停；不能把 turn/completed 当目标完成 |
| 子代理 | `collabAgentToolCall`、`subAgentActivity`、`thread/read`、`thread/turns/list` | Codex 派发；保存稳定身份和父子状态；按需读详情，不为订阅强行 resume 子线程；控制仅针对已知活跃回合 |
| 图片输入 | `model/list.inputModalities`；data URL input | 等待原生能力再提交；未知模型保守 text；旧模型缓存失效 |
| 图片输出 | imageGeneration 的 savedPath／直接结果，imageView 的绝对路径，部分结果仅有 fileId | 可读本地文件或直接 base64 导入宿主附件；等待存储完成再结束工具；fileId-only 明确无法下载 |
| 工具进度 | command outputDelta、MCP progress、patchUpdated、turn/diff | 有界尾部和消息数、100ms 合并写入，最终聚合输出替换增量；命令与投影可查，原有终端卡尚未接投影更新 |
| 执行中追加 | `turn/steer.expectedTurnId`、`clientUserMessageId` | 显式命令立即追加，普通输入排队；成功直接记用户消息，不再入队；明确拒绝可重试，传输不明不重放 |
| 权限 | DSH 预设与派生 custom、sandboxPolicy 实际配置、approval override | 支持只读／工作区可写／完整访问、额外可写目录及 never；Auto 依赖宿主工具审查，原生工具无法覆盖，明确拒绝 |
| 诊断 | 全局 warning/configWarning、MCP 启动、account/read、额度、Windows readiness、失败回合 | 保存有界诊断；自定义 provider 未要求 OpenAI 认证时不误报未登录；不持久账户邮箱或完整配置 |
| 界面入口 | DSH commands 注册 slash command；sessionProjections 发布任意 JSON 视图 | 先通过 `/codex` 提供可验证入口，`tavloCodex` 投影供统一 UI 消费；本工作区缺统一 UI 源码，图形面板另行验收 |

插件记录使用 DSH `appendPluginRecord` / `pluginRecordOf`，声明为可忽略的非模型表面事件，整份状态写入日志。投影恢复验证历史数据，避免未知字段或损坏记录影响模型会话。不会修改 DSH 内置 `tokenUsage` / `contextPressure` 投影。

## 已验证与待验收

| 验证层 | 结果与范围 |
| --- | --- |
| 自动测试 | 真实 DSH 插件日志与投影、工具 schema/render、可控 App Server、原生控制和故障恢复；详细数字见进度记录 |
| 本机协议 | Windows、codex-cli 0.167.2：初始化、9 模型、线程、Plan、名称、暂停 Goal、预算保留用量与清除；独立临时 CODEX_HOME，0 模型回合 |
| 真实 DSH | DSH 0.2.2-rc.1，独立 DSH_HOME，已登录本机 Codex，只读 + never：收到 CODEX_DSH_OK，正常完成；日志保存统计、上下文容量、原生边界和诊断，子进程退出 |
| 待验收 | 完整图形交互、真实图片／工具／审批／恢复／分叉／Plan；Goal 跨回合与重启、子代理并发订阅与停止；真实进程故障与重启；旧 CLI 版本 |

真实文字回合耗时约 6 分钟。已观测配置警告和一个 MCP 启动失败被正常记录，未阻断最终回复；尚无足够证据判断等待主要原因。`requestTimeoutMs` 只限制单次 RPC 应答，不能作为整个模型回合的超时设置。

接口依据：<https://learn.chatgpt.com/docs/app-server>。当前版本仅对上述组合保留证据，不宣称旧 CLI 或统一 UI 图形面板已兼容。
