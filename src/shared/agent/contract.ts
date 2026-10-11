import { WORKSPACE_IDENTITY_CHARS, type HostPath } from '../host-path.ts'

/** Process-neutral command transport. Origin and authorization are never wire fields. */
export const AGENT_CONTRACT = '1.0'
export const AGENT_LIMITS = {
  frameBytes: 256 * 1024,
  stdinBytes: 128 * 1024,
  connections: 16,
  requests: 32,
  requestsPerSecond: 10,
  deadlineMs: 190_000,
  confirmationMs: 30_000,
  confirmations: 16,
  reports: 64,
  reportBytes: 128 * 1024,
  reportTotalBytes: 4 * 1024 * 1024,
  pageSize: 32,
  // Workspace identities include the registered host and complete path.
  workspaceIdentityChars: WORKSPACE_IDENTITY_CHARS,
} as const
export interface AgentTarget {
  readonly workspace?: string
  readonly session?: string
}
export interface AgentRequest {
  readonly contract: typeof AGENT_CONTRACT
  readonly argv: readonly string[]
  readonly stdin: string
  readonly defaults: AgentTarget
}
export interface AgentResponse {
  readonly contract: typeof AGENT_CONTRACT
  readonly stdout: string
  readonly stderr: string
  readonly exitStatus: number
}
export interface AgentSettings {
  readonly enabled: boolean
  readonly confirmDestructive: boolean
}
export interface AgentConfirmation {
  readonly id: string
  readonly title: string
  readonly workspace?: string
  readonly session?: string
  readonly effects: readonly ('delete' | 'replace')[]
  readonly expiresAt: number
  readonly input: string
}
export interface AgentAccessState extends AgentSettings {
  readonly forwards?: readonly AgentForwardState[]
  readonly forwardOptions?: readonly AgentForwardGrant[]
  readonly extensions: readonly string[]
  readonly extensionsWritable: boolean
  readonly ready: boolean
  readonly endpoint?: string
  readonly instance: string
  readonly confirmations: readonly AgentConfirmation[]
  readonly explanation?: string
}
export interface AgentForwardGrant {
  readonly host: string
  readonly generation: string
  readonly installation: string
  readonly revision: string
  readonly action: string
  readonly capability: 'connector.execute' | 'delivery.capture'
  readonly executionHost: string
  readonly workspace: string
}
export interface AgentForwardState {
  readonly host: string
  readonly generation: string
  readonly availability: 'ready' | 'unavailable' | 'preparing'
  readonly explanation?: string
  readonly grants: readonly AgentForwardGrant[]
}
export interface AgentReport {
  readonly id: string
  readonly workspace: string
  readonly root: HostPath
  readonly title: string
  readonly format: 'text' | 'markdown'
  readonly content: string
  readonly unread: boolean
  readonly version: number
}
export type AgentReportSummary = Omit<AgentReport, 'content'>
export interface AgentDocumentPresentation {
  readonly workspace: string
  readonly root: HostPath
  readonly path: HostPath
}
export function validateAgentRequest(value: unknown): AgentRequest {
  if (!value || typeof value !== 'object' || Array.isArray(value))
    throw new Error('Invalid agent request')
  const request = value as Record<string, unknown>
  if (request['contract'] !== AGENT_CONTRACT)
    throw new Error(`Agent contract ${AGENT_CONTRACT} is required`)
  if (
    !Array.isArray(request['argv']) ||
    request['argv'].length > 64 ||
    request['argv'].some((arg) => typeof arg !== 'string' || arg.length > 8192)
  )
    throw new Error('Invalid command arguments')
  if (
    typeof request['stdin'] !== 'string' ||
    new TextEncoder().encode(request['stdin']).length > AGENT_LIMITS.stdinBytes
  )
    throw new Error('Command input exceeds its bound')
  const defaults = request['defaults']
  if (!defaults || typeof defaults !== 'object' || Array.isArray(defaults))
    throw new Error('Invalid target defaults')
  const target = defaults as Record<string, unknown>
  for (const key of ['workspace', 'session'])
    if (
      target[key] !== undefined &&
      (typeof target[key] !== 'string' ||
        !target[key].length ||
        target[key].length >
          (key === 'workspace' ? AGENT_LIMITS.workspaceIdentityChars : 128))
    )
      throw new Error('Invalid target identity')
  return {
    contract: AGENT_CONTRACT,
    argv: Object.freeze([...(request['argv'] as string[])]),
    stdin: request['stdin'],
    defaults: Object.freeze({
      ...(typeof target['workspace'] === 'string'
        ? { workspace: target['workspace'] }
        : {}),
      ...(typeof target['session'] === 'string' ? { session: target['session'] } : {}),
    }),
  }
}
export function agentOutput(value: unknown, exitStatus = 0): AgentResponse {
  return {
    contract: AGENT_CONTRACT,
    stdout: `${JSON.stringify({ contract: AGENT_CONTRACT, ok: exitStatus === 0, ...(value as object) })}\n`,
    stderr: '',
    exitStatus,
  }
}
export function agentFailure(
  code: string,
  message: string,
  exitStatus = 69,
): AgentResponse {
  return agentOutput({ error: { code, message: message.slice(0, 240) } }, exitStatus)
}
