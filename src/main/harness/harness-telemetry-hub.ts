import { randomUUID } from 'node:crypto'

import type { HarnessTelemetry } from '../../shared'
import type { Disposer, ExecStreamHandle, ProjectHost } from '../project-host'
import { BoundedLineReader } from './bounded-line-reader'

export const TELEMETRY_RECONCILE_DELAY_MS = 50
export const MAX_TELEMETRY_SUBSCRIPTIONS = 128
export const MAX_TELEMETRY_RESOURCE_BYTES = 64 * 1024
const MAX_TELEMETRY_FRAME_LENGTH = 256 * 1024
const RESTART_DELAY_MS = 250
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

export interface HarnessTelemetrySubscription {
  readonly subscriptionId: string
  readonly sessionId: string
  readonly resource: string
  readonly signal: AbortSignal
  readonly emit: (telemetry: HarnessTelemetry) => void
}

interface LiveSubscription extends HarnessTelemetrySubscription {
  latest?: HarnessTelemetry
}

export interface HarnessTelemetryHubOptions {
  readonly adapterId: string
  readonly remoteScript: string
  readonly parse: (record: string) => HarnessTelemetry | null
}

/**
 * One lazy, adapter-specific telemetry process per logical host.
 *
 * The protocol sends complete versioned subscription sets over stdin. The
 * temporary remote process owns adapter followers and emits bounded base64
 * frames; neither it nor this class escapes the HarnessAdapter seam.
 */
export class HarnessTelemetryHub {
  private readonly subscriptions = new Map<string, LiveSubscription>()
  private stream?: ExecStreamHandle
  private streamDisposers: Disposer[] = []
  private epoch = ''
  private generation = 0
  private reconcileTimer?: ReturnType<typeof setTimeout>
  private restartTimer?: ReturnType<typeof setTimeout>
  private reconcileRequested = false
  private flushing = false
  private stopped = false

  constructor(
    private readonly host: ProjectHost,
    private readonly options: HarnessTelemetryHubOptions,
  ) {}

  get size(): number {
    return this.subscriptions.size
  }

  subscribe(subscription: HarnessTelemetrySubscription): Disposer {
    this.validateSubscription(subscription)
    if (this.subscriptions.has(subscription.subscriptionId)) {
      throw new Error(
        `Telemetry subscription '${subscription.subscriptionId}' is already active`,
      )
    }
    this.stopped = false
    const live: LiveSubscription = { ...subscription }
    this.subscriptions.set(subscription.subscriptionId, live)
    const abort = (): void => dispose()
    let disposed = false
    const dispose = (): void => {
      if (disposed) return
      disposed = true
      subscription.signal.removeEventListener('abort', abort)
      if (this.subscriptions.get(subscription.subscriptionId) !== live) return
      this.subscriptions.delete(subscription.subscriptionId)
      if (this.subscriptions.size === 0) this.stop()
      else this.scheduleReconcile()
    }
    subscription.signal.addEventListener('abort', abort, { once: true })
    if (subscription.signal.aborted) {
      dispose()
      return dispose
    }
    this.ensureStream()
    this.scheduleReconcile()
    return dispose
  }

  dispose(): void {
    this.subscriptions.clear()
    this.stop()
  }

  private ensureStream(): void {
    if (this.stream || this.subscriptions.size === 0 || this.stopped) return
    if (this.restartTimer) {
      clearTimeout(this.restartTimer)
      this.restartTimer = undefined
    }
    const epoch = randomUUID()
    const stream = this.host.execStream(
      'sh',
      [
        '-c',
        this.options.remoteScript,
        `hvir-${this.options.adapterId}-telemetry`,
        epoch,
      ],
      { keepStdinOpen: true },
    )
    this.epoch = epoch
    this.stream = stream
    const lines = new BoundedLineReader(
      (line) => this.acceptFrame(stream, line),
      MAX_TELEMETRY_FRAME_LENGTH,
    )
    this.streamDisposers = [
      stream.onStdout((chunk) => lines.push(chunk)),
      stream.onStderr((chunk) => {
        if (this.stream === stream && chunk.trim()) {
          console.warn(
            `[harness:${this.options.adapterId}] telemetry helper`,
            chunk.trim(),
          )
        }
      }),
      stream.onError((error) => this.failStream(stream, error)),
      stream.onExit(() =>
        this.failStream(stream, new Error('Telemetry helper exited unexpectedly')),
      ),
    ]
    this.scheduleReconcile(0)
  }

