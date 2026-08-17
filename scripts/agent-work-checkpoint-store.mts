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
  AGENT_WORK_TOKEN_COUNTER_NAMES,
  HARNESS_USAGE_DELTA_UNAVAILABLE_REASONS,
} from '../src/shared'
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
const CLOCK_SAMPLE_MAX_SPAN_NANOSECONDS = 5_000_000n
const CLOCK_SAMPLE_ATTEMPTS = 3
const EPOCH_QUANTIZATION_NANOSECONDS = 1_000_000n
// RFC 5905's clock discipline uses a 500 ppm maximum frequency tolerance.
// Twice that bound covers relative wall/monotonic divergence without admitting jumps.
const CLOCK_RATE_TOLERANCE_PARTS_PER_MILLION = 1_000n
const PARTS_PER_MILLION = 1_000_000n
export const AGENT_WORK_CHECKPOINT_RETENTION_MILLISECONDS = 30 * 24 * 60 * 60 * 1_000

export type AgentWorkCheckpointIssueLocator = number | 'pending'

export function isAgentWorkCheckpointIssueLocator(
  issueNumber: unknown,
  phase: unknown,
): issueNumber is AgentWorkCheckpointIssueLocator {
  return issueNumber === 'pending'
    ? phase === 'issue-planning'
    : Number.isSafeInteger(issueNumber) && Number(issueNumber) > 0
}

