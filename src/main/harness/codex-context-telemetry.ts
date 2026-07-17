/** Structured Codex context usage, isolated behind the harness adapter seam. */

import type { HarnessTelemetry, HostPath } from '../../shared'
import { asHarnessProviderId, contextHarnessSnapshot, hostPath } from '../../shared'
import type { Disposer, ProjectHost } from '../project-host'
import type { HarnessTelemetryContext } from './harness-provider'
import {
  buildTelemetryHubScript,
  HarnessTelemetryHubRegistry,
} from './harness-telemetry-hub'

const SESSION_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
const FIND_SESSION_SCRIPT = `
root="\${CODEX_HOME:-\${HOME}/.codex}/sessions"
[ -d "$root" ] || exit 0
find "$root" -type f -name "rollout-*-$1.jsonl" -print0
`.trim()
const FOLLOW_TOKEN_COUNTS_SCRIPT = buildTelemetryHubScript({
  prepareFollower: `
    [ "$follower_resource" != - ] || exit 1
    follower_source=$(decode_base64 "$follower_resource") || exit 1
  `,
  acceptRecord: `
      case "$line" in
        *'"type":"event_msg"'*)
          case "$line" in
            *'"type":"token_count"'*) emit_frame "$line" ;;
          esac
          ;;
      esac
  `,
})
const FIND_MAX_BUFFER = 256 * 1024

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
  })
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
  if (result.code !== 0) return undefined
  const paths = result.stdout.split('\0').filter(Boolean)
  return paths.length === 1 ? hostPath(host.hostId, paths[0] ?? '') : undefined
}

function sessionDataPath(value: unknown, host: ProjectHost): HostPath | undefined {
  if (!value || typeof value !== 'object') return undefined
  const rolloutPath = (value as Partial<CodexSessionData>).rolloutPath
  return rolloutPath?.hostId === host.hostId && typeof rolloutPath.path === 'string'
    ? rolloutPath
    : undefined
}

const codexHubs = new HarnessTelemetryHubRegistry({
  providerId: 'codex',
  remoteScript: FOLLOW_TOKEN_COUNTS_SCRIPT,
  parse: parseCodexTokenCount,
})

function isPositiveFiniteNumber(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value) && value > 0
}

function isNonNegativeFiniteNumber(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0
}
