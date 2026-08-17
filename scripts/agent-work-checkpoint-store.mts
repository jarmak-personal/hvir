import { createHash, randomUUID } from 'node:crypto'
import {
  lstat,
  mkdir,
  readFile,
  readdir,
  rename,
  unlink,
  writeFile,
} from 'node:fs/promises'
import { join } from 'node:path'

import {
  calculateHarnessUsageDelta,
  nonNegativeUsageCounter,
  type HarnessUsageDelta,
  type HarnessUsageSnapshot,
} from '../src/main/harness/agent-work-usage'
import {
  AGENT_WORK_PHASES,
  type AgentWorkPhase,
} from './project-management/agent-work-ledger.ts'
import {
  isProofHarnessUsageSnapshot,
  type HarnessUsagePrivateContext,
  type SupportedUsageProvider,
} from './prove-harness-usage-runner.mts'

const CHECKPOINT_VERSION = 1
const MAX_CHECKPOINT_BYTES = 128 * 1024
export const AGENT_WORK_CHECKPOINT_RETENTION_MILLISECONDS = 30 * 24 * 60 * 60 * 1_000

export interface AgentWorkCheckpointLocator {
  readonly issueNumber: number
  readonly phase: AgentWorkPhase
  readonly providerId: SupportedUsageProvider
  readonly sessionId: string
}

export interface AgentWorkCheckpointStartInput extends AgentWorkCheckpointLocator {
  readonly cwd: string
  readonly artifactEnvironment: Readonly<Record<string, string>>
  readonly snapshot: HarnessUsageSnapshot
}

export interface AgentWorkCheckpointClock {
  monotonicNanoseconds(): bigint
  epochMilliseconds(): number
}

interface AgentWorkCheckpointState {
  readonly version: 1
  readonly issueNumber: number
  readonly phase: AgentWorkPhase
  readonly providerId: SupportedUsageProvider
  readonly sessionId: string
  readonly cwd: string
  readonly artifactEnvironment: Readonly<Record<string, string>>
  readonly snapshot: HarnessUsageSnapshot
  readonly accumulatedNanoseconds: string
  readonly activeSegmentStartedAt: string | null
  readonly updatedAtEpochMilliseconds: number
}

export type AgentWorkCheckpointStartResult = {
  readonly version: 1
  readonly operation: 'start'
  readonly status: 'started' | 'unchanged'
  readonly providerId: SupportedUsageProvider
  readonly route: Extract<HarnessUsageSnapshot, { status: 'available' }>['route']
}

export type AgentWorkCheckpointControlResult = {
  readonly version: 1
  readonly operation: 'pause' | 'resume' | 'abandon'
  readonly status: 'paused' | 'resumed' | 'abandoned' | 'unchanged' | 'unavailable'
  readonly reason?: 'run-identity-unproven'
}

export interface AgentWorkCheckpointFinishResult {
  readonly version: 1
  readonly operation: 'finish'
  readonly status: 'closed'
  readonly providerId: SupportedUsageProvider
  readonly startRoute: Extract<HarnessUsageSnapshot, { status: 'available' }>['route']
  readonly usage: HarnessUsageDelta
  readonly activeWallMilliseconds?: number
}

const systemClock: AgentWorkCheckpointClock = {
  monotonicNanoseconds: () => process.hrtime.bigint(),
  epochMilliseconds: () => Date.now(),
}

export class AgentWorkCheckpointStore {
  constructor(
    private readonly root: string,
    private readonly clock: AgentWorkCheckpointClock = systemClock,
  ) {}

  async inspect(
    locator: AgentWorkCheckpointLocator,
  ): Promise<AgentWorkCheckpointStartResult | undefined> {
    await this.ensureRoot()
    const path = this.checkpointPath(locator)
    await this.pruneStale()
    const state = await this.readOptional(path)
    if (!state) return undefined
    this.assertLocator(state, locator)
    return {
      version: CHECKPOINT_VERSION,
      operation: 'start',
      status: 'unchanged',
      providerId: state.providerId,
      route: availableRoute(state.snapshot),
    }
  }