export interface AgentWorkCheckpointLocator {
  readonly issueNumber: AgentWorkCheckpointIssueLocator
  readonly phase: AgentWorkPhase
  readonly providerId: SupportedUsageProvider
  readonly sessionId: string
  readonly runKey: string
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

interface AgentWorkCheckpointIdentity extends AgentWorkCheckpointLocator {
  readonly version: 1
}

interface AgentWorkCheckpointClockAnchor {
  readonly monotonicBeforeNanoseconds: string
  readonly monotonicAfterNanoseconds: string
  readonly epochMilliseconds: number
}

interface OpenAgentWorkCheckpointState extends AgentWorkCheckpointIdentity {
  readonly lifecycle: 'open'
  readonly clockVersion: 2
  readonly cwd: string
  readonly artifactEnvironment: Readonly<Record<string, string>>
  readonly snapshot: HarnessUsageSnapshot
  readonly accumulatedNanoseconds: string | null
  readonly activeSegmentStartedAt: AgentWorkCheckpointClockAnchor | 'unavailable' | null
}

interface FinalizedAgentWorkCheckpointState extends AgentWorkCheckpointIdentity {
  readonly lifecycle: 'finalized'
  readonly observation: AgentWorkCheckpointFinishResult
}

type AgentWorkCheckpointState =
  OpenAgentWorkCheckpointState | FinalizedAgentWorkCheckpointState

export type AgentWorkCheckpointStartResult = {
  readonly version: 1
  readonly operation: 'start'
  readonly status: 'started' | 'unchanged'
  readonly providerId: SupportedUsageProvider
  readonly route: Extract<HarnessUsageSnapshot, { status: 'available' }>['route']
}

export type AgentWorkCheckpointControlResult = {
  readonly version: 1
  readonly operation: 'pause' | 'resume' | 'abandon' | 'release'
  readonly status:
    'paused' | 'resumed' | 'abandoned' | 'released' | 'unchanged' | 'unavailable'
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
      route: stateRoute(state),
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
        route: stateRoute(existing),
      }
    }
    const state: OpenAgentWorkCheckpointState = {
      version: CHECKPOINT_VERSION,
      lifecycle: 'open',
      clockVersion: 2,
      issueNumber: input.issueNumber,
      phase: input.phase,
      providerId: input.providerId,
      sessionId: input.sessionId,
      runKey: input.runKey,
      cwd: input.cwd,
      artifactEnvironment: input.artifactEnvironment,
      snapshot: input.snapshot,
      accumulatedNanoseconds: '0',
      activeSegmentStartedAt: clockAnchor(this.clock),
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
        route: stateRoute(raced),
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
    if (state.lifecycle !== 'open') {
      throw new Error('A finalized agent-work checkpoint must be released after append.')
    }
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
    if (state.lifecycle === 'finalized') return state.observation
    const end = await captureEnd({
      sessionId: state.sessionId,
      cwd: state.cwd,
      artifactEnvironment: state.artifactEnvironment,
    })
    const activeWallMilliseconds = activeMilliseconds(state, clockAnchor(this.clock))
    const result: AgentWorkCheckpointFinishResult = {
      version: CHECKPOINT_VERSION,
      operation: 'finish',
      status: 'closed',
      providerId: state.providerId,
      startRoute: availableRoute(state.snapshot),
      usage: calculateHarnessUsageDelta(state.snapshot, end),
      ...(activeWallMilliseconds === undefined ? {} : { activeWallMilliseconds }),
    }
    const finalized: FinalizedAgentWorkCheckpointState = {
      version: CHECKPOINT_VERSION,
      lifecycle: 'finalized',
      issueNumber: state.issueNumber,
      phase: state.phase,
      providerId: state.providerId,
      sessionId: state.sessionId,
      runKey: state.runKey,
      observation: result,
    }
    await this.replace(path, finalized)
    return result
  }

  async release(
    locator: AgentWorkCheckpointLocator,
  ): Promise<AgentWorkCheckpointControlResult> {
    await this.ensureRoot()
    const path = this.checkpointPath(locator)
    await this.pruneStale(path)
    const state = await this.readOptional(path)
    if (!state) return unavailableControl('release')
    this.assertLocator(state, locator)
    if (state.lifecycle !== 'finalized') {
      throw new Error('An unfinished agent-work checkpoint cannot be released.')
    }
    await unlink(path)
    return { version: CHECKPOINT_VERSION, operation: 'release', status: 'released' }
  }

  async pruneStale(exceptPath?: string): Promise<number> {
    await this.ensureRoot()
    let entries
    try {
      entries = await readdir(this.root, { withFileTypes: true })
    } catch {
      return 0
    }
    const cutoff =
      this.clock.epochMilliseconds() - AGENT_WORK_CHECKPOINT_RETENTION_MILLISECONDS
    let removed = 0
    for (const entry of entries) {
      if (!entry.isFile() || !isOwnedCheckpointName(entry.name)) continue
      const path = join(this.root, entry.name)
      if (path === exceptPath) continue
      let metadata
      try {
        metadata = await lstat(path)
      } catch {
        continue
      }
      if (!metadata.isFile() || metadata.isSymbolicLink()) continue
      if (metadata.mtimeMs > cutoff) continue
      try {
        await unlink(path)
        removed += 1
      } catch {
        // Cleanup is best-effort; the requested checkpoint operation owns its own path.
      }
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
    if (state.lifecycle !== 'open') {
      throw new Error('A finalized agent-work checkpoint has no active clock.')
    }
    const now = clockAnchor(this.clock)
    const isActive = state.activeSegmentStartedAt !== null
    if (active === isActive) {
      return { version: CHECKPOINT_VERSION, operation, status: 'unchanged' }
    }
    const next: OpenAgentWorkCheckpointState = active
      ? {
          ...state,
          activeSegmentStartedAt: now,
        }
      : {
          ...state,
          accumulatedNanoseconds: accumulatedNanoseconds(state, now)?.toString() ?? null,
          activeSegmentStartedAt: null,
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
    if (!isAgentWorkCheckpointIssueLocator(locator.issueNumber, locator.phase)) {
      throw new Error(
        'A pending agent-work checkpoint locator is supported only for issue-planning.',
      )
    }
    const digest = createHash('sha256')
      .update(
        [
          'hvir-agent-work-checkpoint:v1',
          String(locator.issueNumber),
          locator.phase,
          locator.providerId,
          locator.sessionId,
          locator.runKey,
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
      state.sessionId !== locator.sessionId ||
      state.runKey !== locator.runKey
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
  if (!isCheckpointIdentity(value)) return invalidCheckpoint()
  if (value.lifecycle === 'open') {
    const currentSchema = exactKeys(value, [
      'version',
      'lifecycle',
      'clockVersion',
      'issueNumber',
      'phase',
      'providerId',
      'sessionId',
      'runKey',
      'cwd',
      'artifactEnvironment',
      'snapshot',
      'accumulatedNanoseconds',
      'activeSegmentStartedAt',
    ])
    const legacySchema = exactKeys(value, [
      'version',
      'lifecycle',
      'issueNumber',
      'phase',
      'providerId',
      'sessionId',
      'runKey',
      'cwd',
      'artifactEnvironment',
      'snapshot',
      'accumulatedNanoseconds',
      'activeSegmentStartedAt',
    ])
    if (
      (!currentSchema && !legacySchema) ||
      !boundedString(value.cwd, 4_096) ||
      !isStringRecord(value.artifactEnvironment) ||
      !isProofHarnessUsageSnapshot(value.snapshot) ||
      value.snapshot.status !== 'available' ||
      value.snapshot.providerId !== value.providerId ||
      !validArtifactEnvironment(String(value.providerId), value.artifactEnvironment) ||
      (currentSchema &&
        !(
          (value.clockVersion === 2 &&
            (value.accumulatedNanoseconds === null ||
              nonNegativeBigIntegerString(value.accumulatedNanoseconds)) &&
            isPersistedClockAnchor(value.activeSegmentStartedAt)) ||
          (value.clockVersion === 1 &&
            (value.accumulatedNanoseconds === null ||
              nonNegativeBigIntegerString(value.accumulatedNanoseconds)) &&
            isPreviousClockAnchor(value.activeSegmentStartedAt))
        )) ||
      (legacySchema &&
        (!nonNegativeBigIntegerString(value.accumulatedNanoseconds) ||
          !(
            value.activeSegmentStartedAt === null ||
            nonNegativeBigIntegerString(value.activeSegmentStartedAt)
          )))
    ) {
      return invalidCheckpoint()
    }
    if (legacySchema || value.clockVersion === 1) {
      return {
        ...(value as unknown as OpenAgentWorkCheckpointState),
        clockVersion: 2,
        accumulatedNanoseconds: null,
        activeSegmentStartedAt:
          value.activeSegmentStartedAt === null ? null : 'unavailable',
      }
    }
    return value as unknown as OpenAgentWorkCheckpointState
  }
  if (
    value.lifecycle !== 'finalized' ||
    !exactKeys(value, [
      'version',
      'lifecycle',
      'issueNumber',
      'phase',
      'providerId',
      'sessionId',
      'runKey',
      'observation',
    ]) ||
    !isFinishObservation(value.observation, String(value.providerId))
  ) {
    return invalidCheckpoint()
  }
  return value as unknown as FinalizedAgentWorkCheckpointState
}

function isCheckpointIdentity(value: unknown): value is Record<string, unknown> {
  return (
    isRecord(value) &&
    value.version === CHECKPOINT_VERSION &&
    isAgentWorkCheckpointIssueLocator(value.issueNumber, value.phase) &&
    AGENT_WORK_PHASES.some((phase) => phase === value.phase) &&
    ['codex', 'claude-code'].includes(String(value.providerId)) &&
    boundedString(value.sessionId, 1_024) &&
    typeof value.runKey === 'string' &&
    /^[a-f0-9]{64}$/.test(value.runKey)
  )
}

function invalidCheckpoint(): never {
  throw new Error('The private agent-work checkpoint does not use the supported schema.')
}

function isFinishObservation(value: unknown, providerId: string): boolean {
  if (
    !isRecord(value) ||
    !exactOptionalKeys(
      value,
      ['version', 'operation', 'status', 'providerId', 'startRoute', 'usage'],
      ['activeWallMilliseconds'],
    ) ||
    value.version !== CHECKPOINT_VERSION ||
    value.operation !== 'finish' ||
    value.status !== 'closed' ||
    value.providerId !== providerId ||
    !isUsageRoute(value.startRoute) ||
    !isUsageDelta(value.usage, providerId) ||
    (value.activeWallMilliseconds !== undefined &&
      nonNegativeUsageCounter(value.activeWallMilliseconds) === undefined)
  ) {
    return false
  }
  return true
}

function isUsageDelta(value: unknown, providerId: string): boolean {
  if (!isRecord(value)) return false
  if (value.status === 'unavailable') {
    return (
      exactKeys(value, ['status', 'reason']) &&
      HARNESS_USAGE_DELTA_UNAVAILABLE_REASONS.some((reason) => reason === value.reason)
    )
  }
  if (
    !['complete', 'partial'].includes(String(value.status)) ||
    !exactOptionalKeys(
      value,
      ['status', 'providerId', 'route', 'counters', 'missingCounters'],
      ['timing', 'normalizedTokenTotal'],
    ) ||
    value.providerId !== providerId ||
    !isRecord(value.route) ||
    !exactKeys(value.route, ['start', 'end']) ||
    !isUsageRoute(value.route.start) ||
    !isUsageRoute(value.route.end) ||
    !isUsageCounters(value.counters) ||
    !isMissingCounters(value.missingCounters) ||
    (value.timing !== undefined && !isUsageTiming(value.timing)) ||
    (value.normalizedTokenTotal !== undefined &&
      nonNegativeUsageCounter(value.normalizedTokenTotal) === undefined)
  ) {
    return false
  }
  return value.status === 'complete'
    ? value.normalizedTokenTotal !== undefined
    : value.normalizedTokenTotal === undefined
}

function isUsageRoute(value: unknown): boolean {
  return (
    isRecord(value) &&
    exactOptionalKeys(value, [], ['modelId', 'reasoningEffort']) &&
    optionalBoundedString(value.modelId, 160) &&
    optionalBoundedString(value.reasoningEffort, 64)
  )
}

function isUsageCounters(value: unknown): boolean {
  return (
    isRecord(value) &&
    Object.keys(value).every((key) =>
      AGENT_WORK_TOKEN_COUNTER_NAMES.some((name) => name === key),
    ) &&
    Object.values(value).every(
      (counter) => nonNegativeUsageCounter(counter) !== undefined,
    )
  )
}

function isMissingCounters(value: unknown): boolean {
  return (
    Array.isArray(value) &&
    new Set(value).size === value.length &&
    value.every(
      (counter) =>
        typeof counter === 'string' &&
        AGENT_WORK_TOKEN_COUNTER_NAMES.some((name) => name === counter),
    )
  )
}

function isUsageTiming(value: unknown): boolean {
  return (
    isRecord(value) &&
    exactKeys(value, ['modelOrApiMilliseconds']) &&
    nonNegativeUsageCounter(value.modelOrApiMilliseconds) !== undefined
  )
}

function serializeState(state: AgentWorkCheckpointState): string {
  return `${JSON.stringify(state)}\n`
}

function accumulatedNanoseconds(
  state: OpenAgentWorkCheckpointState,
  now: AgentWorkCheckpointClockAnchor | 'unavailable',
): bigint | undefined {
  if (state.accumulatedNanoseconds === null) return undefined
  const accumulated = BigInt(state.accumulatedNanoseconds)
  if (state.activeSegmentStartedAt === null) return accumulated
  if (state.activeSegmentStartedAt === 'unavailable' || now === 'unavailable') {
    return undefined
  }
  const elapsed = validatedElapsedNanoseconds(state.activeSegmentStartedAt, now)
  return elapsed === undefined ? undefined : accumulated + elapsed
}

function activeMilliseconds(
  state: OpenAgentWorkCheckpointState,
  now: AgentWorkCheckpointClockAnchor | 'unavailable',
): number | undefined {
  const accumulated = accumulatedNanoseconds(state, now)
  if (accumulated === undefined) return undefined
  const milliseconds = accumulated / 1_000_000n
  return milliseconds <= BigInt(Number.MAX_SAFE_INTEGER)
    ? Number(milliseconds)
    : undefined
}

function clockAnchor(
  clock: AgentWorkCheckpointClock,
): AgentWorkCheckpointClockAnchor | 'unavailable' {
  for (let attempt = 0; attempt < CLOCK_SAMPLE_ATTEMPTS; attempt += 1) {
    const monotonicBeforeNanoseconds = clock.monotonicNanoseconds()
    const epochMilliseconds = clock.epochMilliseconds()
    const monotonicAfterNanoseconds = clock.monotonicNanoseconds()
    if (
      monotonicBeforeNanoseconds < 0n ||
      monotonicAfterNanoseconds < monotonicBeforeNanoseconds ||
      monotonicAfterNanoseconds - monotonicBeforeNanoseconds >
        CLOCK_SAMPLE_MAX_SPAN_NANOSECONDS ||
      nonNegativeUsageCounter(epochMilliseconds) === undefined
    ) {
      continue
    }
    return {
      monotonicBeforeNanoseconds: monotonicBeforeNanoseconds.toString(),
      monotonicAfterNanoseconds: monotonicAfterNanoseconds.toString(),
      epochMilliseconds,
    }
  }
  return 'unavailable'
}

function validatedElapsedNanoseconds(
  start: AgentWorkCheckpointClockAnchor,
  end: AgentWorkCheckpointClockAnchor,
): bigint | undefined {
  const startBefore = BigInt(start.monotonicBeforeNanoseconds)
  const startAfter = BigInt(start.monotonicAfterNanoseconds)
  const endBefore = BigInt(end.monotonicBeforeNanoseconds)
  const endAfter = BigInt(end.monotonicAfterNanoseconds)
  const epochElapsed =
    BigInt(end.epochMilliseconds - start.epochMilliseconds) * 1_000_000n
  if (endAfter < startBefore || epochElapsed < 0n) return undefined
  const monotonicElapsedLower =
    endBefore > startAfter ? endBefore - startAfter : 0n
  const monotonicElapsedUpper = endAfter - startBefore
  const epochElapsedLower =
    epochElapsed > EPOCH_QUANTIZATION_NANOSECONDS
      ? epochElapsed - EPOCH_QUANTIZATION_NANOSECONDS
      : 0n
  const epochElapsedUpper = epochElapsed + EPOCH_QUANTIZATION_NANOSECONDS
  const difference =
    monotonicElapsedUpper < epochElapsedLower
      ? epochElapsedLower - monotonicElapsedUpper
      : epochElapsedUpper < monotonicElapsedLower
        ? monotonicElapsedLower - epochElapsedUpper
        : 0n
  const comparisonDuration =
    monotonicElapsedUpper > epochElapsedUpper
      ? monotonicElapsedUpper
      : epochElapsedUpper
  const rateTolerance =
    (comparisonDuration * CLOCK_RATE_TOLERANCE_PARTS_PER_MILLION +
      PARTS_PER_MILLION -
      1n) /
    PARTS_PER_MILLION
  return difference <= rateTolerance
    ? epochElapsed
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

function stateRoute(
  state: AgentWorkCheckpointState,
): Extract<HarnessUsageSnapshot, { status: 'available' }>['route'] {
  return state.lifecycle === 'open'
    ? availableRoute(state.snapshot)
    : state.observation.startRoute
}

function unavailableControl(
  operation: 'pause' | 'resume' | 'abandon' | 'release',
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

function exactOptionalKeys(
  value: Record<string, unknown>,
  required: readonly string[],
  optional: readonly string[],
): boolean {
  const keys = Object.keys(value)
  return (
    required.every((key) => keys.includes(key)) &&
    keys.every((key) => required.includes(key) || optional.includes(key))
  )
}

function boundedString(value: unknown, maximum: number): value is string {
  return typeof value === 'string' && value.length > 0 && value.length <= maximum
}

function optionalBoundedString(value: unknown, maximum: number): boolean {
  return value === undefined || boundedString(value, maximum)
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

function isPersistedClockAnchor(
  value: unknown,
): value is AgentWorkCheckpointClockAnchor | 'unavailable' | null {
  return (
    value === null ||
    value === 'unavailable' ||
    (isRecord(value) &&
      exactKeys(value, [
        'monotonicBeforeNanoseconds',
        'monotonicAfterNanoseconds',
        'epochMilliseconds',
      ]) &&
      nonNegativeBigIntegerString(value.monotonicBeforeNanoseconds) &&
      nonNegativeBigIntegerString(value.monotonicAfterNanoseconds) &&
      BigInt(value.monotonicAfterNanoseconds) >=
        BigInt(value.monotonicBeforeNanoseconds) &&
      BigInt(value.monotonicAfterNanoseconds) -
        BigInt(value.monotonicBeforeNanoseconds) <=
        CLOCK_SAMPLE_MAX_SPAN_NANOSECONDS &&
      nonNegativeUsageCounter(value.epochMilliseconds) !== undefined)
  )
}

function isPreviousClockAnchor(value: unknown): boolean {
  return (
    value === null ||
    value === 'unavailable' ||
    (isRecord(value) &&
      exactKeys(value, ['monotonicNanoseconds', 'epochMilliseconds']) &&
      nonNegativeBigIntegerString(value.monotonicNanoseconds) &&
      nonNegativeUsageCounter(value.epochMilliseconds) !== undefined)
  )
}

function isNodeError(error: unknown, code: string): boolean {
  return error instanceof Error && 'code' in error && error.code === code
}
