/** Structured Claude Code usage, isolated behind the harness adapter seam. */

import {
  asHarnessProviderId,
  contextHarnessSnapshot,
  contextStatusHarnessSnapshot,
  type HarnessTelemetry,
} from '../../shared'
import type { Disposer, ProjectHost } from '../project-host'
import {
  unavailableHarnessUsageSnapshot,
  type HarnessUsageCounters,
  type HarnessUsageSnapshot,
  type HarnessUsageSnapshotContext,
} from './agent-work-usage'
import {
  boundedHarnessUsageString,
  nonNegativeUsageCounter,
  readHarnessUsageArtifact,
} from './harness-usage-artifact'
import { resolveClaudeSessionArtifact } from './claude-session-artifact'
import type { HarnessTelemetryContext } from './harness-provider'
import {
  buildTelemetryHubScript,
  HarnessTelemetryHubRegistry,
} from './harness-telemetry-hub'

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

interface QualifiedClaudeUsage {
  readonly counters: HarnessUsageCounters
  readonly modelId?: string
  readonly reasoningEffort?: string
}

export async function snapshotClaudeUsage(
  host: ProjectHost,
  context: HarnessUsageSnapshotContext,
): Promise<HarnessUsageSnapshot> {
  const providerId = asHarnessProviderId('claude-code')
  if (!SESSION_ID.test(context.sessionId) || context.signal.aborted) {
    return unavailableHarnessUsageSnapshot(providerId, 'invalid-session-identity')
  }
  const location = await resolveClaudeSessionArtifact(host, context, context.signal)
  if (!location || context.signal.aborted) {
    return unavailableHarnessUsageSnapshot(providerId, 'artifact-unavailable')
  }
  const artifact = await readHarnessUsageArtifact(
    host,
    location.transcript,
    context.signal,
  )
  if (artifact.status === 'unavailable') {
    return unavailableHarnessUsageSnapshot(providerId, artifact.reason)
  }

  let identityMismatch = false
  let route: Pick<QualifiedClaudeUsage, 'modelId' | 'reasoningEffort'> = {}
  const records = new Map<string, QualifiedClaudeUsage>()
  for (const line of artifact.content.split('\n')) {
    const envelope = parseClaudeUsageEnvelope(line)
    if (!envelope || !isClaudeAssistantUsage(envelope)) continue
    const sessionIds = [envelope.sessionId, envelope.session_id].filter(
      (value): value is string => typeof value === 'string',
    )
    if (
      sessionIds.length === 0 ||
      sessionIds.some((sessionId) => sessionId !== context.sessionId)
    ) {
      identityMismatch = true
      continue
    }
    const requestId = boundedHarnessUsageString(envelope.requestId)
    const messageId = boundedHarnessUsageString(envelope.message?.id)
    if (!requestId || !messageId) continue
    const counters = normalizeClaudeUsageCounters(envelope.message?.usage)
    if (!counters) continue
    route = {
      modelId: boundedHarnessUsageString(envelope.message?.model),
      reasoningEffort: boundedHarnessUsageString(envelope.effort, 64),
    }
    records.set(`${requestId}\0${messageId}`, {
      counters,
      ...route,
    })
  }

  if (identityMismatch) {
    return unavailableHarnessUsageSnapshot(providerId, 'invalid-session-identity')
  }
  if (records.size === 0) {
    return unavailableHarnessUsageSnapshot(providerId, 'usage-unavailable')
  }
  const selected = [...records.values()]
  const counters = sumClaudeUsageCounters(selected.map((record) => record.counters))
  return {
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
  let total = 0
  for (const record of records) {
    const value = record[name]
    if (value === undefined) return undefined
    total += value
  }
  return total
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
