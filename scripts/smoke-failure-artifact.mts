import { mkdir, writeFile } from 'node:fs/promises'
import { constants as osConstants } from 'node:os'
import { join, resolve } from 'node:path'

import {
  SMOKE_FAILURE_PHASES,
  type SmokeFailureEvidence,
} from '../src/main/smoke/failure-evidence.mts'
import {
  ELECTRON_SMOKE_SCENARIOS,
  type ElectronSmokeScenario,
} from '../src/main/smoke/scenario-selection.mts'

const FAILURE_EVIDENCE_PREFIX = '[smoke:failure-evidence] '
const MAX_PARTIAL_LINE_LENGTH = 4_096
const MAX_ARTIFACT_BYTES = 4_096

export interface SmokeApplicationLogEvidence {
  readonly successSentinel: boolean
  readonly failureSentinel: boolean
  readonly startupFailure: boolean
  readonly cleanupFailure: boolean
  readonly evidenceRejected: boolean
}

export interface SmokeFailureArtifact {
  readonly schema: 1
  readonly scenario: ElectronSmokeScenario
  readonly iteration: number
  readonly repetitionCount: number
  readonly durationMs: number
  readonly expectedOutcome: 'exit-zero-with-success-sentinel'
  readonly process: {
    readonly exitCode: number | null
    readonly signal: NodeJS.Signals | null
    readonly spawnError: boolean
  }
  readonly semanticSnapshot: SmokeFailureEvidence | null
  readonly applicationLogs: SmokeApplicationLogEvidence
}

/** Parses reviewed evidence while deliberately retaining none of the raw process output. */
export class SmokeAttemptEvidenceCollector {
  private readonly partial = { stdout: '', stderr: '' }
  private snapshot: SmokeFailureEvidence | undefined
  private readonly logs = {
    successSentinel: false,
    failureSentinel: false,
    startupFailure: false,
    cleanupFailure: false,
    evidenceRejected: false,
  }

  observe(stream: 'stdout' | 'stderr', chunk: string): void {
    const combined = this.partial[stream] + chunk
    const lines = combined.split(/\r?\n/)
    this.partial[stream] = lines.pop()?.slice(-MAX_PARTIAL_LINE_LENGTH) ?? ''
    for (const line of lines) this.observeLine(line)
  }

  finish(): void {
    for (const stream of ['stdout', 'stderr'] as const) {
      if (this.partial[stream]) this.observeLine(this.partial[stream])
      this.partial[stream] = ''
    }
  }

  evidence(): {
    readonly snapshot: SmokeFailureEvidence | null
    readonly logs: SmokeApplicationLogEvidence
  } {
    return {
      snapshot: this.snapshot ?? null,
      logs: { ...this.logs },
    }
  }

  private observeLine(line: string): void {
    if (line === 'HVIR_SMOKE_OK') this.logs.successSentinel = true
    if (line.startsWith('HVIR_SMOKE_FAIL')) this.logs.failureSentinel = true
    if (line.startsWith('HVIR_STARTUP_FAIL')) this.logs.startupFailure = true
    if (line.startsWith('HVIR_SMOKE_CLEANUP_FAIL')) this.logs.cleanupFailure = true
    if (line.startsWith(FAILURE_EVIDENCE_PREFIX)) {
      try {
        this.snapshot = parseSmokeFailureEvidence(
          line.slice(FAILURE_EVIDENCE_PREFIX.length),
        )
      } catch {
        this.logs.evidenceRejected = true
      }
    }
  }
}

export function createSmokeFailureArtifact(options: {
  readonly scenario: ElectronSmokeScenario
  readonly iteration: number
  readonly repetitionCount: number
  readonly durationMs: number
  readonly exitCode: number | null
  readonly signal: NodeJS.Signals | null
  readonly spawnError: boolean
  readonly collector: SmokeAttemptEvidenceCollector
}): SmokeFailureArtifact {
  const evidence = options.collector.evidence()
  return {
    schema: 1,
    scenario: options.scenario,
    iteration: boundedCount(options.iteration),
    repetitionCount: boundedCount(options.repetitionCount),
    durationMs: boundedDuration(options.durationMs),
    expectedOutcome: 'exit-zero-with-success-sentinel',
    process: {
      exitCode: options.exitCode,
      signal: options.signal,
      spawnError: options.spawnError,
    },
    semanticSnapshot: evidence.snapshot,
    applicationLogs: evidence.logs,
  }
}

export async function writeSmokeFailureArtifact(
  directory: string | undefined,
  artifact: SmokeFailureArtifact,
): Promise<string | undefined> {
  if (!directory) return undefined
  validateSmokeFailureArtifact(artifact)
  const artifactDirectory = resolve(directory)
  await mkdir(artifactDirectory, { recursive: true })
  const path = join(
    artifactDirectory,
    `${artifact.scenario}-iteration-${artifact.iteration}-of-${artifact.repetitionCount}.json`,
  )
  const contents = `${JSON.stringify(artifact, null, 2)}\n`
  if (Buffer.byteLength(contents) > MAX_ARTIFACT_BYTES) {
    throw new Error('Smoke failure artifact exceeded its closed-schema byte bound')
  }
  await writeFile(path, contents, 'utf8')
  return path
}

