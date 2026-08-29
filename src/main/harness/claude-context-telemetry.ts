/** Structured Claude Code usage, isolated behind the harness adapter seam. */

import {
  asHarnessProviderId,
  contextHarnessSnapshot,
  contextStatusHarnessSnapshot,
  type HarnessTelemetry,
} from '../../shared'
import type { Disposer, ProjectHost } from '../project-host'
import {
  harnessUsageSnapshotTelemetry,
  harnessUsageValue,
  nonNegativeUsageCounter,
  sumNonNegativeUsageCounters,
  unavailableHarnessUsageSnapshot,
  usageCountersDecreased,
  usageCountersEqual,
  usageStatusHarnessTelemetry,
  type HarnessUsageRoute,
  type HarnessUsageSnapshot,
  type HarnessUsageSnapshotContext,
} from './harness-usage'
import type { HarnessUsageCounters } from '../../shared'
import {
  boundedHarnessUsageString,
  scanHarnessUsageArtifactLines,
} from './harness-usage-artifact'
import { resolveClaudeSessionArtifact } from './claude-session-artifact'
import type { ClaudeSessionArtifactLocation } from './claude-session-artifact'
import type { HarnessTelemetryContext } from './harness-provider'
import {
  buildTelemetryHubScript,
  HEALTHY_HARNESS_TELEMETRY_RECORD,
  HarnessTelemetryHubRegistry,
} from './harness-telemetry-hub'
import type { HarnessTelemetryFollowerHealth } from './harness-telemetry-protocol'
import { scheduleHarnessUsageRead } from './harness-usage-read-scheduler'

const SESSION_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
const FOLLOW_USAGE_SCRIPT = buildTelemetryHubScript({
  prepareFollower: `
    [ "$follower_resource" != - ] || fail_follower resource-invalid
    follower_source=$(decode_base64 "$follower_resource") || fail_follower resource-invalid
    emit_follower_health pending awaiting-source || true
    while [ ! -e "$follower_source" ]; do
      sleep 1
    done
    [ -f "$follower_source" ] && [ -r "$follower_source" ] || fail_follower resource-invalid
  `,
  acceptRecord: `
      case "$line" in
        *'"type":"assistant"'*)
          case "$line" in
            *'"usage"'*) emit_frame "$line" ;;
          esac
          ;;
      esac
  `,
})
export const MAX_CLAUDE_CUMULATIVE_USAGE_RECORDS = 2_048
const USAGE_ARTIFACT_RETRY_MS = 250
const MAX_USAGE_ARTIFACT_RETRY_MS = 4_000
const USAGE_CONTINUITY_RESCAN_DELAY_MS = 1_000

interface ClaudeUsageEnvelope {
  readonly type?: unknown
  readonly isSidechain?: unknown
  readonly sessionId?: unknown
  readonly session_id?: unknown
  readonly requestId?: unknown
  readonly effort?: unknown
  readonly message?: {
    readonly id?: unknown
    readonly role?: unknown
    readonly model?: unknown
    readonly usage?: ClaudeUsageCounters
  }
}

interface ClaudeUsageCounters {
  readonly input_tokens?: unknown
  readonly cache_creation_input_tokens?: unknown
  readonly cache_read_input_tokens?: unknown
  readonly output_tokens?: unknown
}

export async function snapshotClaudeUsage(
  host: ProjectHost,
  context: HarnessUsageSnapshotContext,
): Promise<HarnessUsageSnapshot> {
  return (await readClaudeUsageObservation(host, context)).snapshot
}

interface ClaudeUsageObservation {
  readonly snapshot: HarnessUsageSnapshot
  readonly records?: ReadonlyMap<string, HarnessUsageCounters>
}

