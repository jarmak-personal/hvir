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
  readonly emit: (telemetry: HarnessTelemetry | undefined) => void
}

interface LiveSubscription extends HarnessTelemetrySubscription {
  admittedGeneration?: number
}

export interface HarnessTelemetryHubOptions {
  readonly providerId: string
  readonly remoteScript: string
  readonly parse: (record: string) => HarnessTelemetry | null
}

export interface TelemetryFollowerScript {
  /** Prepare `follower_source`, waiting for it when necessary. */
  readonly prepareFollower: string
  /** Inspect `$line` and call `emit_frame "$line"` for accepted records. */
  readonly acceptRecord: string
}

/**
 * Adapter-scoped host registry for lazy hubs.
 *
 * Keeping creation and empty-hub eviction here makes adapter observers only
 * responsible for exact session/resource discovery and record parsing.
 */
export class HarnessTelemetryHubRegistry {
  private readonly hubs = new WeakMap<ProjectHost, HarnessTelemetryHub>()

  constructor(private readonly options: HarnessTelemetryHubOptions) {}

  subscribe(host: ProjectHost, subscription: HarnessTelemetrySubscription): Disposer {
    let hub = this.hubs.get(host)
    if (!hub) {
      hub = new HarnessTelemetryHub(host, this.options, () => {
        if (this.hubs.get(host) === hub) this.hubs.delete(host)
      })
      this.hubs.set(host, hub)
    }
    return hub.subscribe(subscription)
  }
}

