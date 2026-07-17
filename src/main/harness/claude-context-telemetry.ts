/** Structured Claude Code usage, isolated behind the harness adapter seam. */

import type { HarnessTelemetry } from '../../shared'
import type { Disposer, ProjectHost } from '../project-host'
import type { HarnessTelemetryContext } from './harness-provider'
import {
  buildTelemetryHubScript,
  HarnessTelemetryHubRegistry,
} from './harness-telemetry-hub'

const SESSION_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
const FOLLOW_USAGE_SCRIPT = buildTelemetryHubScript({
  prepareFollower: `
    root="\${CLAUDE_CONFIG_DIR:-\${HOME}/.claude}/projects"
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

export function observeClaudeContext(
  host: ProjectHost,
  context: HarnessTelemetryContext,
): Disposer {
  if (!SESSION_ID.test(context.sessionId) || context.signal.aborted) {
    return () => undefined
  }

  return claudeHubs.subscribe(host, {
    subscriptionId: context.subscriptionId,
    sessionId: context.sessionId,
    resource: '',
    signal: context.signal,
    emit: context.emit,
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
    return { contextUsedTokens: counts.reduce((total, count) => total + count, 0) }
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