async function readClaudeUsageObservation(
  host: ProjectHost,
  context: HarnessUsageSnapshotContext,
  qualifiedLocation?: ClaudeSessionArtifactLocation,
): Promise<ClaudeUsageObservation> {
  const providerId = asHarnessProviderId('claude-code')
  if (!SESSION_ID.test(context.sessionId) || context.signal.aborted) {
    return {
      snapshot: unavailableHarnessUsageSnapshot(providerId, 'invalid-session-identity'),
    }
  }
  const location =
    qualifiedLocation ??
    (await resolveClaudeSessionArtifact(host, context, context.signal))
  if (!location || context.signal.aborted) {
    return {
      snapshot: unavailableHarnessUsageSnapshot(providerId, 'artifact-unavailable'),
    }
  }
  let identityMismatch = false
  let oversizedRecord = false
  let recordLimitExceeded = false
  let route: HarnessUsageRoute = {}
  const records = new Map<string, HarnessUsageCounters>()
  const artifact = await scanHarnessUsageArtifactLines(
    host,
    location.transcript,
    context.signal,
    {
      visit: (line) => {
        const envelope = parseClaudeUsageEnvelope(line)
        if (!envelope || !isClaudeAssistantUsage(envelope)) return
        const sessionIds = [envelope.sessionId, envelope.session_id].filter(
          (value): value is string => typeof value === 'string',
        )
        if (
          sessionIds.length === 0 ||
          sessionIds.some((sessionId) => sessionId !== context.sessionId)
        ) {
          identityMismatch = true
          return
        }
        const requestId = boundedHarnessUsageString(envelope.requestId)
        const messageId = boundedHarnessUsageString(envelope.message?.id)
        if (!requestId || !messageId) return
        const counters = normalizeClaudeUsageCounters(envelope.message?.usage)
        if (!counters) return
        const recordId = `${requestId}\0${messageId}`
        if (
          !records.has(recordId) &&
          records.size >= MAX_CLAUDE_CUMULATIVE_USAGE_RECORDS
        ) {
          recordLimitExceeded = true
          return
        }
        const modelId = boundedHarnessUsageString(envelope.message?.model)
        const reasoningEffort = boundedHarnessUsageString(envelope.effort, 64)
        route = {
          ...(modelId ? { modelId } : route.modelId ? { modelId: route.modelId } : {}),
          ...(reasoningEffort
            ? { reasoningEffort }
            : route.reasoningEffort
              ? { reasoningEffort: route.reasoningEffort }
              : {}),
        }
        records.set(recordId, counters)
      },
      oversized: () => {
        // Claude records are additive, so a skipped record makes the total unknowable.
        oversizedRecord = true
      },
    },
  )
  if (context.signal.aborted) {
    return {
      snapshot: unavailableHarnessUsageSnapshot(providerId, 'artifact-unavailable'),
    }
  }
  if (artifact.status === 'unavailable') {
    return {
      snapshot: unavailableHarnessUsageSnapshot(providerId, artifact.reason),
    }
  }

  if (identityMismatch) {
    return {
      snapshot: unavailableHarnessUsageSnapshot(providerId, 'invalid-session-identity'),
    }
  }
  if (oversizedRecord || recordLimitExceeded) {
    return {
      snapshot: unavailableHarnessUsageSnapshot(providerId, 'usage-unavailable'),
    }
  }
  if (records.size === 0) {
    return {
      snapshot: unavailableHarnessUsageSnapshot(providerId, 'usage-unavailable'),
      records,
    }
  }
  const counters = sumClaudeUsageCounters([...records.values()])
  if (Object.keys(counters).length === 0) {
    return {
      snapshot: unavailableHarnessUsageSnapshot(providerId, 'usage-unavailable'),
      records,
    }
  }
  return {
    snapshot: {
      version: 1,
      status: 'available',
      providerId,
      observedAt: Date.now(),
      route: {
        ...(route.modelId ? { modelId: route.modelId } : {}),
        ...(route.reasoningEffort ? { reasoningEffort: route.reasoningEffort } : {}),
      },
      counters,
      timing: {},
    },
    records,
  }
}

