/** Structured Codex context usage, isolated behind the harness adapter seam. */

import type { HarnessTelemetry, HostPath } from '../../shared'
import {
  asHarnessProviderId,
  contextHarnessSnapshot,
  contextStatusHarnessSnapshot,
  hostPath,
} from '../../shared'
import type { Disposer, ProjectHost } from '../project-host'
import {
  harnessUsageSnapshotTelemetry,
  harnessUsageValue,
  nonNegativeUsageCounter,
  unavailableHarnessUsageSnapshot,
  usageCountersDecreased,
  usageCountersEqual,
  usageObservationHarnessTelemetry,
  usageStatusHarnessTelemetry,
  type HarnessUsageSnapshot,
  type HarnessUsageSnapshotContext,
} from './harness-usage'
import type { HarnessUsageCounters } from '../../shared'
import {
  boundedHarnessUsageString,
  scanHarnessUsageArtifactLines,
} from './harness-usage-artifact'
import type { HarnessTelemetryContext } from './harness-provider'
import { canonicalCodexCwd } from './codex-session-discovery'
import {
  buildTelemetryHubScript,
  HEALTHY_HARNESS_TELEMETRY_RECORD,
  HarnessTelemetryHubRegistry,
} from './harness-telemetry-hub'
import type { HarnessTelemetryFollowerHealth } from './harness-telemetry-protocol'
import { scheduleHarnessUsageRead } from './harness-usage-read-scheduler'

const SESSION_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
const FIND_SESSION_SCRIPT = `
root="\${CODEX_HOME:-\${HOME}/.codex}/sessions"
[ -d "$root" ] || exit 0
find "$root" -type f -name "rollout-*-$1.jsonl" -print0
`.trim()
const FOLLOW_TOKEN_COUNTS_SCRIPT = buildTelemetryHubScript({
  prepareFollower: `
    [ "$follower_resource" != - ] || fail_follower resource-invalid
    follower_source=$(decode_base64 "$follower_resource") || fail_follower resource-invalid
  `,
  acceptRecord: `
      case "$line" in
        *'"type":"session_meta"'*) emit_frame "$line" ;;
        *'"type":"event_msg"'*)
          case "$line" in
            *'"type":"token_count"'*) emit_frame "$line" ;;
          esac
          ;;
      esac
  `,
})
const FIND_MAX_BUFFER = 256 * 1024
const USAGE_ARTIFACT_RETRY_MS = 250
const MAX_USAGE_ARTIFACT_RETRY_MS = 4_000

interface CodexSessionData {
  readonly rolloutPath: HostPath
}

interface TokenCountEnvelope {
  readonly type?: unknown
  readonly payload?: {
    readonly type?: unknown
    readonly info?: {
      readonly last_token_usage?: {
        readonly input_tokens?: unknown
        readonly total_tokens?: unknown
      }
      readonly model_context_window?: unknown
    } | null
  }
}

interface CodexUsageEnvelope {
  readonly type?: unknown
  readonly payload?: {
    readonly id?: unknown
    readonly cwd?: unknown
    readonly originator?: unknown
    readonly model?: unknown
    readonly effort?: unknown
    readonly type?: unknown
    readonly info?: {
      readonly total_token_usage?: CodexTokenUsage
    } | null
  }
}

interface CodexTokenUsage {
  readonly input_tokens?: unknown
  readonly cached_input_tokens?: unknown
  readonly cache_write_input_tokens?: unknown
  readonly output_tokens?: unknown
  readonly reasoning_output_tokens?: unknown
}

