import type { Disposer } from '../../shared'
import type { ManagedPty, PtySupervisor } from '../pty/pty-supervisor'

type PtyLifecycleSupervisor = Pick<PtySupervisor, 'get' | 'kill' | 'onExit'>

export interface StopPtyOptions {
  readonly supervisor: PtyLifecycleSupervisor
  readonly terminal: ManagedPty
  readonly scenario: string
  readonly signal?: string
  readonly timeoutMs?: number
  readonly diagnosticProbeTimeoutMs?: number
  readonly probeChildLiveness?: (pid: number) => string | Promise<string>
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
