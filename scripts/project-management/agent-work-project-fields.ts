export const AGENT_WORK_RISK_OPTIONS = ['Low', 'Moderate', 'High', 'Critical'] as const

export const AGENT_WORK_CONFIDENCE_OPTIONS = ['Low', 'Medium', 'High'] as const

export const AGENT_WORK_FIRST_PASS_OPTIONS = [
  'Pending',
  'Accepted',
  'Rework required',
  'No candidate',
] as const

export const AGENT_WORK_PROJECT_FIELDS = [
  { name: 'Agent difficulty', type: 'number' },
  {
    name: 'Risk',
    type: 'single-select',
    options: AGENT_WORK_RISK_OPTIONS,
  },
  {
    name: 'Estimate confidence',
    type: 'single-select',
    options: AGENT_WORK_CONFIDENCE_OPTIONS,
  },
  { name: 'Initial model', type: 'text' },
  { name: 'Reasoning effort', type: 'text' },
  { name: 'Model route', type: 'text' },
  { name: 'Planning tokens', type: 'number' },
  { name: 'Implementation tokens', type: 'number' },
  { name: 'Review tokens', type: 'number' },
  { name: 'Own lifecycle tokens', type: 'number' },
  { name: 'Time to first candidate (ms)', type: 'number' },
  {
    name: 'First-pass outcome',
    type: 'single-select',
    options: AGENT_WORK_FIRST_PASS_OPTIONS,
  },
  { name: 'Epic rollup tokens', type: 'number' },
] as const

export type AgentWorkProjectField = (typeof AGENT_WORK_PROJECT_FIELDS)[number]
export type AgentWorkProjectFieldName = AgentWorkProjectField['name']
export type AgentWorkProjectFieldType = AgentWorkProjectField['type']
export type AgentWorkProjectValue = string | number
export type AgentWorkProjectValues = Partial<
  Record<AgentWorkProjectFieldName, AgentWorkProjectValue>
>

export type AgentWorkProjectWriteFailure =
  'permission' | 'schema' | 'transport' | 'generic'

export class AgentWorkProjectWriteError extends Error {
  readonly failure: AgentWorkProjectWriteFailure

  constructor(failure: AgentWorkProjectWriteFailure) {
    super('The named agent-work Project field write failed.')
    this.name = 'AgentWorkProjectWriteError'
    this.failure = failure
  }
}

export function agentWorkProjectField(
  name: AgentWorkProjectFieldName,
): AgentWorkProjectField {
  return AGENT_WORK_PROJECT_FIELDS.find((field) => field.name === name)!
}
