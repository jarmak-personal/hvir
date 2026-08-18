import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'

import {
  AGENT_WORK_PHASES,
  type AgentWorkPhase,
} from './project-management/agent-work-ledger.ts'
import {
  AgentWorkCheckpointStore,
  isAgentWorkCheckpointIssueLocator,
  type AgentWorkCheckpointIssueLocator,
  type AgentWorkCheckpointLocator,
} from './agent-work-checkpoint-store.mts'
import {
  captureHarnessUsageSnapshot,
  isSupportedUsageProvider,
  type SupportedUsageProvider,
} from './prove-harness-usage-runner.mts'

const OPERATIONS = ['start', 'pause', 'resume', 'finish', 'abandon', 'release'] as const
type CheckpointOperation = (typeof OPERATIONS)[number]

interface CheckpointCommand {
  readonly operation: CheckpointOperation
  readonly issueNumber: AgentWorkCheckpointIssueLocator
  readonly phase: AgentWorkPhase
  readonly providerId: SupportedUsageProvider
  readonly runKey: string
}

export async function runAgentWorkCheckpoint(
  args: readonly string[],
  environment: NodeJS.ProcessEnv = process.env,
): Promise<number> {
  const command = parseCommand(args)
  const sessionId = currentSessionIdentity(command.providerId, environment)
  if (!sessionId) {
    writeResult({
      version: 1,
      operation: command.operation,
      status: 'unavailable',
      reason: 'run-identity-unproven',
    })
    return 2
  }
  const locator: AgentWorkCheckpointLocator = {
    issueNumber: command.issueNumber,
    phase: command.phase,
    providerId: command.providerId,
    sessionId,
    runKey: command.runKey,
  }
  const store = new AgentWorkCheckpointStore(checkpointRoot(environment))

  if (command.operation === 'start') {
    const existing = await store.inspect(locator)
    if (existing) {
      writeResult(existing)
      return 0
    }
    const cwd = environment.HVIR_USAGE_CWD || process.cwd()
    const artifactEnvironment = selectedArtifactEnvironment(
      command.providerId,
      environment,
    )
    const snapshot = await captureHarnessUsageSnapshot(command.providerId, {
      sessionId,
      cwd,
      artifactEnvironment,
    })
    if (snapshot.status === 'unavailable') {
      writeResult({
        version: 1,
        operation: 'start',
        status: 'unavailable',
        reason: snapshot.reason,
      })
      return 2
    }
    writeResult(await store.start({ ...locator, cwd, artifactEnvironment, snapshot }))
    return 0
  }
  if (command.operation === 'pause') {
    const result = await store.pause(locator)
    writeResult(result)
    return result.status === 'unavailable' ? 2 : 0
  }
  if (command.operation === 'resume') {
    const result = await store.resume(locator)
    writeResult(result)
    return result.status === 'unavailable' ? 2 : 0
  }
  if (command.operation === 'abandon') {
    const result = await store.abandon(locator)
    writeResult(result)
    return result.status === 'unavailable' ? 2 : 0
  }
  if (command.operation === 'release') {
    const result = await store.release(locator)
    writeResult(result)
    return result.status === 'unavailable' ? 2 : 0
  }

  const result = await store.finish(locator, (context) =>
    captureHarnessUsageSnapshot(command.providerId, context),
  )
  if (!result) {
    writeResult({
      version: 1,
      operation: 'finish',
      status: 'unavailable',
      reason: 'run-identity-unproven',
    })
    return 2
  }
  writeResult(result)
  return 0
}

function parseCommand(args: readonly string[]): CheckpointCommand {
  const [operation, ...options] = args
  if (!operation || !OPERATIONS.some((candidate) => candidate === operation)) {
    throw new Error(
      'Usage: agent-work:checkpoint <start|pause|resume|finish|abandon|release> --issue <positive-number|pending> --phase <phase> --provider <codex|claude-code> --run-key <64-hex-key>',
    )
  }
  const values = new Map<string, string>()
  for (let index = 0; index < options.length; index += 2) {
    const name = options[index]
    const value = options[index + 1]
    if (
      !name ||
      !value ||
      !['--issue', '--phase', '--provider', '--run-key'].includes(name)
    ) {
      throw new Error('Agent-work checkpoint options are invalid.')
    }
    if (values.has(name)) throw new Error(`Duplicate ${name} option.`)
    values.set(name, value)
  }
  const phase = values.get('--phase')
  const providerId = values.get('--provider')
  const runKey = values.get('--run-key')
  if (!phase || !AGENT_WORK_PHASES.some((candidate) => candidate === phase)) {
    throw new Error('--phase is not supported.')
  }
  const issueValue = values.get('--issue')
  const issueNumber = issueValue === 'pending' ? 'pending' : Number(issueValue)
  if (!isAgentWorkCheckpointIssueLocator(issueNumber, phase)) {
    if (issueNumber === 'pending') {
      throw new Error('--issue pending is supported only for issue-planning.')
    }
    throw new Error('--issue must be a positive safe integer or pending.')
  }
  if (!providerId || !isSupportedUsageProvider(providerId)) {
    throw new Error('--provider is not supported.')
  }
  if (!runKey || !/^[a-f0-9]{64}$/.test(runKey)) {
    throw new Error('--run-key must be exactly 64 lowercase hexadecimal characters.')
  }
  return {
    operation: operation as CheckpointOperation,
    issueNumber,
    phase: phase as AgentWorkPhase,
    providerId,
    runKey,
  }
}

function currentSessionIdentity(
  providerId: SupportedUsageProvider,
  environment: NodeJS.ProcessEnv,
): string | undefined {
  return providerId === 'codex'
    ? environment.CODEX_THREAD_ID
    : environment.HVIR_USAGE_SESSION_ID
}

function selectedArtifactEnvironment(
  providerId: SupportedUsageProvider,
  environment: NodeJS.ProcessEnv,
): Readonly<Record<string, string>> {
  const name = providerId === 'codex' ? 'CODEX_HOME' : 'CLAUDE_CONFIG_DIR'
  const value = environment[name]
  return value ? { [name]: value } : {}
}

function checkpointRoot(environment: NodeJS.ProcessEnv): string {
  return resolve(
    environment.HVIR_AGENT_WORK_CHECKPOINT_ROOT ||
      join(tmpdir(), 'hvir-agent-work-checkpoints-v1'),
  )
}

function writeResult(result: unknown): void {
  process.stdout.write(`${JSON.stringify(result, null, 2)}\n`)
}