export async function observeClaudeContext(
  host: ProjectHost,
  context: HarnessTelemetryContext,
): Promise<Disposer> {
  if (!SESSION_ID.test(context.sessionId) || context.signal.aborted) {
    return () => undefined
  }
  context.emit(claudeContextHealth(context.sessionId, { status: 'pending' }))
  const location = await resolveClaudeSessionArtifact(host, context, context.signal)
  if (context.signal.aborted) return () => undefined
  if (!location) {
    context.emit(
      claudeContextHealth(context.sessionId, {
        status: 'unavailable',
        reason: 'locator-unavailable',
      }),
    )
    return () => undefined
  }

  let suppressInitialFollowerPending = true

  return claudeHubs.subscribe(host, {
    subscriptionId: context.subscriptionId,
    sessionId: context.sessionId,
    resource: location.transcript.path,
    signal: context.signal,
    emit: (telemetry) => {
      if (
        suppressInitialFollowerPending &&
        telemetry?.facets.context.status === 'pending'
      ) {
        suppressInitialFollowerPending = false
        return
      }
      suppressInitialFollowerPending = false
      context.emit(telemetry)
    },
  })
}

export async function observeClaudeUsage(
  host: ProjectHost,
  context: HarnessTelemetryContext,
): Promise<Disposer> {
  const providerId = asHarnessProviderId('claude-code')
  context.emit(
    usageStatusHarnessTelemetry({
      providerId,
      sessionId: context.sessionId,
      provenance: 'Claude Code cumulative usage lifecycle',
      usage: { status: 'pending', reason: 'Waiting for qualified Claude usage' },
    }),
  )
  if (!SESSION_ID.test(context.sessionId) || context.signal.aborted) {
    if (!context.signal.aborted) {
      context.emit(
        usageStatusHarnessTelemetry({
          providerId,
          sessionId: context.sessionId,
          provenance: 'Claude Code cumulative usage lifecycle',
          usage: { status: 'unavailable', reason: 'invalid-session-identity' },
        }),
      )
    }
    return () => undefined
  }
  const location = await waitForClaudeUsageLocation(host, context)
  if (!location || context.signal.aborted) {
    return () => undefined
  }

  let current: ClaudeUsageObservation
  try {
    current = await scheduleHarnessUsageRead(host, context.signal, () =>
      readClaudeUsageObservation(host, context, location),
    )
  } catch {
    current = {
      snapshot: unavailableHarnessUsageSnapshot(providerId, 'artifact-unavailable'),
    }
  }
  if (context.signal.aborted) return () => undefined

  let resetPending = false
  let stale = false
  let reading = false
  let dirty = false
  let identityInvalid = false
  let continuityTimer: ReturnType<typeof setTimeout> | undefined
  let observedTranscriptSize: number | undefined
  try {
    observedTranscriptSize = (await host.stat(location.transcript)).size
  } catch {
    // A pending follower can still observe a transcript that appears later.
  }
  const initialPending =
    current.snapshot.status === 'unavailable' &&
    (current.snapshot.reason === 'artifact-unavailable' ||
      (current.snapshot.reason === 'usage-unavailable' && current.records !== undefined))
  const initialTelemetry = initialPending
    ? usageStatusHarnessTelemetry({
        providerId,
        sessionId: context.sessionId,
        provenance: 'Claude Code cumulative usage lifecycle',
        usage: { status: 'pending', reason: 'Waiting for Claude usage records' },
      })
    : harnessUsageSnapshotTelemetry({
        snapshot: current.snapshot,
        sessionId: context.sessionId,
        provenance: 'Claude Code qualified cumulative usage snapshot',
      })
  context.emit(initialTelemetry)
  if (current.snapshot.status === 'unavailable' && !initialPending) {
    return () => undefined
  }

  const publishObservation = (next: ClaudeUsageObservation): void => {
    if (context.signal.aborted) return
    const previousAvailable =
      current.snapshot.status === 'available' ? current.snapshot : undefined
    const lostRecordContinuity = claudeUsageRecordsReplaced(current.records, next.records)
    if (
      previousAvailable &&
      (lostRecordContinuity ||
        (next.snapshot.status === 'available' &&
          usageCountersDecreased(previousAvailable.counters, next.snapshot.counters)))
    ) {
      current = next
      resetPending = true
      stale = false
      context.emit(
        usageStatusHarnessTelemetry({
          providerId,
          sessionId: context.sessionId,
          provenance: 'Claude Code cumulative usage continuity',
          usage: {
            status: 'reset',
            reason: lostRecordContinuity
              ? 'Claude usage transcript continuity changed'
              : 'Claude cumulative counters decreased',
          },
        }),
      )
      return
    }
    if (next.snapshot.status === 'unavailable') {
      const retained = previousAvailable && harnessUsageValue(previousAvailable.counters)
      if (retained && next.snapshot.reason === 'artifact-unavailable') {
        stale = true
        context.emit(
          usageStatusHarnessTelemetry({
            providerId,
            sessionId: context.sessionId,
            provenance: 'Claude Code cumulative usage lifecycle',
            usage: {
              status: 'stale',
              value: retained.value,
              observedAt: previousAvailable.observedAt,
              reason: next.snapshot.reason,
            },
          }),
        )
      } else {
        current = next
        context.emit(
          harnessUsageSnapshotTelemetry({
            snapshot: next.snapshot,
            sessionId: context.sessionId,
            provenance: 'Claude Code cumulative usage snapshot',
          }),
        )
      }
      return
    }
    const nextAvailable = next.snapshot
    const changed =
      !previousAvailable ||
      !usageCountersEqual(previousAvailable.counters, nextAvailable.counters)
    if (resetPending && !changed) return
    resetPending = false
    current = next
    if (!changed && !stale) return
    stale = false
    context.emit(
      harnessUsageSnapshotTelemetry({
        snapshot: nextAvailable,
        sessionId: context.sessionId,
        provenance: 'Claude Code cumulative usage snapshot',
      }),
    )
  }

  const requestObservation = (): void => {
    if (context.signal.aborted) return
    if (continuityTimer) return
    continuityTimer = setTimeout(() => {
      continuityTimer = undefined
      void host
        .stat(location.transcript)
        .then((stat) => {
          if (context.signal.aborted) return
          const replaced =
            observedTranscriptSize !== undefined && stat.size < observedTranscriptSize
          observedTranscriptSize = stat.size
          if (replaced) runObservation()
        })
        .catch(() => undefined)
    }, USAGE_CONTINUITY_RESCAN_DELAY_MS)
  }

  const runObservation = (): void => {
    if (context.signal.aborted) return
    if (reading) {
      dirty = true
      return
    }
    reading = true
    void scheduleHarnessUsageRead(host, context.signal, () =>
      readClaudeUsageObservation(host, context, location),
    )
      .then(publishObservation)
      .catch(() => {
        if (context.signal.aborted) return
        publishObservation({
          snapshot: unavailableHarnessUsageSnapshot(providerId, 'artifact-unavailable'),
        })
      })
      .finally(() => {
        reading = false
        if (dirty) {
          dirty = false
          runObservation()
        }
      })
  }

  const stopHub = claudeHubs.subscribe(host, {
    subscriptionId: context.subscriptionId,
    sessionId: context.sessionId,
    resource: location.transcript.path,
    signal: context.signal,
    emit: context.emit,
    exposeSessionIdentity: false,
    parse: (record) => {
      const envelope = parseClaudeUsageEnvelope(record)
      if (!envelope || !isClaudeAssistantUsage(envelope)) return null
      if (identityInvalid) return HEALTHY_HARNESS_TELEMETRY_RECORD
      const sessionIds = [envelope.sessionId, envelope.session_id].filter(
        (value): value is string => typeof value === 'string',
      )
      if (
        sessionIds.length === 0 ||
        sessionIds.some((sessionId) => sessionId !== context.sessionId)
      ) {
        identityInvalid = true
        current = {
          snapshot: unavailableHarnessUsageSnapshot(
            providerId,
            'invalid-session-identity',
          ),
        }
        return harnessUsageSnapshotTelemetry({
          snapshot: current.snapshot,
          sessionId: context.sessionId,
          provenance: 'Claude Code cumulative usage snapshot',
        })
      }
      const requestId = boundedHarnessUsageString(envelope.requestId)
      const messageId = boundedHarnessUsageString(envelope.message?.id)
      const counters = normalizeClaudeUsageCounters(envelope.message?.usage)
      if (!requestId || !messageId || !counters) return null
      requestObservation()
      const records = new Map(current.records ?? [])
      const recordId = `${requestId}\0${messageId}`
      const previousRecord = records.get(recordId)
      if (previousRecord && usageCountersEqual(previousRecord, counters)) {
        return HEALTHY_HARNESS_TELEMETRY_RECORD
      }
      if (!previousRecord && observedTranscriptSize !== undefined) {
        observedTranscriptSize += Buffer.byteLength(record, 'utf8') + 1
      }
      if (!previousRecord && records.size >= MAX_CLAUDE_CUMULATIVE_USAGE_RECORDS) {
        current = {
          snapshot: unavailableHarnessUsageSnapshot(providerId, 'usage-unavailable'),
          records,
        }
        return harnessUsageSnapshotTelemetry({
          snapshot: current.snapshot,
          sessionId: context.sessionId,
          provenance: 'Claude Code cumulative usage snapshot',
        })
      }
      records.set(recordId, counters)
      const previousSnapshot =
        current.snapshot.status === 'available' ? current.snapshot : undefined
      const aggregateCounters = previousRecord
        ? sumClaudeUsageCounters([...records.values()])
        : records.size === 1 || !previousSnapshot
          ? counters
          : sumClaudeUsageCounters([previousSnapshot.counters, counters])
      const modelId = boundedHarnessUsageString(envelope.message?.model)
      const reasoningEffort = boundedHarnessUsageString(envelope.effort, 64)
      const observedAt = Date.now()
      current = {
        snapshot: {
          version: 1,
          status: 'available',
          providerId,
          observedAt,
          route: {
            ...(modelId
              ? { modelId }
              : previousSnapshot?.route.modelId
                ? { modelId: previousSnapshot.route.modelId }
                : {}),
            ...(reasoningEffort
              ? { reasoningEffort }
              : previousSnapshot?.route.reasoningEffort
                ? { reasoningEffort: previousSnapshot.route.reasoningEffort }
                : {}),
          },
          counters: aggregateCounters,
          timing: {},
        },
        records,
      }
      stale = false
      if (previousRecord) {
        resetPending = true
        return usageStatusHarnessTelemetry({
          providerId,
          sessionId: context.sessionId,
          provenance: 'Claude Code cumulative usage continuity',
          observedAt,
          usage: {
            status: 'reset',
            reason: 'Claude usage transcript continuity changed',
          },
        })
      }
      resetPending = false
      return harnessUsageSnapshotTelemetry({
        snapshot: current.snapshot,
        sessionId: context.sessionId,
        provenance: 'Claude Code cumulative usage snapshot',
      })
    },
    followerHealth: (health) => {
      if (health.status === 'unavailable' && current.snapshot.status === 'available') {
        stale = true
      }
      return claudeUsageHealth(context.sessionId, current.snapshot, health)
    },
  })
  let stopped = false
  const abort = (): void => stop()
  const stop = (): void => {
    if (stopped) return
    stopped = true
    context.signal.removeEventListener('abort', abort)
    if (continuityTimer) clearTimeout(continuityTimer)
    continuityTimer = undefined
    void stopHub()
  }
  context.signal.addEventListener('abort', abort, { once: true })
  if (context.signal.aborted) stop()
  return stop
}