function parseSmokeFailureEvidence(value: string): SmokeFailureEvidence {
  if (value.length > MAX_PARTIAL_LINE_LENGTH) {
    throw new Error('Smoke failure evidence exceeded its line bound')
  }
  return validateSmokeFailureEvidence(JSON.parse(value) as unknown)
}

function validateSmokeFailureEvidence(parsed: unknown): SmokeFailureEvidence {
  if (!isRecord(parsed)) throw new Error('Smoke failure evidence must be an object')
  requireExactKeys(parsed, ['owners', 'phase', 'schema'])
  if (
    parsed.schema !== 1 ||
    !SMOKE_FAILURE_PHASES.includes(parsed.phase as never) ||
    !isRecord(parsed.owners)
  ) {
    throw new Error('Smoke failure evidence envelope was invalid')
  }
  requireExactKeys(parsed.owners, [
    'ptyCount',
    'rendererGeneration',
    'rendererOwnerActive',
    'watcherActive',
    'windowCount',
  ])
  requireOwnedCount(parsed.owners.windowCount, 'windowCount')
  requireOwnedCount(parsed.owners.ptyCount, 'ptyCount')
  if (
    typeof parsed.owners.watcherActive !== 'boolean' ||
    typeof parsed.owners.rendererOwnerActive !== 'boolean'
  ) {
    throw new Error('Smoke failure ownership flags were invalid')
  }
  const generation = parsed.owners.rendererGeneration
  if (
    generation !== null &&
    (typeof generation !== 'number' ||
      !Number.isSafeInteger(generation) ||
      generation < 1)
  ) {
    throw new Error('Smoke failure renderer generation was invalid')
  }
  if (parsed.owners.rendererOwnerActive !== (generation !== null)) {
    throw new Error('Smoke failure renderer ownership fields disagreed')
  }
  return parsed as unknown as SmokeFailureEvidence
}

function validateSmokeFailureArtifact(
  artifact: unknown,
): asserts artifact is SmokeFailureArtifact {
  if (!isRecord(artifact)) throw new Error('Smoke failure artifact must be an object')
  requireExactKeys(artifact, [
    'applicationLogs',
    'durationMs',
    'expectedOutcome',
    'iteration',
    'process',
    'repetitionCount',
    'scenario',
    'schema',
    'semanticSnapshot',
  ])
  if (
    artifact.schema !== 1 ||
    !ELECTRON_SMOKE_SCENARIOS.includes(artifact.scenario as never) ||
    artifact.expectedOutcome !== 'exit-zero-with-success-sentinel'
  ) {
    throw new Error('Smoke failure artifact envelope was invalid')
  }
  boundedCount(artifact.iteration as number)
  boundedCount(artifact.repetitionCount as number)
  boundedDuration(artifact.durationMs as number)

  if (!isRecord(artifact.process)) {
    throw new Error('Smoke failure process outcome was invalid')
  }
  requireExactKeys(artifact.process, ['exitCode', 'signal', 'spawnError'])
  if (
    (artifact.process.exitCode !== null &&
      (!Number.isSafeInteger(artifact.process.exitCode) ||
        (artifact.process.exitCode as number) < 0 ||
        (artifact.process.exitCode as number) > 255)) ||
    (artifact.process.signal !== null &&
      (typeof artifact.process.signal !== 'string' ||
        !Object.hasOwn(osConstants.signals, artifact.process.signal))) ||
    typeof artifact.process.spawnError !== 'boolean'
  ) {
    throw new Error('Smoke failure process outcome was invalid')
  }
  const hasExit = artifact.process.exitCode !== null
  const hasSignal = artifact.process.signal !== null
  if (artifact.process.spawnError ? hasExit || hasSignal : hasExit === hasSignal) {
    throw new Error('Smoke failure process outcome was inconsistent')
  }

  if (!isRecord(artifact.applicationLogs)) {
    throw new Error('Smoke failure log evidence was invalid')
  }
  requireExactKeys(artifact.applicationLogs, [
    'cleanupFailure',
    'evidenceRejected',
    'failureSentinel',
    'startupFailure',
    'successSentinel',
  ])
  if (
    Object.values(artifact.applicationLogs).some((value) => typeof value !== 'boolean')
  ) {
    throw new Error('Smoke failure log evidence was invalid')
  }

  if (artifact.semanticSnapshot !== null) {
    validateSmokeFailureEvidence(artifact.semanticSnapshot)
  }
}

function boundedCount(value: number): number {
  if (!Number.isSafeInteger(value) || value < 1 || value > 100) {
    throw new Error('Smoke artifact iteration count was invalid')
  }
  return value
}

function boundedDuration(value: number): number {
  if (!Number.isFinite(value) || value < 0) {
    throw new Error('Smoke artifact duration was invalid')
  }
  return Math.min(Math.round(value), 86_400_000)
}

function requireOwnedCount(value: unknown, name: string): void {
  if (
    !Number.isSafeInteger(value) ||
    (value as number) < 0 ||
    (value as number) > 1_000
  ) {
    throw new Error(`Smoke failure ${name} was invalid`)
  }
}

function requireExactKeys(
  value: Record<string, unknown>,
  expected: readonly string[],
): void {
  if (Object.keys(value).sort().join(',') !== [...expected].sort().join(',')) {
    throw new Error('Smoke failure evidence contained unreviewed fields')
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}
