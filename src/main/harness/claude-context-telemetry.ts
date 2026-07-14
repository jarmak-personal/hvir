/** Structured Claude Code usage, isolated behind the harness adapter seam. */

import type { HarnessTelemetry } from '../../shared'
import type { Disposer, ProjectHost } from '../project-host'
import { BoundedLineReader } from './bounded-line-reader'
import type { HarnessTelemetryContext } from './harness-adapter'

const SESSION_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
const FOLLOW_USAGE_SCRIPT = `
umask 077
tmp_dir=$(mktemp -d "\${TMPDIR:-/tmp}/hvir-claude-context.XXXXXX") || exit 1
fifo="$tmp_dir/events"
mkfifo "$fifo" || { rm -rf "$tmp_dir"; exit 1; }
tail_pid=
filter_pid=
cleanup() {
  trap - EXIT TERM INT HUP
  [ -n "$tail_pid" ] && kill "$tail_pid" 2>/dev/null
  [ -n "$filter_pid" ] && kill "$filter_pid" 2>/dev/null
  rm -rf "$tmp_dir"
}
trap cleanup EXIT TERM INT HUP
root="\${CLAUDE_CONFIG_DIR:-\${HOME}/.claude}/projects"
session_id=$1
while :; do
  if [ -d "$root" ]; then
    match_count=0
    transcript=
    for candidate in "$root"/*/"$session_id.jsonl"; do
      [ -f "$candidate" ] || continue
      match_count=$((match_count + 1))
      transcript=$candidate
    done
    [ "$match_count" -gt 1 ] && exit 2
    [ "$match_count" -eq 1 ] && break
  fi
  sleep 1
done
tail -n 512 -F "$transcript" >"$fifo" 2>/dev/null &
tail_pid=$!
(
  while IFS= read -r line; do
    case "$line" in
      *'"type":"assistant"'*)
        case "$line" in
          *'"usage"'*) printf '%s\\n' "$line" ;;
        esac
        ;;
    esac
  done <"$fifo"
) &
filter_pid=$!
wait "$filter_pid"
`.trim()

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

  const stream = host.execStream('sh', [
    '-c',
    FOLLOW_USAGE_SCRIPT,
    'hvir-claude-context',
    context.sessionId,
  ])
  const lines = new BoundedLineReader((line) => {
    const telemetry = parseClaudeUsage(line)
    if (telemetry) context.emit(telemetry)
  })
  const disposers = [
    stream.onStdout((chunk) => lines.push(chunk)),
    stream.onError((error) => {
      if (!context.signal.aborted) {
        console.warn('[harness:claude-code] context observer unavailable', error)
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