  async start(
    input: AgentWorkCheckpointStartInput,
  ): Promise<AgentWorkCheckpointStartResult> {
    if (input.snapshot.status !== 'available') {
      throw new Error('A checkpoint requires an available provider start snapshot.')
    }
    if (input.snapshot.providerId !== input.providerId) {
      throw new Error('The checkpoint provider does not match its start snapshot.')
    }
    await this.ensureRoot()
    const path = this.checkpointPath(input)
    await this.pruneStale()
    const existing = await this.readOptional(path)
    if (existing) {
      this.assertLocator(existing, input)
      return {
        version: CHECKPOINT_VERSION,
        operation: 'start',
        status: 'unchanged',
        providerId: existing.providerId,
        route: availableRoute(existing.snapshot),
      }
    }
    const state: AgentWorkCheckpointState = {
      version: CHECKPOINT_VERSION,
      issueNumber: input.issueNumber,
      phase: input.phase,
      providerId: input.providerId,
      sessionId: input.sessionId,
      cwd: input.cwd,
      artifactEnvironment: input.artifactEnvironment,
      snapshot: input.snapshot,
      accumulatedNanoseconds: '0',
      activeSegmentStartedAt: this.clock.monotonicNanoseconds().toString(),
      updatedAtEpochMilliseconds: this.clock.epochMilliseconds(),
    }
    try {
      await writeFile(path, serializeState(state), {
        encoding: 'utf8',
        flag: 'wx',
        mode: 0o600,
      })
    } catch (error) {
      if (!isNodeError(error, 'EEXIST')) throw error
      const raced = await this.read(path)
      this.assertLocator(raced, input)
      return {
        version: CHECKPOINT_VERSION,
        operation: 'start',
        status: 'unchanged',
        providerId: raced.providerId,
        route: availableRoute(raced.snapshot),
      }
    }
    return {
      version: CHECKPOINT_VERSION,
      operation: 'start',
      status: 'started',
      providerId: input.providerId,
      route: input.snapshot.route,
    }
  }

  async pause(
    locator: AgentWorkCheckpointLocator,
  ): Promise<AgentWorkCheckpointControlResult> {
    return this.setActive(locator, false)
  }

  async resume(
    locator: AgentWorkCheckpointLocator,
  ): Promise<AgentWorkCheckpointControlResult> {
    return this.setActive(locator, true)
  }

  async abandon(
    locator: AgentWorkCheckpointLocator,
  ): Promise<AgentWorkCheckpointControlResult> {
    await this.ensureRoot()
    const path = this.checkpointPath(locator)
    await this.pruneStale(path)
    const state = await this.readOptional(path)
    if (!state) return unavailableControl('abandon')
    this.assertLocator(state, locator)
    await unlink(path)
    return { version: CHECKPOINT_VERSION, operation: 'abandon', status: 'abandoned' }
  }

  async finish(
    locator: AgentWorkCheckpointLocator,
    captureEnd: (context: HarnessUsagePrivateContext) => Promise<HarnessUsageSnapshot>,
  ): Promise<AgentWorkCheckpointFinishResult | undefined> {
    await this.ensureRoot()
    const path = this.checkpointPath(locator)
    await this.pruneStale(path)
    const state = await this.readOptional(path)
    if (!state) return undefined
    this.assertLocator(state, locator)
    const end = await captureEnd({
      sessionId: state.sessionId,
      cwd: state.cwd,
      artifactEnvironment: state.artifactEnvironment,
    })
    const activeWallMilliseconds = activeMilliseconds(
      state,
      this.clock.monotonicNanoseconds(),
    )
    const result: AgentWorkCheckpointFinishResult = {
      version: CHECKPOINT_VERSION,
      operation: 'finish',
      status: 'closed',
      providerId: state.providerId,
      startRoute: availableRoute(state.snapshot),
      usage: calculateHarnessUsageDelta(state.snapshot, end),
      ...(activeWallMilliseconds === undefined ? {} : { activeWallMilliseconds }),
    }
    await unlink(path)
    return result
  }

  async pruneStale(exceptPath?: string): Promise<number> {
    await this.ensureRoot()
    const entries = await readdir(this.root, { withFileTypes: true })
    const cutoff =
      this.clock.epochMilliseconds() - AGENT_WORK_CHECKPOINT_RETENTION_MILLISECONDS
    let removed = 0
    for (const entry of entries) {
      if (!entry.isFile() || !isOwnedCheckpointName(entry.name)) continue
      const path = join(this.root, entry.name)
      if (path === exceptPath) continue
      const metadata = await lstat(path)
      if (!metadata.isFile() || metadata.isSymbolicLink()) continue
      if (metadata.mtimeMs > cutoff) continue
      await unlink(path)
      removed += 1
    }
    return removed
  }