export async function snapshotCodexUsage(
  host: ProjectHost,
  context: HarnessUsageSnapshotContext,
): Promise<HarnessUsageSnapshot> {
  const providerId = asHarnessProviderId('codex')
  if (!SESSION_ID.test(context.sessionId) || context.signal.aborted) {
    return unavailableHarnessUsageSnapshot(providerId, 'invalid-session-identity')
  }
  const canonicalCwd = await canonicalCodexCwd(host, context.cwd, context.signal)
  if (!canonicalCwd) {
    return unavailableHarnessUsageSnapshot(providerId, 'invalid-session-identity')
  }
  const rolloutPath =
    sessionDataPath(context.sessionData, host, context.sessionId) ??
    (await findSessionPath(host, context.sessionId, context.signal, context.artifact))
  if (!rolloutPath || context.signal.aborted) {
    return unavailableHarnessUsageSnapshot(providerId, 'artifact-unavailable')
  }
  let identityQualified = false
  let modelId: string | undefined
  let reasoningEffort: string | undefined
  let counters: HarnessUsageCounters | undefined
  const artifact = await scanHarnessUsageArtifactLines(
    host,
    rolloutPath,
    context.signal,
    {
      visit: (line) => {
        const envelope = parseCodexUsageEnvelope(line)
        if (!envelope) return
        if (envelope.type === 'session_meta') {
          identityQualified ||=
            envelope.payload?.id === context.sessionId &&
            envelope.payload.cwd === canonicalCwd.path &&
            envelope.payload.originator === 'codex-tui'
          return
        }
        if (envelope.type === 'turn_context') {
          modelId = boundedHarnessUsageString(envelope.payload?.model) ?? modelId
          reasoningEffort =
            boundedHarnessUsageString(envelope.payload?.effort, 64) ?? reasoningEffort
          return
        }
        if (envelope.type !== 'event_msg' || envelope.payload?.type !== 'token_count') {
          return
        }
        const normalized = normalizeCodexUsageCounters(
          envelope.payload?.info?.total_token_usage,
        )
        if (normalized) counters = normalized
      },
      oversized: () => {
        modelId = undefined
        reasoningEffort = undefined
        counters = undefined
      },
    },
  )
  if (context.signal.aborted) {
    return unavailableHarnessUsageSnapshot(providerId, 'artifact-unavailable')
  }
  if (artifact.status === 'unavailable') {
    return unavailableHarnessUsageSnapshot(providerId, artifact.reason)
  }

  if (!identityQualified) {
    return unavailableHarnessUsageSnapshot(providerId, 'invalid-session-identity')
  }
  if (!counters) {
    return unavailableHarnessUsageSnapshot(providerId, 'usage-unavailable')
  }
  return {
    version: 1,
    status: 'available',
    providerId,
    observedAt: Date.now(),
    route: {
      ...(modelId ? { modelId } : {}),
      ...(reasoningEffort ? { reasoningEffort } : {}),
    },
    counters,
    timing: {},
  }
}

export async function observeCodexContext(
  host: ProjectHost,
  context: HarnessTelemetryContext,
): Promise<Disposer> {
  const rolloutPath =
    sessionDataPath(context.sessionData, host) ??
    (await findSessionPath(host, context.sessionId, context.signal, context.artifact))
  if (!rolloutPath || context.signal.aborted) return () => undefined

  return codexHubs.subscribe(host, {
    subscriptionId: context.subscriptionId,
    sessionId: context.sessionId,
    resource: rolloutPath.path,
    signal: context.signal,
    emit: context.emit,
    parse: (record) => {
      const envelope = parseCodexUsageEnvelope(record)
      if (envelope?.type === 'session_meta') {
        if (
          typeof envelope.payload?.id === 'string' &&
          envelope.payload.id !== context.sessionId
        ) {
          context.identityDiverged?.()
        }
        return HEALTHY_HARNESS_TELEMETRY_RECORD
      }
      return parseCodexTokenCount(record)
    },
  })
}

