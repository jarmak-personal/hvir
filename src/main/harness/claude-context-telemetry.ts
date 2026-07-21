/** Structured Claude Code usage, isolated behind the harness adapter seam. */

import {
  asHarnessProviderId,
  contextHarnessSnapshot,
  contextStatusHarnessSnapshot,
  type HarnessTelemetry,
} from '../../shared'
import type { Disposer, ProjectHost } from '../project-host'
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
  readonly message?: {
    readonly role?: unknown
    readonly model?: unknown
    readonly usage?: {
      readonly input_tokens?: unknown
      readonly cache_creation_input_tokens?: unknown
      readonly cache_read_input_tokens?: unknown
      readonly output_tokens?: unknown
    }
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
  try {
    const envelope = JSON.parse(value) as ClaudeUsageEnvelope
    const usage = envelope.message?.usage
    if (
      envelope.type !== 'assistant' ||
      envelope.message?.role !== 'assistant' ||
      envelope.message.model === '<synthetic>' ||
      envelope.isSidechain === true ||
      !usage
    ) {
      return null
    }
    const counts = [
      usage.input_tokens,
      usage.cache_creation_input_tokens,
      usage.cache_read_input_tokens,
      usage.output_tokens,
    ]
    if (!counts.every(isNonNegativeFiniteNumber)) return null
    const model =
      typeof envelope.message.model === 'string' &&
      envelope.message.model.length > 0 &&
      envelope.message.model.length <= 160
        ? envelope.message.model
        : undefined
    return contextHarnessSnapshot({
      providerId: asHarnessProviderId('claude-code'),
      provenance: 'Claude Code transcript assistant usage',
      context: { usedTokens: counts.reduce((total, count) => total + count, 0) },
      modelId: model,
    })
  } catch {
    return null
  }
}

function isNonNegativeFiniteNumber(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0
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