  private async setActive(
    locator: AgentWorkCheckpointLocator,
    active: boolean,
  ): Promise<AgentWorkCheckpointControlResult> {
    await this.ensureRoot()
    const path = this.checkpointPath(locator)
    await this.pruneStale(path)
    const state = await this.readOptional(path)
    const operation = active ? 'resume' : 'pause'
    if (!state) return unavailableControl(operation)
    this.assertLocator(state, locator)
    const now = this.clock.monotonicNanoseconds()
    const isActive = state.activeSegmentStartedAt !== null
    if (active === isActive) {
      return { version: CHECKPOINT_VERSION, operation, status: 'unchanged' }
    }
    const next: AgentWorkCheckpointState = active
      ? {
          ...state,
          activeSegmentStartedAt: now.toString(),
          updatedAtEpochMilliseconds: this.clock.epochMilliseconds(),
        }
      : {
          ...state,
          accumulatedNanoseconds: accumulatedNanoseconds(state, now).toString(),
          activeSegmentStartedAt: null,
          updatedAtEpochMilliseconds: this.clock.epochMilliseconds(),
        }
    await this.replace(path, next)
    return {
      version: CHECKPOINT_VERSION,
      operation,
      status: active ? 'resumed' : 'paused',
    }
  }

  private async ensureRoot(): Promise<void> {
    await mkdir(this.root, { recursive: true, mode: 0o700 })
    const metadata = await lstat(this.root)
    if (!metadata.isDirectory() || metadata.isSymbolicLink()) {
      throw new Error('The agent-work checkpoint root is not a private directory.')
    }
    if ((metadata.mode & 0o077) !== 0) {
      throw new Error('The agent-work checkpoint root permits group or other access.')
    }
    if (typeof process.getuid === 'function' && metadata.uid !== process.getuid()) {
      throw new Error('The agent-work checkpoint root has a different owner.')
    }
  }

  private checkpointPath(locator: AgentWorkCheckpointLocator): string {
    const digest = createHash('sha256')
      .update(
        [
          'hvir-agent-work-checkpoint:v1',
          String(locator.issueNumber),
          locator.phase,
          locator.providerId,
          locator.sessionId,
        ].join('\0'),
      )
      .digest('hex')
    return join(this.root, `${digest}.json`)
  }

  private async readOptional(
    path: string,
  ): Promise<AgentWorkCheckpointState | undefined> {
    try {
      return await this.read(path)
    } catch (error) {
      if (isNodeError(error, 'ENOENT')) return undefined
      throw error
    }
  }

  private async read(path: string): Promise<AgentWorkCheckpointState> {
    const metadata = await lstat(path)
    if (
      !metadata.isFile() ||
      metadata.isSymbolicLink() ||
      metadata.size > MAX_CHECKPOINT_BYTES
    ) {
      throw new Error('The private agent-work checkpoint is invalid.')
    }
    if ((metadata.mode & 0o077) !== 0) {
      throw new Error('The private agent-work checkpoint permits group or other access.')
    }
    if (typeof process.getuid === 'function' && metadata.uid !== process.getuid()) {
      throw new Error('The private agent-work checkpoint has a different owner.')
    }
    const serialized = await readFile(path, 'utf8')
    return parseState(serialized)
  }

  private assertLocator(
    state: AgentWorkCheckpointState,
    locator: AgentWorkCheckpointLocator,
  ): void {
    if (
      state.issueNumber !== locator.issueNumber ||
      state.phase !== locator.phase ||
      state.providerId !== locator.providerId ||
      state.sessionId !== locator.sessionId
    ) {
      throw new Error('The private agent-work checkpoint identity does not match.')
    }
  }

  private async replace(path: string, state: AgentWorkCheckpointState): Promise<void> {
    const temporary = `${path}.${randomUUID()}.tmp`
    try {
      await writeFile(temporary, serializeState(state), {
        encoding: 'utf8',
        flag: 'wx',
        mode: 0o600,
      })
      await rename(temporary, path)
    } catch (error) {
      try {
        await unlink(temporary)
      } catch {
        // Preserve the original write or rename failure; stale cleanup owns the residue.
      }
      throw error
    }
  }
}

