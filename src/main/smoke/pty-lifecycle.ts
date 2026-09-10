import type { Disposer } from '../../shared'
import type { ManagedPty, PtySupervisor } from '../pty/pty-supervisor'

type PtyLifecycleSupervisor = Pick<PtySupervisor, 'get' | 'kill' | 'onExit'>
type PtyOutputSupervisor = Pick<PtySupervisor, 'attach'>

const MAX_RETAINED_OUTPUT = 4_096

/** Finite progress observations, never terminal content or a readiness substitute. */
export interface PtyOutputWaitProgress {
  readonly phase:
    | 'attach-awaiting'
    | 'attach-returned'
    | 'trigger-awaiting'
    | 'trigger-returned'
    | 'first-output'
    | 'output-cap'
    | 'matched'
    | 'exited'
  /** Received character count, saturated at the existing retention bound. */
  readonly receivedCharacters: number
  readonly matched: boolean
}

export interface StopPtyOptions {
  readonly supervisor: PtyLifecycleSupervisor
  readonly terminal: ManagedPty
  readonly scenario: string
  readonly signal?: string
  readonly timeoutMs?: number
  readonly diagnosticProbeTimeoutMs?: number
  readonly probeChildLiveness?: (pid: number) => string | Promise<string>
}

export interface WaitForPtyOutputOptions {
  readonly supervisor: PtyOutputSupervisor
  readonly terminal: ManagedPty
  readonly expected: string
  readonly scenario: string
  /** Synchronous action that causes the expected output after attachment. */
  readonly trigger: () => void
  readonly onProgress?: (progress: PtyOutputWaitProgress) => void
  readonly timeoutMs?: number
  readonly signal?: AbortSignal
}

/** Await semantic PTY output through the production stream and retain bounded diagnostics. */
export async function waitForPtyOutput(
  options: WaitForPtyOutputOptions,
): Promise<string> {
  const { supervisor, terminal, expected, scenario, trigger } = options
  let retainedOutput = ''
  let settled = false
  let receivedCharacters = 0
  let matchedOutput = false
  let timer: ReturnType<typeof setTimeout> | undefined
  let rejectWait: (reason: Error) => void = () => undefined
  const abort = () => rejectWait(new Error(`${scenario} output wait interrupted`))
  const report = (phase: PtyOutputWaitProgress['phase']) =>
    options.onProgress?.({ phase, receivedCharacters, matched: matchedOutput })
  let disposeOutput: Disposer = () => undefined
  let primaryFailure: unknown
  let hasPrimaryFailure = false

  try {
    const outputEvent = new Promise<void>((resolve, reject) => {
      rejectWait = (reason) => {
        if (settled) return
        settled = true
        reject(reason)
      }
      timer = setTimeout(
        () =>
          rejectWait(
            new Error(
              `${scenario} timed out awaiting PTY acknowledgement (receivedCharacters=${receivedCharacters})`,
            ),
          ),
        options.timeoutMs ?? 10_000,
      )
      options.signal?.addEventListener('abort', abort, { once: true })
      if (options.signal?.aborted) {
        abort()
        return
      }
      report('attach-awaiting')
      disposeOutput = supervisor.attach(
        terminal.id,
        terminal.ownerId,
        {
          onData: (data) => {
            const combined = `${retainedOutput}${data}`
            const matched = combined.includes(expected)
            retainedOutput = combined.slice(-MAX_RETAINED_OUTPUT)
            if (!settled) {
              const previousCharacters = receivedCharacters
              receivedCharacters = Math.min(
                MAX_RETAINED_OUTPUT,
                receivedCharacters + data.length,
              )
              if (previousCharacters === 0 && receivedCharacters > 0)
                report('first-output')
              if (
                previousCharacters < MAX_RETAINED_OUTPUT &&
                receivedCharacters === MAX_RETAINED_OUTPUT
              )
                report('output-cap')
            }
            if (matched && !settled) {
              settled = true
              matchedOutput = true
              report('matched')
              resolve()
            }
          },
          onExit: (exit) => {
            if (settled) return
            settled = true
            report('exited')
            reject(
              new Error(
                `${scenario} exited before expected output (` +
                  `terminalId=${terminal.id}, pid=${terminal.pid}, ` +
                  `exitCode=${exit.exitCode}, signal=${exit.signal ?? 'none'}, ` +
                  `retainedCharacters=${retainedOutput.length})`,
              ),
            )
          },
        },
        terminal.ownerGeneration,
      )
      report('attach-returned')
    })

    if (!settled) {
      report('trigger-awaiting')
      trigger()
      report('trigger-returned')
    }
    await outputEvent
  } catch (reason) {
    hasPrimaryFailure = true
    primaryFailure = reason
  } finally {
    if (timer) clearTimeout(timer)
    options.signal?.removeEventListener('abort', abort)
  }

  let cleanupFailure: unknown
  try {
    await disposeOutput()
  } catch (reason) {
    cleanupFailure = reason
  }

  if (hasPrimaryFailure) throw primaryFailure
  if (cleanupFailure !== undefined) {
    throw new Error(`${scenario} output subscription cleanup failed`, {
      cause: cleanupFailure,
    })
  }
  return retainedOutput
}