async function waitForClaudeUsageLocation(
  host: ProjectHost,
  context: HarnessTelemetryContext,
): Promise<ClaudeSessionArtifactLocation | undefined> {
  let retryMilliseconds = USAGE_ARTIFACT_RETRY_MS
  while (!context.signal.aborted) {
    const location = await resolveClaudeSessionArtifact(host, context, context.signal)
    if (location || context.signal.aborted) return location
    await abortableDelay(retryMilliseconds, context.signal)
    retryMilliseconds = Math.min(
      MAX_USAGE_ARTIFACT_RETRY_MS,
      retryMilliseconds * 2,
    )
  }
  return undefined
}

function abortableDelay(milliseconds: number, signal: AbortSignal): Promise<void> {
  if (signal.aborted) return Promise.resolve()
  return new Promise((resolve) => {
    const finish = (): void => {
      clearTimeout(timer)
      signal.removeEventListener('abort', finish)
      resolve()
    }
    const timer = setTimeout(finish, milliseconds)
    signal.addEventListener('abort', finish, { once: true })
  })
}

function claudeUsageRecordsReplaced(
  previous: ReadonlyMap<string, HarnessUsageCounters> | undefined,
  next: ReadonlyMap<string, HarnessUsageCounters> | undefined,
): boolean {
  if (!previous || previous.size === 0 || !next) return false
  for (const recordId of previous.keys()) {
    if (!next.has(recordId)) return true
  }
  return false
}

