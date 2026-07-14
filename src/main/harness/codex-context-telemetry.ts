/** Structured Codex context usage, isolated behind the harness adapter seam. */

import type { HarnessTelemetry, HostPath } from '../../shared'
import { hostPath } from '../../shared'
import type { Disposer, ProjectHost } from '../project-host'
import type { HarnessTelemetryContext } from './harness-adapter'
import { buildTelemetryHubScript, HarnessTelemetryHub } from './harness-telemetry-hub'

const SESSION_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
const FIND_SESSION_SCRIPT = `
root="\${CODEX_HOME:-\${HOME}/.codex}/sessions"
[ -d "$root" ] || exit 0
find "$root" -type f -name "rollout-*-$1.jsonl" -print0
`.trim()
const FOLLOW_TOKEN_COUNTS_SCRIPT = buildTelemetryHubScript(`
  [ "$follower_resource" != - ] || return 1
  decode_base64 "$follower_resource" >"$follower_dir/resource" || return 1
  mkfifo "$follower_dir/events" || return 1
  (
    tail_pid=
    cleanup_follower_process() {
      trap - EXIT TERM INT HUP
      [ -n "$tail_pid" ] && kill "$tail_pid" 2>/dev/null
      rm -f "$follower_dir/events"
    }
    trap cleanup_follower_process EXIT TERM INT HUP
    tail -n 512 -F -- "$(cat "$follower_dir/resource")" >"$follower_dir/events" 2>/dev/null &
    tail_pid=$!
    while IFS= read -r line; do
      case "$line" in
        *'"type":"event_msg"'*)
          case "$line" in
            *'"type":"token_count"'*) emit_frame "$follower_dir" "$line" ;;
          esac
          ;;
      esac
    done <"$follower_dir/events"
  ) &
  printf '%s' "$!" >"$follower_dir/pid"
`)
const FIND_MAX_BUFFER = 256 * 1024
const hubs = new WeakMap<ProjectHost, HarnessTelemetryHub>()

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
    (await findSessionPath(host, context.sessionId, context.signal))
  if (!rolloutPath || context.signal.aborted) return () => undefined

  const hub = getCodexHub(host)
  const stop = hub.subscribe({
    subscriptionId: context.subscriptionId,
    sessionId: context.sessionId,
    resource: rolloutPath.path,
    signal: context.signal,
    emit: context.emit,
  })
  return () => {
    void stop()
    if (hub.size === 0 && hubs.get(host) === hub) hubs.delete(host)
  }
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
    return {
      contextUsedTokens: used,
      contextWindowTokens: window,
      contextUsedPercent: Math.min(100, Math.max(0, (used / window) * 100)),
    }
  } catch {
    return null
  }
}

async function findSessionPath(
  host: ProjectHost,
  sessionId: string,
  signal: AbortSignal,
): Promise<HostPath | undefined> {
  if (!SESSION_ID.test(sessionId)) return undefined
  const result = await host.exec(
    'sh',
    ['-c', FIND_SESSION_SCRIPT, 'hvir-codex-session', sessionId],
    { signal, maxBuffer: FIND_MAX_BUFFER },
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

function getCodexHub(host: ProjectHost): HarnessTelemetryHub {
  let hub = hubs.get(host)
  if (!hub) {
    hub = new HarnessTelemetryHub(host, {
      adapterId: 'codex',
      remoteScript: FOLLOW_TOKEN_COUNTS_SCRIPT,
      parse: parseCodexTokenCount,
    })
    hubs.set(host, hub)
  }
  return hub
}

function isPositiveFiniteNumber(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value) && value > 0
}

function isNonNegativeFiniteNumber(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0
}
