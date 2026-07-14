/** Structured Codex context usage, isolated behind the harness adapter seam. */

import type { HarnessTelemetry, HostPath } from '../../shared'
import { hostPath } from '../../shared'
import type { Disposer, ProjectHost } from '../project-host'
import { BoundedLineReader } from './bounded-line-reader'
import type { HarnessTelemetryContext } from './harness-adapter'

const SESSION_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
const FIND_SESSION_SCRIPT = `
root="\${CODEX_HOME:-\${HOME}/.codex}/sessions"
[ -d "$root" ] || exit 0
find "$root" -type f -name "rollout-*-$1.jsonl" -print0
`.trim()
const FOLLOW_TOKEN_COUNTS_SCRIPT = `
umask 077
tmp_dir=$(mktemp -d "\${TMPDIR:-/tmp}/hvir-codex-context.XXXXXX") || exit 1
fifo="$tmp_dir/events"
mkfifo "$fifo" || { rmdir "$tmp_dir"; exit 1; }
tail_pid=
filter_pid=
cleanup() {
  trap - EXIT TERM INT HUP
  [ -n "$tail_pid" ] && kill "$tail_pid" 2>/dev/null
  [ -n "$filter_pid" ] && kill "$filter_pid" 2>/dev/null
  rm -f "$fifo"
  rmdir "$tmp_dir" 2>/dev/null
}
trap cleanup EXIT TERM INT HUP
tail -n 512 -F "$1" >"$fifo" 2>/dev/null &
tail_pid=$!
(
  while IFS= read -r line; do
    case "$line" in
      *'"type":"event_msg"'*)
        case "$line" in
          *'"type":"token_count"'*) printf '%s\\n' "$line" ;;
        esac
        ;;
    esac
  done <"$fifo"
) &
filter_pid=$!
wait "$filter_pid"
`.trim()
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
    (await findSessionPath(host, context.sessionId, context.signal))
  if (!rolloutPath || context.signal.aborted) return () => undefined

  const stream = host.execStream('sh', [
    '-c',
    FOLLOW_TOKEN_COUNTS_SCRIPT,
    'hvir-codex-context',
    rolloutPath.path,
  ])
  const lines = new BoundedLineReader((line) => {
    const telemetry = parseCodexTokenCount(line)
    if (telemetry) context.emit(telemetry)
  })
  const disposers = [
    stream.onStdout((chunk) => lines.push(chunk)),
    stream.onError((error) => {
      if (!context.signal.aborted) {
        console.warn('[harness:codex] context observer unavailable', error)
      }
    }),
  ]
  const abort = (): void => stream.dispose()
  context.signal.addEventListener('abort', abort, { once: true })

  return () => {
    context.signal.removeEventListener('abort', abort)
    for (const dispose of disposers) void dispose()
    stream.dispose()
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

function isPositiveFiniteNumber(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value) && value > 0
}

function isNonNegativeFiniteNumber(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0
}