function claudeUsageHealth(
  sessionId: string,
  snapshot: HarnessUsageSnapshot,
  health: HarnessTelemetryFollowerHealth,
): HarnessTelemetry | undefined {
  const providerId = asHarnessProviderId('claude-code')
  if (health.status === 'pending') {
    return snapshot.status === 'available'
      ? undefined
      : usageStatusHarnessTelemetry({
          providerId,
          sessionId,
          provenance: 'Claude Code cumulative usage lifecycle',
          usage: { status: 'pending', reason: 'Waiting for Claude usage source' },
        })
  }
  const retained = snapshot.status === 'available' && harnessUsageValue(snapshot.counters)
  return retained
    ? usageStatusHarnessTelemetry({
        providerId,
        sessionId,
        provenance: 'Claude Code cumulative usage lifecycle',
        usage: {
          status: 'stale',
          value: retained.value,
          observedAt: snapshot.observedAt,
          reason: `Claude usage follower ${health.reason}`,
        },
      })
    : usageStatusHarnessTelemetry({
        providerId,
        sessionId,
        provenance: 'Claude Code cumulative usage lifecycle',
        usage: { status: 'unavailable', reason: health.reason },
      })
}

export function parseClaudeUsage(value: string): HarnessTelemetry | null {
  const envelope = parseClaudeUsageEnvelope(value)
  if (!envelope || !isClaudeAssistantUsage(envelope)) return null
  const counts = normalizeClaudeUsageCounters(envelope.message?.usage)
  if (
    !counts ||
    counts.freshInputTokens === undefined ||
    counts.cacheWriteInputTokens === undefined ||
    counts.cacheReadInputTokens === undefined ||
    counts.outputTokens === undefined
  ) {
    return null
  }
  return contextHarnessSnapshot({
    providerId: asHarnessProviderId('claude-code'),
    provenance: 'Claude Code transcript assistant usage',
    context: {
      usedTokens:
        counts.freshInputTokens +
        counts.cacheWriteInputTokens +
        counts.cacheReadInputTokens +
        counts.outputTokens,
    },
    modelId: boundedHarnessUsageString(envelope.message?.model),
  })
}

