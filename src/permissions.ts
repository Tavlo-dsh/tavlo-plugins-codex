import type { Session } from '@deepseek-ai/dsh-session'
import type { ApprovalOutcome } from '@deepseek-ai/dsh-user-approval'
import type { RpcRequest } from './protocol.ts'
import { record, text } from './protocol.ts'

export interface PermissionPresets {
  current(session: Session): string
  resolve(name: string): { sandbox: string; approval: string }
}
export interface EffectivePermissions { sandbox: string; approval: string; writableRoots?: readonly string[] }
export function hasFullAccess(presets: PermissionPresets | undefined, session: Session, effective?: EffectivePermissions): boolean {
  const name = presets?.current(session)
  if (name === 'auto' || name === 'custom' && effective === undefined) return false
  const spec: EffectivePermissions | undefined = effective ?? (name === undefined ? undefined : presets?.resolve(name))
  return spec?.sandbox === 'danger-full-access' && spec.approval === 'never'
}

/** Apply the host's sandbox on every new native turn; leave native defaults when absent. */
export function nativePolicy(presets: PermissionPresets | undefined, session: Session, cwd: string, effective?: EffectivePermissions): Record<string, unknown> {
  const name = presets?.current(session)
  if (name === 'auto') throw new Error('Codex 原生工具无法使用 DSH Auto 审查预设；请选择明确的沙箱和审批设置。')
  if (name === 'custom' && effective === undefined) throw new Error('无法读取 DSH 自定义权限的实际沙箱／审批设置。')
  const spec: EffectivePermissions | undefined = effective ?? (name === undefined ? undefined : presets?.resolve(name))
  if (spec === undefined) return {}
  let sandboxPolicy: Record<string, unknown>
  switch (spec.sandbox) {
    case 'danger-full-access': sandboxPolicy = { type: 'dangerFullAccess' }; break
    case 'workspace-write':
      sandboxPolicy = { type: 'workspaceWrite', writableRoots: [...new Set([cwd, ...(spec.writableRoots ?? [])])], networkAccess: false, excludeTmpdirEnvVar: false, excludeSlashTmp: false }
      break
    case 'read-only': sandboxPolicy = { type: 'readOnly', networkAccess: false }; break
    default: throw new Error(`无法把 DSH 沙箱模式映射到 Codex：${spec.sandbox}`)
  }
  return { sandboxPolicy, approvalPolicy: spec.approval === 'never' ? 'never' : 'on-request', approvalsReviewer: 'user' }
}

export const APPROVAL_METHODS = new Set([
  'item/commandExecution/requestApproval', 'item/fileChange/requestApproval', 'item/permissions/requestApproval',
])
export function permissionReason(request: RpcRequest): string {
  const p = request.params
  const details = [text(p.command), text(p.reason), text(p.cwd), text(p.grantRoot)].filter(Boolean)
  if (request.method === 'item/permissions/requestApproval') details.push(JSON.stringify(p.permissions ?? {}))
  return [`Codex: ${request.method.split('/')[1] ?? request.method}`, ...details].join('\n')
}
export function permissionResult(request: RpcRequest, outcome: ApprovalOutcome): unknown {
  if (request.method === 'item/permissions/requestApproval') {
    const requested = record(request.params.permissions)
    const permissions: Record<string, unknown> = {}
    if (outcome === 'allowed-once') {
      if (requested.network != null) permissions.network = requested.network
      if (requested.fileSystem != null) permissions.fileSystem = requested.fileSystem
    }
    return { permissions, scope: 'turn' }
  }
  return { decision: outcome === 'allowed-once' ? 'accept' : outcome === 'cancelled' ? 'cancel' : 'decline' }
}
