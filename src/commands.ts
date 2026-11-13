/** UI-independent command entry; DSH renders the result in its command card. */
import { CommandDefinitionId } from '@deepseek-ai/dsh-commands'
import type { CommandDefinition } from '@deepseek-ai/dsh-commands'
import { createUserMessage } from '@deepseek-ai/dsh-llm'
import type { Agent } from '@deepseek-ai/dsh-agent'
import type { CodexSession, StepRequest } from './codex-session.ts'
import type { NativeState } from './native-state.ts'
import { PROVIDER } from './constants.ts'

export interface CommandDeps {
  state(agent: Agent): NativeState
  resolve(agent: Agent): CodexSession
  rename(agent: Agent, title: string): string
}
export const COMMAND_USAGE = '/codex [usage|diagnostics|compact|plan|default|execute|keep|name <title>|goal [get|set <objective>|resume|pause|clear|budget <tokens|none>]|agents|agent <id>|agent-interrupt <id>|agent-message <id> <text>|progress [itemId]|steer <text>]'
export function codexCommand(deps: CommandDeps): CommandDefinition {
  return {
    definitionId: CommandDefinitionId('tavlo-plugins-codex/codex'), name: 'codex',
    description: 'Codex native usage, context, Plan mode and name',
    input: { hint: COMMAND_USAGE },
    handler: async ({ agent, rawInput, signal }) => {
      const input = rawInput.trim(), [action = 'usage'] = input.split(/\s+/, 1)
      const argument = input.slice(action.length).trim()
      const state = deps.state(agent)
      if (action === 'usage') {
        if (argument) return { kind: 'error', text: COMMAND_USAGE }
        const u = state.usage, last = u.last
        return { kind: 'success', text: [
          `Codex consumed ${u.consumed.totalTokens} tokens (${u.turnConsumed.totalTokens} this native turn).`,
          last ? `Latest input: ${last.inputTokens + last.cacheReadTokens + last.cacheWriteTokens}; output: ${last.outputTokens}; cache read/write: ${last.cacheReadTokens}/${last.cacheWriteTokens}.` : 'Native context sample: awaiting refresh.',
          `Context capacity: ${u.contextWindow ?? 'unknown'}; baseline: ${u.baseline ?? 'unknown'}; compaction: ${state.compaction.status}.`,
          `Mode: ${state.mode.selected}; capability: ${state.mode.capability}.`,
          ...state.plan.text ? [`Plan (${state.plan.final ? 'final' : 'draft'}):\n${state.plan.text}`] : [],
          ...state.plan.steps.map(step => `[${step.status}] ${step.step}`),
        ].join('\n') }
      }
      if (action === 'diagnostics' && !argument) return { kind: 'success', text: state.diagnostics.map(d => `${d.severity}: ${d.message}${d.details ? `\n${d.details}` : ''}`).join('\n\n') || 'No current Codex diagnostics.' }
      if (action === 'keep') return { kind: 'success', text: '保留当前模式与计划，未提交执行请求。' }
      if (action === 'progress') {
        const tools = Object.values(state.tools).filter(tool => !argument || tool.itemId === argument || `${tool.threadId}:${tool.itemId}` === argument)
        return { kind: 'success', text: tools.map(t => `${t.threadId}:${t.itemId} ${t.status}${t.truncated ? ' (earlier output truncated)' : ''}\n${t.output}\n${t.messages.join('\n')}\n${t.patch ?? ''}`).join('\n\n') || '尚未观测到工具进度。' }
      }
      if (action === 'agents' && !argument) return { kind: 'success', text: Object.values(state.agents).map(a => `${a.threadId} ← ${a.parentThreadId}: ${a.status}${a.interruptRequested ? ' (interrupt requested)' : ''}\n${a.model ?? 'unknown model'} / ${a.reasoningEffort ?? 'default effort'}\n${a.task ?? ''}\n${a.message ?? ''}`).join('\n\n') || '尚未观测到原生子代理。' }
      const selection = agent.model.current()
      if (selection?.provider !== PROVIDER) return { kind: 'error', text: '请先选择 Codex 模型。' }
      const request: StepRequest = { messages: [], model: selection.model, reasoningEffort: selection.reasoningEffort, signal, currentTurnMessageIds: new Set() }
      const activeGoalControl = action === 'goal' && ['', 'get', 'pause', 'clear'].includes(argument)
      if (!['name', 'agent', 'agent-interrupt', 'agent-message', 'steer'].includes(action) && !activeGoalControl && agent.status !== 'idle') return { kind: 'error', text: '请先等待当前 DSH 任务结束。' }
      try {
        if (action === 'steer' && argument) {
          if (agent.status === 'idle') return { kind: 'error', text: '当前没有活跃回合，请使用普通输入开始下一轮。' }
          const message = createUserMessage({ content: [{ type: 'text', text: argument }], source: { kind: 'user' } })
          await deps.resolve(agent).steer(message.id, argument, signal)
          // It has already reached Codex; journal it directly rather than scheduling it twice.
          agent.session.append('user/message', message, { surfaceOp: 'append' })
          return { kind: 'success', text: '已通过 turn/steer 追加到当前原生回合；未排队新回合。' }
        }
        if (['agent', 'agent-interrupt', 'agent-message'].includes(action)) {
          const [id = ''] = argument.split(/\s+/, 1), message = argument.slice(id.length).trim()
          if (!id || (action === 'agent-message' ? !message : !!message)) return { kind: 'error', text: COMMAND_USAGE }
          const session = deps.resolve(agent)
          if (action === 'agent') return { kind: 'success', text: await session.agentDetail(id, request) || '没有可读取的子代理回合。' }
          await session.agentInput(id, action === 'agent-message' ? message : undefined, request)
          return { kind: 'success', text: action === 'agent-message' ? '消息已通过 turn/steer 提交到子代理当前回合。' : '已请求中断此子代理的活跃回合。' }
        }
        if (action === 'goal') {
          const [operation = 'get'] = argument.split(/\s+/, 1), value = argument.slice(operation.length).trim()
          const op = operation || 'get'
          if (!['get', 'set', 'resume', 'pause', 'clear', 'budget'].includes(op) || (op === 'set' && !value) || (!['set', 'budget'].includes(op) && value)) return { kind: 'error', text: COMMAND_USAGE }
          const session = deps.resolve(agent)
          if (op === 'set') await session.goal('set', request, value)
          else if (op === 'budget') await session.goal('budget', request, value === 'none' ? null : Number(value))
          else await session.goal(op as 'get' | 'resume' | 'pause' | 'clear', request)
          if (op === 'pause' || op === 'clear') agent.cancel({ kind: 'user' })
          if (op === 'resume') {
            signal.throwIfAborted()
            agent.followup(createUserMessage({ content: [{ type: 'text', text: '请继续执行已启用的原生目标，本轮结束后暂停等待我确认继续。' }], source: { kind: 'user' } }))
          }
          const goal = session.state.goal
          return { kind: 'success', text: goal ? `Goal: ${goal.status}; ${goal.tokensUsed}/${goal.tokenBudget ?? 'unlimited'} tokens; ${goal.timeUsedSeconds}s.\n${goal.objective}\nDSH 回合边界自动暂停；/codex goal resume 显式继续。` : '原生目标已清除。' }
        }
        if (action === 'compact' && !argument) {
          await deps.resolve(agent).compact(request)
          return { kind: 'success', text: 'Codex 已接受压缩请求；使用 /codex usage 查询完成状态。' }
        }
        if ((action === 'plan' || action === 'default') && !argument) {
          await deps.resolve(agent).setMode(action, request)
          return { kind: 'success', text: `Codex 模式已切换到 ${action}；下一条消息使用该模式。` }
        }
        if (action === 'execute' && !argument) {
          if (state.mode.selected !== 'plan' || !state.plan.final) return { kind: 'error', text: '没有等待确认执行的最终 Plan。' }
          await deps.resolve(agent).setMode('default', request)
          signal.throwIfAborted()
          agent.followup(createUserMessage({ content: [{ type: 'text', text: '我确认此计划，请开始实现已确认的计划，并逐项验证。' }], source: { kind: 'user' } }))
          return { kind: 'success', text: '已切回 Default 并提交执行确认。' }
        }
        if (action === 'name' && argument) {
          const title = deps.rename(agent, argument)
          await deps.resolve(agent).setName(title, true, request)
          return { kind: 'success', text: `会话名称已同步：${title}` }
        }
        return { kind: 'error', text: COMMAND_USAGE }
      } catch (error) { return { kind: 'error', text: String(error) } }
    },
  }
}