function parseState(serialized: string): AgentWorkCheckpointState {
  let value: unknown
  try {
    value = JSON.parse(serialized)
  } catch {
    throw new Error('The private agent-work checkpoint is not valid JSON.')
  }
  if (
    !isRecord(value) ||
    !exactKeys(value, [
      'version',
      'issueNumber',
      'phase',
      'providerId',
      'sessionId',
      'cwd',
      'artifactEnvironment',
      'snapshot',
      'accumulatedNanoseconds',
      'activeSegmentStartedAt',
      'updatedAtEpochMilliseconds',
    ])
  ) {
    throw new Error(
      'The private agent-work checkpoint does not use the supported schema.',
    )
  }
  if (
    value.version !== CHECKPOINT_VERSION ||
    !Number.isSafeInteger(value.issueNumber) ||
    Number(value.issueNumber) < 1 ||
    !AGENT_WORK_PHASES.some((phase) => phase === value.phase) ||
    !['codex', 'claude-code'].includes(String(value.providerId)) ||
    !boundedString(value.sessionId, 1_024) ||
    !boundedString(value.cwd, 4_096) ||
    !isStringRecord(value.artifactEnvironment) ||
    !isProofHarnessUsageSnapshot(value.snapshot) ||
    value.snapshot.status !== 'available' ||
    value.snapshot.providerId !== value.providerId ||
    !validArtifactEnvironment(String(value.providerId), value.artifactEnvironment) ||
    !nonNegativeBigIntegerString(value.accumulatedNanoseconds) ||
    !(
      value.activeSegmentStartedAt === null ||
      nonNegativeBigIntegerString(value.activeSegmentStartedAt)
    ) ||
    nonNegativeUsageCounter(value.updatedAtEpochMilliseconds) === undefined
  ) {
    throw new Error(
      'The private agent-work checkpoint does not use the supported schema.',
    )
  }
  return value as unknown as AgentWorkCheckpointState
}

function serializeState(state: AgentWorkCheckpointState): string {
  return `${JSON.stringify(state)}\n`
}

function accumulatedNanoseconds(state: AgentWorkCheckpointState, now: bigint): bigint {
  const accumulated = BigInt(state.accumulatedNanoseconds)
  if (state.activeSegmentStartedAt === null) return accumulated
  const startedAt = BigInt(state.activeSegmentStartedAt)
  return now < startedAt ? accumulated : accumulated + (now - startedAt)
}

function activeMilliseconds(
  state: AgentWorkCheckpointState,
  now: bigint,
): number | undefined {
  const milliseconds = accumulatedNanoseconds(state, now) / 1_000_000n
  return milliseconds <= BigInt(Number.MAX_SAFE_INTEGER)
    ? Number(milliseconds)
    : undefined
}

function availableRoute(
  snapshot: HarnessUsageSnapshot,
): Extract<HarnessUsageSnapshot, { status: 'available' }>['route'] {
  if (snapshot.status !== 'available') {
    throw new Error('The private agent-work checkpoint has no available start route.')
  }
  return snapshot.route
}

function unavailableControl(
  operation: 'pause' | 'resume' | 'abandon',
): AgentWorkCheckpointControlResult {
  return {
    version: CHECKPOINT_VERSION,
    operation,
    status: 'unavailable',
    reason: 'run-identity-unproven',
  }
}

function isOwnedCheckpointName(name: string): boolean {
  return /^[a-f0-9]{64}\.json(?:\.[a-f0-9-]+\.tmp)?$/.test(name)
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value)
}

function exactKeys(value: Record<string, unknown>, expected: readonly string[]): boolean {
  const keys = Object.keys(value)
  return keys.length === expected.length && keys.every((key) => expected.includes(key))
}

function boundedString(value: unknown, maximum: number): value is string {
  return typeof value === 'string' && value.length > 0 && value.length <= maximum
}

function isStringRecord(value: unknown): value is Record<string, string> {
  return (
    isRecord(value) && Object.values(value).every((entry) => typeof entry === 'string')
  )
}

function validArtifactEnvironment(
  providerId: string,
  value: Record<string, string>,
): boolean {
  const keys = Object.keys(value)
  const expected = providerId === 'codex' ? 'CODEX_HOME' : 'CLAUDE_CONFIG_DIR'
  return keys.length === 0 || (keys.length === 1 && keys[0] === expected)
}

function nonNegativeBigIntegerString(value: unknown): value is string {
  return typeof value === 'string' && /^(0|[1-9][0-9]*)$/.test(value)
}

function isNodeError(error: unknown, code: string): boolean {
  return error instanceof Error && 'code' in error && error.code === code
}