  private scheduleReconcile(delayMs = TELEMETRY_RECONCILE_DELAY_MS): void {
    if (this.subscriptions.size === 0 || this.stopped) return
    this.reconcileRequested = true
    if (this.reconcileTimer || this.flushing) return
    this.reconcileTimer = setTimeout(() => {
      this.reconcileTimer = undefined
      void this.flushReconcile()
    }, delayMs)
  }

  private async flushReconcile(): Promise<void> {
    if (this.flushing || !this.reconcileRequested || this.stopped) return
    const stream = this.stream
    if (!stream || this.subscriptions.size === 0) return
    this.flushing = true
    this.reconcileRequested = false
    const generation = ++this.generation
    const subscriptions = [...this.subscriptions.values()]
    try {
      await stream.write(`R\t${generation}\t${subscriptions.length}\n`)
      for (const subscription of subscriptions) {
        const resource = Buffer.from(subscription.resource, 'utf8').toString('base64')
        await stream.write(
          `S\t${generation}\t${subscription.subscriptionId}\t${subscription.sessionId}\t${resource || '-'}\n`,
        )
      }
    } catch (error) {
      this.failStream(stream, asError(error))
    } finally {
      this.flushing = false
      if (this.reconcileRequested) this.scheduleReconcile(0)
    }
  }

  private acceptFrame(stream: ExecStreamHandle, line: string): void {
    if (this.stream !== stream) return
    const fields = line.split('\t')
    if (fields.length !== 6 || fields[0] !== 'E') return
    const [, epoch, rawGeneration, subscriptionId, sessionId, encoded] = fields
    if (
      epoch !== this.epoch ||
      rawGeneration !== String(this.generation) ||
      !subscriptionId ||
      !sessionId ||
      !encoded ||
      encoded.length > MAX_TELEMETRY_FRAME_LENGTH ||
      encoded.length % 4 !== 0 ||
      !/^[A-Za-z0-9+/]+={0,2}$/.test(encoded)
    ) {
      return
    }
    const subscription = this.subscriptions.get(subscriptionId)
    if (!subscription || subscription.sessionId !== sessionId) return
    let record: string
    try {
      record = Buffer.from(encoded, 'base64').toString('utf8')
    } catch {
      return
    }
    if (Buffer.byteLength(record, 'utf8') > MAX_TELEMETRY_RESOURCE_BYTES * 2) return
    const telemetry = this.options.parse(record)
    if (!telemetry) return
    subscription.latest = telemetry
    subscription.emit(telemetry)
  }

  private failStream(stream: ExecStreamHandle, error: Error): void {
    if (this.stream !== stream) return
    this.stream = undefined
    for (const dispose of this.streamDisposers.splice(0)) void dispose()
    stream.dispose()
    if (this.subscriptions.size === 0 || this.stopped) return
    console.warn(`[harness:${this.options.adapterId}] telemetry hub unavailable`, error)
    if (!this.restartTimer) {
      this.restartTimer = setTimeout(() => {
        this.restartTimer = undefined
        this.ensureStream()
      }, RESTART_DELAY_MS)
    }
  }

  private stop(): void {
    this.stopped = true
    this.reconcileRequested = false
    if (this.reconcileTimer) clearTimeout(this.reconcileTimer)
    if (this.restartTimer) clearTimeout(this.restartTimer)
    this.reconcileTimer = undefined
    this.restartTimer = undefined
    const stream = this.stream
    this.stream = undefined
    for (const dispose of this.streamDisposers.splice(0)) void dispose()
    if (stream) {
      void stream
        .end()
        .catch(() => undefined)
        .finally(() => stream.dispose())
    }
  }

  private validateSubscription(subscription: HarnessTelemetrySubscription): void {
    if (!UUID.test(subscription.subscriptionId) || !UUID.test(subscription.sessionId)) {
      throw new Error('Telemetry subscriptions require exact UUID identities')
    }
    if (this.subscriptions.size >= MAX_TELEMETRY_SUBSCRIPTIONS) {
      throw new Error(
        `Telemetry hub exceeds ${MAX_TELEMETRY_SUBSCRIPTIONS} subscription limit`,
      )
    }
    if (Buffer.byteLength(subscription.resource, 'utf8') > MAX_TELEMETRY_RESOURCE_BYTES) {
      throw new Error(
        `Telemetry resource exceeds ${MAX_TELEMETRY_RESOURCE_BYTES} byte limit`,
      )
    }
  }
}