export async function observeCodexUsage(
  host: ProjectHost,
  context: HarnessTelemetryContext,
): Promise<Disposer> {
  const providerId = asHarnessProviderId('codex')
  context.emit(
    usageStatusHarnessTelemetry({
      providerId,
      sessionId: context.sessionId,
      provenance: 'Codex cumulative usage lifecycle',
      usage: { status: 'pending', reason: 'Waiting for qualified Codex usage' },
    }),
  )
  if (!SESSION_ID.test(context.sessionId) || context.signal.aborted) {
    if (!context.signal.aborted) {
      context.emit(
        usageStatusHarnessTelemetry({
          providerId,
          sessionId: context.sessionId,
          provenance: 'Codex cumulative usage lifecycle',
          usage: { status: 'unavailable', reason: 'invalid-session-identity' },
        }),
      )
    }
    return () => undefined
  }

  let last: Extract<HarnessUsageSnapshot, { readonly status: 'available' }> | undefined
  let awaitingReplay = false
  let resetPending = false
  let hubStop: Disposer | undefined
  let retryTimer: ReturnType<typeof setTimeout> | undefined
  let retryMilliseconds = USAGE_ARTIFACT_RETRY_MS
  let resolving = false
  let stopped = false

  const scheduleRetry = (): void => {
    if (stopped || context.signal.aborted || retryTimer || hubStop) return
    const delay = retryMilliseconds
    retryMilliseconds = Math.min(MAX_USAGE_ARTIFACT_RETRY_MS, retryMilliseconds * 2)
    retryTimer = setTimeout(() => {
      retryTimer = undefined
      void resolveAndSubscribe().catch(() => scheduleRetry())
    }, delay)
  }

  const resolveAndSubscribe = async (): Promise<void> => {
    if (stopped || context.signal.aborted || resolving || hubStop) return
    resolving = true
    try {
      const rolloutPath =
        sessionDataPath(context.sessionData, host, context.sessionId) ??
        (await findSessionPath(host, context.sessionId, context.signal, context.artifact))
      if (!rolloutPath || context.signal.aborted || stopped) {
        scheduleRetry()
        return
      }
      let initial: HarnessUsageSnapshot
      try {
        initial = await scheduleHarnessUsageRead(host, context.signal, () =>
          snapshotCodexUsage(host, {
            ...context,
            sessionData: { rolloutPath },
          }),
        )
      } catch {
        initial = unavailableHarnessUsageSnapshot(providerId, 'artifact-unavailable')
      }
      if (stopped || context.signal.aborted) return
      if (initial.status === 'unavailable') {
        if (initial.reason === 'artifact-unavailable') {
          scheduleRetry()
          return
        }
        if (initial.reason === 'usage-unavailable') {
          context.emit(
            usageStatusHarnessTelemetry({
              providerId,
              sessionId: context.sessionId,
              provenance: 'Codex cumulative usage lifecycle',
              usage: { status: 'pending', reason: 'Waiting for Codex usage records' },
            }),
          )
        } else {
          context.emit(
            harnessUsageSnapshotTelemetry({
              snapshot: initial,
              sessionId: context.sessionId,
              provenance: 'Codex qualified cumulative usage snapshot',
            }),
          )
          return
        }
      } else {
        last = initial
        awaitingReplay = true
        context.emit(
          harnessUsageSnapshotTelemetry({
            snapshot: initial,
            sessionId: context.sessionId,
            provenance: 'Codex qualified cumulative usage snapshot',
          }),
        )
      }

      hubStop = codexHubs.subscribe(host, {
        subscriptionId: context.subscriptionId,
        sessionId: context.sessionId,
        resource: rolloutPath.path,
        signal: context.signal,
        emit: context.emit,
        exposeSessionIdentity: false,
        parse: (record) => {
          const envelope = parseCodexUsageEnvelope(record)
          if (envelope?.type === 'session_meta') {
            if (
              typeof envelope.payload?.id === 'string' &&
              envelope.payload.id !== context.sessionId
            ) {
              context.identityDiverged?.()
            }
            return HEALTHY_HARNESS_TELEMETRY_RECORD
          }
          if (
            envelope?.type !== 'event_msg' ||
            envelope.payload?.type !== 'token_count'
          ) {
            return null
          }
          const counters = normalizeCodexUsageCounters(
            envelope.payload.info?.total_token_usage,
          )
          if (!counters) return null
          const observedAt = Date.now()
          if (last && awaitingReplay) {
            if (usageCountersDecreased(last.counters, counters)) return null
            awaitingReplay = false
          }
          if (last && usageCountersDecreased(last.counters, counters)) {
            last = { ...last, observedAt, counters }
            resetPending = true
            return usageStatusHarnessTelemetry({
              providerId,
              sessionId: context.sessionId,
              provenance: 'Codex cumulative usage continuity',
              observedAt,
              usage: {
                status: 'reset',
                reason: 'Codex cumulative counters decreased',
              },
            })
          }
          if (last && usageCountersEqual(last.counters, counters)) {
            return resetPending
              ? null
              : (usageObservationHarnessTelemetry({
                  providerId,
                  sessionId: context.sessionId,
                  provenance: 'Codex rollout cumulative token_count event',
                  observedAt,
                  counters,
                  modelId: last.route.modelId,
                }) ?? null)
          }
          resetPending = false
          last = {
            version: 1,
            status: 'available',
            providerId,
            observedAt,
            route: last?.route ?? {},
            counters,
            timing: {},
          }
          return (
            usageObservationHarnessTelemetry({
              providerId,
              sessionId: context.sessionId,
              provenance: 'Codex rollout cumulative token_count event',
              observedAt,
              counters,
              modelId: last.route.modelId,
            }) ?? null
          )
        },
        followerHealth: (health) => {
          if (health.status === 'pending') {
            return last
              ? undefined
              : usageStatusHarnessTelemetry({
                  providerId,
                  sessionId: context.sessionId,
                  provenance: 'Codex cumulative usage lifecycle',
                  usage: {
                    status: 'pending',
                    reason: 'Waiting for Codex usage source',
                  },
                })
          }
          awaitingReplay = last !== undefined
          if (last) {
            const retained = harnessUsageValue(last.counters)
            if (retained) {
              return usageStatusHarnessTelemetry({
                providerId,
                sessionId: context.sessionId,
                provenance: 'Codex cumulative usage lifecycle',
                usage: {
                  status: 'stale',
                  value: retained.value,
                  observedAt: last.observedAt,
                  reason: `Codex usage follower ${health.reason}`,
                },
              })
            }
          }
          return usageStatusHarnessTelemetry({
            providerId,
            sessionId: context.sessionId,
            provenance: 'Codex cumulative usage lifecycle',
            usage: { status: 'unavailable', reason: health.reason },
          })
        },
      })
      retryMilliseconds = USAGE_ARTIFACT_RETRY_MS
    } finally {
      resolving = false
    }
  }

  await resolveAndSubscribe()
  const abort = (): void => stop()
  const stop = (): void => {
    if (stopped) return
    stopped = true
    context.signal.removeEventListener('abort', abort)
    if (retryTimer) clearTimeout(retryTimer)
    retryTimer = undefined
    void hubStop?.()
    hubStop = undefined
  }
  context.signal.addEventListener('abort', abort, { once: true })
  if (context.signal.aborted) stop()
  return stop
}