function parseClaudeUsageEnvelope(value: string): ClaudeUsageEnvelope | undefined {
  try {
    const parsed = JSON.parse(value) as unknown
    return parsed && typeof parsed === 'object' ? parsed : undefined
  } catch {
    return undefined
  }
}

function isClaudeAssistantUsage(envelope: ClaudeUsageEnvelope): boolean {
  return (
    envelope.type === 'assistant' &&
    envelope.message?.role === 'assistant' &&
    envelope.message.model !== '<synthetic>' &&
    envelope.isSidechain !== true &&
    !!envelope.message.usage
  )
}

function normalizeClaudeUsageCounters(
  usage: ClaudeUsageCounters | undefined,
): HarnessUsageCounters | undefined {
  if (!usage || typeof usage !== 'object') return undefined
  const freshInputTokens = nonNegativeUsageCounter(usage.input_tokens)
  const cacheWriteInputTokens = nonNegativeUsageCounter(usage.cache_creation_input_tokens)
  const cacheReadInputTokens = nonNegativeUsageCounter(usage.cache_read_input_tokens)
  const outputTokens = nonNegativeUsageCounter(usage.output_tokens)
  const counters = {
    ...(freshInputTokens === undefined ? {} : { freshInputTokens }),
    ...(cacheReadInputTokens === undefined ? {} : { cacheReadInputTokens }),
    ...(cacheWriteInputTokens === undefined ? {} : { cacheWriteInputTokens }),
    ...(outputTokens === undefined ? {} : { outputTokens }),
  }
  return Object.keys(counters).length > 0 ? counters : undefined
}