/** Stop a smoke PTY through its production supervisor and await its owning exit event. */
export async function stopPtyAndWaitForExit(options: StopPtyOptions): Promise<void> {
  const {
    supervisor,
    terminal,
    scenario,
    signal,
    timeoutMs = 5_000,
    diagnosticProbeTimeoutMs = 250,
    probeChildLiveness = processLiveness,
  } = options
  const startedAt = Date.now()
  let exitCallbackFired = false
  let disposeExit: Disposer = () => undefined
  let primaryFailure: unknown
  let hasPrimaryFailure = false

  try {
    const exitEvent = new Promise<void>((resolve) => {
      disposeExit = supervisor.onExit((info) => {
        if (info.id !== terminal.id) return
        exitCallbackFired = true
        resolve()
      })
    })

    supervisor.kill(terminal.id, terminal.ownerId, signal, terminal.ownerGeneration)
    if (!(await eventBeforeDeadline(exitEvent, timeoutMs))) {
      const childLiveness = await boundedLivenessProbe(
        () => probeChildLiveness(terminal.pid),
        diagnosticProbeTimeoutMs,
      )
      const elapsedMs = Date.now() - startedAt
      const supervisorMember = supervisor.get(terminal.id) !== undefined
      throw new Error(
        `${scenario} timed out (` +
          `terminalId=${terminal.id}, pid=${terminal.pid}, ` +
          `requestedSignal=${signal ?? 'default'}, elapsedMs=${elapsedMs}, ` +
          `exitCallbackFired=${exitCallbackFired}, ` +
          `supervisorMember=${supervisorMember}, childLiveness=${childLiveness})`,
      )
    }
  } catch (reason) {
    hasPrimaryFailure = true
    primaryFailure = reason
  }

  let cleanupFailure: unknown
  try {
    await disposeExit()
  } catch (reason) {
    cleanupFailure = reason
  }

  // A cleanup defect must not replace the lifecycle failure that carries the
  // terminal's last observed state.
  if (hasPrimaryFailure) throw primaryFailure
  if (cleanupFailure !== undefined) {
    throw new Error(`${scenario} exit subscription cleanup failed`, {
      cause: cleanupFailure,
    })
  }
}

async function eventBeforeDeadline(
  event: Promise<void>,
  timeoutMs: number,
): Promise<boolean> {
  let timer: ReturnType<typeof setTimeout> | undefined
  try {
    return await Promise.race([
      event.then(() => true),
      new Promise<false>((resolve) => {
        timer = setTimeout(() => resolve(false), timeoutMs)
      }),
    ])
  } finally {
    if (timer) clearTimeout(timer)
  }
}

async function boundedLivenessProbe(
  probe: () => string | Promise<string>,
  timeoutMs: number,
): Promise<string> {
  let timer: ReturnType<typeof setTimeout> | undefined
  try {
    return await Promise.race([
      Promise.resolve()
        .then(probe)
        .catch((reason: unknown) => `unknown(probe-failed:${errorCode(reason)})`),
      new Promise<string>((resolve) => {
        timer = setTimeout(() => resolve('unknown(probe-timed-out)'), timeoutMs)
      }),
    ])
  } finally {
    if (timer) clearTimeout(timer)
  }
}

function processLiveness(pid: number): string {
  try {
    process.kill(pid, 0)
    return 'alive'
  } catch (reason) {
    const code = errorCode(reason)
    if (code === 'ESRCH') return 'not-alive'
    if (code === 'EPERM') return 'alive(permission-denied)'
    return `unknown(${code})`
  }
}

function errorCode(reason: unknown): string {
  if (
    typeof reason === 'object' &&
    reason !== null &&
    'code' in reason &&
    typeof reason.code === 'string'
  ) {
    return reason.code
  }
  return reason instanceof Error ? reason.name : 'non-error'
}