export function parseCodexTokenCount(value: string): HarnessTelemetry | null {
  try {
    const envelope = JSON.parse(value) as TokenCountEnvelope
    const usage = envelope.payload?.info?.last_token_usage
    const used = isNonNegativeFiniteNumber(usage?.total_tokens)
      ? usage.total_tokens
      : usage?.input_tokens
    const window = envelope.payload?.info?.model_context_window
    if (
      envelope.type !== 'event_msg' ||
      envelope.payload?.type !== 'token_count' ||
      !isNonNegativeFiniteNumber(used) ||
      !isPositiveFiniteNumber(window)
    ) {
      return null
    }
    return contextHarnessSnapshot({
      providerId: asHarnessProviderId('codex'),
      provenance: 'Codex rollout token_count event',
      context: {
        usedTokens: used,
        windowTokens: window,
        usedPercent: Math.min(100, Math.max(0, (used / window) * 100)),
      },
    })
  } catch {
    return null
  }
}

async function findSessionPath(
  host: ProjectHost,
  sessionId: string,
  signal: AbortSignal,
  artifact: HarnessTelemetryContext['artifact'],
): Promise<HostPath | undefined> {
  if (!SESSION_ID.test(sessionId)) return undefined
  try {
    const result = await host.exec(
      'sh',
      ['-c', FIND_SESSION_SCRIPT, 'hvir-codex-session', sessionId],
      {
        signal,
        maxBuffer: FIND_MAX_BUFFER,
        env: artifact.environment,
        unsetEnv: artifact.unsetEnvironment,
      },
    )
    if (result.code !== 0 || result.outputTruncated || signal.aborted) return undefined
    const paths = result.stdout.split('\0').filter(Boolean)
    return paths.length === 1 ? hostPath(host.hostId, paths[0] ?? '') : undefined
  } catch {
    return undefined
  }
}