/**
 * One lazy, adapter-specific telemetry process per logical host.
 *
 * The protocol sends complete versioned subscription sets over stdin. The
 * temporary remote process owns adapter followers and emits bounded base64
 * frames; neither it nor this class escapes the HarnessProvider seam.
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
    private readonly onEmpty: () => void = () => undefined,
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
      if (this.subscriptions.size === 0) {
        this.stop()
        this.onEmpty()
      } else this.scheduleReconcile()
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
        `hvir-${this.options.providerId}-telemetry`,
        epoch,
      ],
      { keepStdinOpen: true },
    )
    this.epoch = epoch
    this.stream = stream
    for (const subscription of this.subscriptions.values()) {
      subscription.admittedGeneration = undefined
    }
    const lines = new BoundedLineReader(
      (line) => this.acceptFrame(stream, line),
      MAX_TELEMETRY_FRAME_LENGTH,
    )
    this.streamDisposers = [
      stream.onStdout((chunk) => lines.push(chunk)),
      stream.onStderr((chunk) => {
        if (this.stream === stream && chunk.trim()) {
          console.warn(
            `[harness:${this.options.providerId}] telemetry helper`,
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
    // Admit before writing: a newly-created remote follower can replay its
    // bounded history as soon as its S record arrives.
    for (const subscription of subscriptions) {
      subscription.admittedGeneration ??= generation
    }
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
    const frameGeneration = Number(rawGeneration)
    if (
      epoch !== this.epoch ||
      !Number.isSafeInteger(frameGeneration) ||
      frameGeneration < 1 ||
      frameGeneration > this.generation ||
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
    if (
      !subscription ||
      subscription.sessionId !== sessionId ||
      subscription.admittedGeneration === undefined ||
      frameGeneration < subscription.admittedGeneration
    ) {
      return
    }
    let record: string
    try {
      record = Buffer.from(encoded, 'base64').toString('utf8')
    } catch {
      return
    }
    if (Buffer.byteLength(record, 'utf8') > MAX_TELEMETRY_RESOURCE_BYTES * 2) return
    const telemetry = this.options.parse(record)
    if (!telemetry) return
    subscription.emit(telemetry)
  }

  private failStream(stream: ExecStreamHandle, error: Error): void {
    if (this.stream !== stream) return
    this.stream = undefined
    for (const dispose of this.streamDisposers.splice(0)) void dispose()
    stream.dispose()
    if (this.subscriptions.size === 0 || this.stopped) return
    for (const subscription of this.subscriptions.values()) {
      subscription.emit(undefined)
    }
    console.warn(`[harness:${this.options.providerId}] telemetry hub unavailable`, error)
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
      let settled = false
      let stopExit: Disposer = () => undefined
      const finish = (): void => {
        if (settled) return
        settled = true
        clearTimeout(forceTimer)
        void stopExit()
        stream.dispose()
      }
      const forceTimer = setTimeout(finish, 1_000)
      stopExit = stream.onExit(finish)
      void stream.end().catch(finish)
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
export function buildTelemetryHubScript(follower: TelemetryFollowerScript): string {
  return `
umask 077
epoch=$1
tmp_dir=$(mktemp -d "\${TMPDIR:-/tmp}/hvir-telemetry.XXXXXX") || exit 1
tab=$(printf '\\t')

decode_base64() {
  if printf '%s' "$1" | base64 -d 2>/dev/null; then return 0; fi
  printf '%s' "$1" | base64 -D 2>/dev/null
}

if printf '' | base64 -w 0 >/dev/null 2>&1; then
  encode_base64() { base64 -w 0; }
elif printf '' | base64 -b 0 >/dev/null 2>&1; then
  encode_base64() { base64 -b 0; }
else
  encode_base64() { base64 | tr -d '\\r\\n'; }
fi

clear_frame_lock() {
  expected_lock_owner=$1
  lock_owner=
  IFS= read -r lock_owner <"$tmp_dir/write.lock" 2>/dev/null || true
  if [ -n "$expected_lock_owner" ] && [ "$lock_owner" = "$expected_lock_owner" ]; then
    rm -f "$tmp_dir/write.lock"
  fi
}

release_frame_lock() {
  [ "$write_lock_owned" = 1 ] || return 0
  clear_frame_lock "$follower_subscription"
  write_lock_owned=0
}

acquire_frame_lock() {
  lock_attempt=0
  # Bound contention so a bad owner can delay one sample, never create an
  # unbounded remote fork loop. Reconcile teardown clears an owned lock within
  # the same 250 ms window.
  while [ "$lock_attempt" -lt 25 ]; do
    set -C
    if printf '%s\\n' "$follower_subscription" 2>/dev/null >"$tmp_dir/write.lock"; then
      set +C
      write_lock_owned=1
      return 0
    fi
    set +C

    # Heal an owner that died without running its trap (for example SIGKILL).
    lock_owner=
    IFS= read -r lock_owner <"$tmp_dir/write.lock" 2>/dev/null || true
    lock_pid=
    if [ -n "$lock_owner" ]; then
      IFS= read -r lock_pid <"$tmp_dir/sub-$lock_owner/pid" 2>/dev/null || true
    fi
    if [ "$lock_attempt" -ge 5 ] && { [ -z "$lock_pid" ] || ! kill -0 "$lock_pid" 2>/dev/null; }; then
      clear_frame_lock "$lock_owner"
    fi
    lock_attempt=$((lock_attempt + 1))
    sleep 0.01
  done
  return 1
}

emit_frame() {
  frame_line=$1
  [ "\${#frame_line}" -le 131072 ] || return 0
  frame_generation=
  IFS= read -r frame_generation <"$follower_dir/generation" || return 0
  frame_payload=$(printf '%s' "$frame_line" | encode_base64) || return 0
  acquire_frame_lock || return 0
  printf 'E\\t%s\\t%s\\t%s\\t%s\\t%s\\n' "$epoch" "$frame_generation" "$follower_subscription" "$follower_session" "$frame_payload"
  release_frame_lock
}

start_follower() {
  follower_dir=$1
  follower_subscription=$2
  follower_session=$3
  follower_resource=$4
  (
    tail_pid=
    write_lock_owned=0
    cleanup_follower_process() {
      trap - EXIT TERM INT HUP
      [ -n "$tail_pid" ] && kill "$tail_pid" 2>/dev/null
      release_frame_lock
      rm -f "$follower_dir/events" "$follower_dir/tail-pid"
    }
    trap cleanup_follower_process EXIT TERM INT HUP
${follower.prepareFollower}
    [ -n "$follower_source" ] || exit 1
    mkfifo "$follower_dir/events" || exit 1
    tail -n 512 -F -- "$follower_source" >"$follower_dir/events" 2>/dev/null &
    tail_pid=$!
    printf '%s\n' "$tail_pid" >"$follower_dir/tail-pid"
    while IFS= read -r line; do
${follower.acceptRecord}
    done <"$follower_dir/events"
  ) &
  printf '%s\\n' "$!" >"$follower_dir/pid"
}

stop_follower() {
  follower_dir=$1
  follower_subscription=
  IFS= read -r follower_subscription <"$follower_dir/subscription" 2>/dev/null || true
  if [ -f "$follower_dir/pid" ]; then
    follower_pid=
    IFS= read -r follower_pid <"$follower_dir/pid" 2>/dev/null || true
    kill "$follower_pid" 2>/dev/null
    kill -KILL "$follower_pid" 2>/dev/null
    wait "$follower_pid" 2>/dev/null
  fi
  tail_pid=
  IFS= read -r tail_pid <"$follower_dir/tail-pid" 2>/dev/null || true
  [ -n "$tail_pid" ] && kill "$tail_pid" 2>/dev/null
  clear_frame_lock "$follower_subscription"
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
      printf '%s\n' "$record_generation" >"$follower_dir/generation"
      if ! start_follower "$follower_dir" "$item_subscription" "$item_session" "$item_resource"; then
        stop_follower "$follower_dir"
        continue
      fi
    fi
    printf '%s\n' "$record_generation" >"$follower_dir/generation.next"
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
