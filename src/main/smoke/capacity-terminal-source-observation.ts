import { PtyStreamAttachment } from '../pty/pty-stream-attachment'

export interface CapacityTerminalSourceReceipt {
  readonly pid: number
  readonly kind: string
  readonly sequence: number
  readonly row: number
  readonly columns: number
  readonly rows: number
  readonly receivedAtMs: number
}

const PREFIX = '\u001b]9999;hvir-capacity;'

/** Recognize only our fixed synthetic producer metadata. Retain no transcript;
 * partial headers retain their FIRST source receipt time across chunk splits. */
export class CapacityTerminalSourceObservation {
  private pending = ''
  private pendingAtMs = 0
  private readonly receipts = new Map<string, CapacityTerminalSourceReceipt>()

  consume(pid: number, data: string, receivedAtMs: number): void {
    const hadPending = this.pending.length > 0
    const combined = this.pending + data
    const previousLength = this.pending.length
    this.pending = ''
    const pattern =
      /^(initial|ready|output|echo|armed|resize|positioned);([0-9]{1,4});([0-9]{1,4});([0-9]{1,5});([0-9]{1,5})$/
    let cursor = 0
    for (;;) {
      const start = combined.indexOf(PREFIX, cursor)
      if (start < 0) break
      const end = combined.indexOf('\u0007', start + PREFIX.length)
      if (end < 0) break
      cursor = end + 1
      const match = pattern.exec(combined.slice(start + PREFIX.length, end))
      if (!match) continue
      const sequence = Number(match[2])
      const columns = Number(match[4]),
        rows = Number(match[5])
      if (columns > 65535 || rows > 65535) continue
      if (this.receipts.size >= 2048 && !this.receipts.has(match[1] + ':' + sequence))
        throw new Error('capacity-source-observation-bound')
      this.receipts.set(match[1] + ':' + sequence, {
        pid,
        kind: match[1]!,
        sequence,
        row: Number(match[3]),
        columns,
        rows,
        receivedAtMs:
          hadPending && start < previousLength ? this.pendingAtMs : receivedAtMs,
      })
    }
    // Keep only a partial owned metadata header (at most 128 characters).
    const last = combined.lastIndexOf(PREFIX)
    if (
      last >= 0 &&
      !combined.slice(last).includes('\u0007') &&
      combined.length - last <= 128
    ) {
      this.pending = combined.slice(last)
      this.pendingAtMs =
        hadPending && last < previousLength ? this.pendingAtMs : receivedAtMs
    } else {
      for (
        let length = Math.min(PREFIX.length - 1, combined.length);
        length > 0;
        length--
      ) {
        if (combined.endsWith(PREFIX.slice(0, length))) {
          this.pending = combined.slice(-length)
          this.pendingAtMs =
            hadPending && combined.length - length < previousLength
              ? this.pendingAtMs
              : receivedAtMs
          break
        }
      }
    }
  }

  get(kind: string, sequence: number): CapacityTerminalSourceReceipt | undefined {
    return this.receipts.get(kind + ':' + sequence)
  }
}

/** Observe the existing stream owner's immediate real source in this disposable
 * smoke. No PTY object, spawning method or transport lifetime is replaced. The
 * original listener still owns native ingress, replay and renderer delivery. */
export function observeCapacityTerminalSource() {
  let active = true
  const prototype = PtyStreamAttachment.prototype
  const descriptor = Object.getOwnPropertyDescriptor(prototype, 'start')
  const method: unknown = descriptor?.value
  if (typeof method !== 'function') throw new Error('capacity-source-owner-method')
  const original = method as PtyStreamAttachment['start']
  const observations = new Map<number, CapacityTerminalSourceObservation>()
  const wrapped: PtyStreamAttachment['start'] = function (
    this: PtyStreamAttachment,
    source,
    recordLaunchOutput,
    terminalOutput,
  ) {
    const pid: unknown = Reflect.get(source, 'pid')
    if (typeof pid !== 'number' || !Number.isSafeInteger(pid) || pid < 1)
      throw new Error('capacity-source-unqualified-real-process')
    const observation = new CapacityTerminalSourceObservation()
    observations.set(pid, observation)
    return original.call(
      this,
      {
        onData(listener) {
          return source.onData((data) => {
            if (active) observation.consume(pid, data, performance.now())
            listener(data)
          })
        },
      },
      recordLaunchOutput,
      terminalOutput,
    )
  }
  prototype.start = wrapped
  return {
    get(pid: number) {
      return observations.get(pid)
    },
    dispose() {
      active = false
      if (prototype.start === wrapped && descriptor)
        Object.defineProperty(prototype, 'start', descriptor)
      observations.clear()
    },
  }
}