function sessionDataPath(
  value: unknown,
  host: ProjectHost,
  sessionId?: string,
): HostPath | undefined {
  if (!value || typeof value !== 'object') return undefined
  const rolloutPath = (value as Partial<CodexSessionData>).rolloutPath
  return rolloutPath?.hostId === host.hostId &&
    typeof rolloutPath.path === 'string' &&
    (!sessionId || rolloutPath.path.endsWith(`-${sessionId}.jsonl`))
    ? rolloutPath
    : undefined
}

function parseCodexUsageEnvelope(value: string): CodexUsageEnvelope | undefined {
  try {
    const parsed = JSON.parse(value) as unknown
    return parsed && typeof parsed === 'object' ? parsed : undefined
  } catch {
    return undefined
  }
}

function normalizeCodexUsageCounters(
  value: CodexTokenUsage | undefined,
): HarnessUsageCounters | undefined {
  if (!value || typeof value !== 'object') return undefined
  const inputTokens = nonNegativeUsageCounter(value.input_tokens)
  const cacheReadInputTokens = nonNegativeUsageCounter(value.cached_input_tokens)
  const cacheWriteInputTokens = nonNegativeUsageCounter(value.cache_write_input_tokens)
  const outputTokens = nonNegativeUsageCounter(value.output_tokens)
  const freshInputTokens =
    inputTokens !== undefined &&
    cacheReadInputTokens !== undefined &&
    cacheWriteInputTokens !== undefined
      ? inputTokens - cacheReadInputTokens - cacheWriteInputTokens
      : undefined
  if (freshInputTokens !== undefined && freshInputTokens < 0) return undefined
  const reasoningTokens = nonNegativeUsageCounter(value.reasoning_output_tokens)
  const counters = {
    ...(freshInputTokens === undefined ? {} : { freshInputTokens }),
    ...(cacheReadInputTokens === undefined ? {} : { cacheReadInputTokens }),
    ...(cacheWriteInputTokens === undefined ? {} : { cacheWriteInputTokens }),
    ...(outputTokens === undefined ? {} : { outputTokens }),
    ...(reasoningTokens === undefined ? {} : { reasoningTokens }),
  }
  return Object.keys(counters).length > 0 ? counters : undefined
}

const codexHubs = new HarnessTelemetryHubRegistry({
  providerId: 'codex',
  remoteScript: FOLLOW_TOKEN_COUNTS_SCRIPT,
  parse: parseCodexTokenCount,
  followerHealth: (sessionId, health) => codexContextHealth(sessionId, health),
})

function codexContextHealth(
  sessionId: string,
  health: HarnessTelemetryFollowerHealth,
): HarnessTelemetry {
  const reason =
    health.status === 'pending'
      ? 'Waiting for Codex context telemetry'
      : health.reason === 'resource-invalid'
        ? 'Codex rollout unavailable'
        : health.reason === 'follower-exited'
          ? 'Codex context follower unavailable'
          : 'Codex context helper unavailable'
  return contextStatusHarnessSnapshot({
    providerId: asHarnessProviderId('codex'),
    provenance: 'Codex context telemetry lifecycle',
    context: { status: health.status, reason },
    sessionId,
  })
}

function isPositiveFiniteNumber(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value) && value > 0
}

function isNonNegativeFiniteNumber(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0
}