function sumClaudeUsageCounters(
  records: readonly HarnessUsageCounters[],
): HarnessUsageCounters {
  const freshInputTokens = sumKnownCounter(records, 'freshInputTokens')
  const cacheReadInputTokens = sumKnownCounter(records, 'cacheReadInputTokens')
  const cacheWriteInputTokens = sumKnownCounter(records, 'cacheWriteInputTokens')
  const outputTokens = sumKnownCounter(records, 'outputTokens')
  return {
    ...(freshInputTokens === undefined ? {} : { freshInputTokens }),
    ...(cacheReadInputTokens === undefined ? {} : { cacheReadInputTokens }),
    ...(cacheWriteInputTokens === undefined ? {} : { cacheWriteInputTokens }),
    ...(outputTokens === undefined ? {} : { outputTokens }),
  }
}

function sumKnownCounter(
  records: readonly HarnessUsageCounters[],
  name: keyof HarnessUsageCounters,
): number | undefined {
  const values: number[] = []
  for (const record of records) {
    const value = record[name]
    if (value === undefined) return undefined
    values.push(value)
  }
  return sumNonNegativeUsageCounters(values)
}

const claudeHubs = new HarnessTelemetryHubRegistry({
  providerId: 'claude-code',
  remoteScript: FOLLOW_USAGE_SCRIPT,
  parse: parseClaudeUsage,
  followerHealth: (sessionId, health) => claudeContextHealth(sessionId, health),
})

function claudeContextHealth(
  sessionId: string,
  health:
    | { readonly status: 'pending'; readonly reason?: 'awaiting-source' }
    | {
        readonly status: 'unavailable'
        readonly reason:
          'locator-unavailable' | 'resource-invalid' | 'follower-exited' | 'helper-exited'
      },
): HarnessTelemetry {
  const reason =
    health.status === 'pending'
      ? 'Waiting for Claude context telemetry'
      : health.reason === 'locator-unavailable'
        ? 'Claude context location unavailable'
        : health.reason === 'resource-invalid'
          ? 'Claude context transcript unavailable'
          : health.reason === 'follower-exited'
            ? 'Claude context follower unavailable'
            : 'Claude context helper unavailable'
  return contextStatusHarnessSnapshot({
    providerId: asHarnessProviderId('claude-code'),
    provenance: 'Claude Code context telemetry lifecycle',
    context: { status: health.status, reason },
    sessionId,
  })
}