/** Build the common temporary POSIX-shell hub around adapter-owned follower code. */
export function buildTelemetryHubScript(startFollowerBody: string): string {
  return `
umask 077
epoch=$1
tmp_dir=$(mktemp -d "\${TMPDIR:-/tmp}/hvir-telemetry.XXXXXX") || exit 1
tab=$(printf '\\t')

decode_base64() {
  if printf '%s' "$1" | base64 -d 2>/dev/null; then return 0; fi
  printf '%s' "$1" | base64 -D 2>/dev/null
}

emit_frame() {
  frame_dir=$1
  frame_line=$2
  [ "\${#frame_line}" -le 131072 ] || return 0
  frame_generation=$(cat "$frame_dir/generation") || return 0
  frame_subscription=$(cat "$frame_dir/subscription") || return 0
  frame_session=$(cat "$frame_dir/session") || return 0
  frame_payload=$(printf '%s' "$frame_line" | base64 | tr -d '\\r\\n') || return 0
  while ! mkdir "$tmp_dir/write.lock" 2>/dev/null; do sleep 0.01; done
  printf 'E\\t%s\\t%s\\t%s\\t%s\\t%s\\n' "$epoch" "$frame_generation" "$frame_subscription" "$frame_session" "$frame_payload"
  rmdir "$tmp_dir/write.lock" 2>/dev/null
}

start_follower() {
  follower_dir=$1
  follower_session=$2
  follower_resource=$3
${startFollowerBody}
}

stop_follower() {
  follower_dir=$1
  if [ -f "$follower_dir/pid" ]; then
    follower_pid=$(cat "$follower_dir/pid")
    kill "$follower_pid" 2>/dev/null
    wait "$follower_pid" 2>/dev/null
  fi
  rm -rf "$follower_dir"
}

cleanup() {
  trap - EXIT TERM INT HUP
  for follower_dir in "$tmp_dir"/sub-*; do
    [ -d "$follower_dir" ] && stop_follower "$follower_dir"
  done
  rm -rf "$tmp_dir"
}
trap cleanup EXIT TERM INT HUP

while IFS="$tab" read -r record_kind record_generation record_count record_extra; do
  [ "$record_kind" = R ] || continue
  case "$record_generation:$record_count" in *[!0-9:]*|:*|*:) continue ;; esac
  [ "$record_count" -le ${MAX_TELEMETRY_SUBSCRIPTIONS} ] || continue
  desired="$tmp_dir/desired"
  : >"$desired"
  valid=1
  index=0
  while [ "$index" -lt "$record_count" ]; do
    if ! IFS="$tab" read -r item_kind item_generation item_subscription item_session item_resource item_extra; then
      valid=0
      break
    fi
    case "$item_subscription:$item_session" in
      *[!0-9a-fA-F:-]*|:*|*:) valid=0 ;;
    esac
    if [ "$item_kind" != S ] || [ "$item_generation" != "$record_generation" ] || [ -n "$item_extra" ]; then
      valid=0
    fi
    printf '%s\\t%s\\t%s\\n' "$item_subscription" "$item_session" "$item_resource" >>"$desired"
    index=$((index + 1))
  done
  [ "$valid" -eq 1 ] || continue

  for follower_dir in "$tmp_dir"/sub-*; do
    [ -d "$follower_dir" ] && rm -f "$follower_dir/seen"
  done
  while IFS="$tab" read -r item_subscription item_session item_resource; do
    follower_dir="$tmp_dir/sub-$item_subscription"
    if [ -d "$follower_dir" ]; then
      old_session=$(cat "$follower_dir/session" 2>/dev/null)
      old_resource=$(cat "$follower_dir/resource-frame" 2>/dev/null)
      if [ "$old_session" != "$item_session" ] || [ "$old_resource" != "$item_resource" ]; then
        stop_follower "$follower_dir"
      fi
    fi
    if [ ! -d "$follower_dir" ]; then
      mkdir "$follower_dir" || continue
      printf '%s' "$item_subscription" >"$follower_dir/subscription"
      printf '%s' "$item_session" >"$follower_dir/session"
      printf '%s' "$item_resource" >"$follower_dir/resource-frame"
      printf '%s' "$record_generation" >"$follower_dir/generation"
      if ! start_follower "$follower_dir" "$item_session" "$item_resource"; then
        stop_follower "$follower_dir"
        continue
      fi
    fi
    printf '%s' "$record_generation" >"$follower_dir/generation.next"
    mv "$follower_dir/generation.next" "$follower_dir/generation"
    : >"$follower_dir/seen"
  done <"$desired"
  for follower_dir in "$tmp_dir"/sub-*; do
    [ -d "$follower_dir" ] || continue
    [ -f "$follower_dir/seen" ] || stop_follower "$follower_dir"
  done
done
`.trim()
}

function asError(reason: unknown): Error {
  return reason instanceof Error ? reason : new Error(String(reason))
}
