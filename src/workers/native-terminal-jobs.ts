import { NATIVE_TERMINAL_LIMITS } from '../shared/native-terminal'

type Priority = 'feed' | 'control'
export interface NativeTerminalJobLimits {
  commands: number
  commandsPerState: number
  queuedBytes: number
  queuedBytesPerState: number
}
interface Job {
  state: string
  bytes: number
  execute: () => Promise<unknown>
  resolve: (value: unknown) => void
  reject: (error: unknown) => void
}
interface StateJobs {
  count: number
  bytes: number
  feed: Job[]
  control: Job[]
}
const MAX_CONTROL_STREAK = 4

/** Utility-owned native work: one physical operation, bounded admission including
 * active work, and round-robin selection within each priority. No transport lives
 * here. execute must settle/retire any resource it receives after outer revocation;
 * rejecting its delivery promise on close does not cancel physical work. */
export class NativeTerminalJobs {
  private readonly limits: NativeTerminalJobLimits
  private readonly states = new Map<string, StateJobs>()
  private active: Job | undefined
  private closed: Error | undefined
  private count = 0
  private bytes = 0
  private lastState: string | undefined
  private controlStreak = 0

  constructor(limits: Partial<NativeTerminalJobLimits> = {}) {
    this.limits = {
      commands: limits.commands ?? NATIVE_TERMINAL_LIMITS.commands,
      commandsPerState:
        limits.commandsPerState ?? NATIVE_TERMINAL_LIMITS.commandsPerState,
      queuedBytes: limits.queuedBytes ?? NATIVE_TERMINAL_LIMITS.queuedBytes,
      queuedBytesPerState:
        limits.queuedBytesPerState ?? NATIVE_TERMINAL_LIMITS.queuedBytesPerState,
    }
    for (const key of Object.keys(this.limits) as (keyof NativeTerminalJobLimits)[])
      if (
        !Number.isSafeInteger(this.limits[key]) ||
        this.limits[key] < 1 ||
        this.limits[key] > NATIVE_TERMINAL_LIMITS[key]
      )
        throw new RangeError(`Invalid native terminal job limit: ${key}`)
  }

  get pendingCount(): number {
    return this.count
  }
  get queuedBytes(): number {
    return this.bytes
  }

  enqueue<T>(
    state: string,
    bytes: number,
    priority: Priority,
    execute: () => Promise<T>,
  ): Promise<T> {
    if (this.closed) return Promise.reject(this.closed)
    if (
      !Number.isSafeInteger(bytes) ||
      bytes < 0 ||
      (priority !== 'feed' && priority !== 'control')
    )
      return Promise.reject(new Error('Invalid native terminal job admission'))
    const existing = this.states.get(state)
    if (
      this.count >= this.limits.commands ||
      (existing?.count ?? 0) >= this.limits.commandsPerState ||
      bytes > this.limits.queuedBytes - this.bytes ||
      bytes > this.limits.queuedBytesPerState - (existing?.bytes ?? 0)
    )
      return Promise.reject(new Error('Native terminal job capacity exceeded'))
    return new Promise<T>((resolve, reject) => {
      const jobs = existing ?? { count: 0, bytes: 0, feed: [], control: [] }
      const job: Job = {
        state,
        bytes,
        execute,
        resolve: (value) => resolve(value as T),
        reject,
      }
      this.states.set(state, jobs)
      jobs[priority].push(job)
      jobs.count++
      jobs.bytes += bytes
      this.count++
      this.bytes += bytes
      this.pump()
    })
  }

  close(error: Error): void {
    if (this.closed) return
    this.closed = error
    for (const jobs of this.states.values()) {
      for (const queue of [jobs.feed, jobs.control]) {
        let job: Job | undefined
        while ((job = queue.shift())) {
          job.reject(error)
          this.release(job)
        }
      }
    }
    // Physical completion still owns the active slot, bytes and resource cleanup.
    this.active?.reject(error)
  }

  private release(job: Job): void {
    this.count--
    this.bytes -= job.bytes
    const jobs = this.states.get(job.state)!
    jobs.count--
    jobs.bytes -= job.bytes
    if (!jobs.count) this.states.delete(job.state)
  }

  private select(priority: Priority): Job | undefined {
    const states = [...this.states.keys()]
    const previous = this.lastState === undefined ? -1 : states.indexOf(this.lastState)
    for (let offset = 1; offset <= states.length; offset++) {
      const state = states[(previous + offset) % states.length]!
      const job = this.states.get(state)![priority].shift()
      if (!job) continue
      this.lastState = state
      this.controlStreak =
        priority === 'feed' ? 0 : Math.min(MAX_CONTROL_STREAK, this.controlStreak + 1)
      return job
    }
    return undefined
  }

  private pump(): void {
    if (this.active || this.closed) return
    const job =
      this.controlStreak >= MAX_CONTROL_STREAK
        ? (this.select('feed') ?? this.select('control'))
        : (this.select('control') ?? this.select('feed'))
    if (!job) return
    this.active = job
    let physical: Promise<unknown>
    try {
      physical = job.execute()
    } catch (error) {
      this.finish(job, false, error)
      return
    }
    void Promise.resolve(physical).then(
      (value) => this.finish(job, true, value),
      (error: unknown) => this.finish(job, false, error),
    )
  }

  private finish(job: Job, success: boolean, value: unknown): void {
    this.release(job)
    this.active = undefined
    if (success) job.resolve(value)
    else job.reject(value)
    this.pump()
  }
}
