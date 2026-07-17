/** Structured Claude Code usage, isolated behind the harness adapter seam. */

import {
  asHarnessProviderId,
  contextHarnessSnapshot,
  type HarnessTelemetry,
} from '../../shared'
import type { Disposer, ProjectHost } from '../project-host'
import type { HarnessTelemetryContext } from './harness-provider'
import {
  buildTelemetryHubScript,
  HarnessTelemetryHubRegistry,
} from './harness-telemetry-hub'

const SESSION_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
const RESOLVE_TRANSCRIPT_ROOT_SCRIPT =
  'printf "%s" "${CLAUDE_CONFIG_DIR:-${HOME}/.claude}/projects"'
const FOLLOW_USAGE_SCRIPT = buildTelemetryHubScript({
  prepareFollower: `
    [ "$follower_resource" != - ] || exit 1
    root=$(decode_base64 "$follower_resource") || exit 1
    follower_source=
    while :; do
      if [ -d "$root" ]; then
        match_count=0
        for candidate in "$root"/*/"$follower_session.jsonl"; do
          [ -f "$candidate" ] || continue
          match_count=$((match_count + 1))
          follower_source=$candidate
        done
        [ "$match_count" -gt 1 ] && exit 2
        [ "$match_count" -eq 1 ] && break
      fi
      sleep 1
    done
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
  const transcriptRoot = await resolveTranscriptRoot(host, context)
  if (!transcriptRoot || context.signal.aborted) return () => undefined

  return claudeHubs.subscribe(host, {
    subscriptionId: context.subscriptionId,
    sessionId: context.sessionId,
    resource: transcriptRoot,
    signal: context.signal,
    emit: context.emit,
  })
}

async function resolveTranscriptRoot(
  host: ProjectHost,
  context: HarnessTelemetryContext,
): Promise<string | undefined> {
  const result = await host.exec('sh', ['-c', RESOLVE_TRANSCRIPT_ROOT_SCRIPT], {
    signal: context.signal,
    maxBuffer: 256 * 1024,
    env: context.artifact.environment,
    unsetEnv: context.artifact.unsetEnvironment,
  })
  if (result.code !== 0) return undefined
  const root = result.stdout
  return root.startsWith('/') && !root.includes('\0') && !root.includes('\n')
    ? root
    : undefined
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
})
