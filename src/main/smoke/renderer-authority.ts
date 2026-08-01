import type { BrowserWindow } from 'electron'

import type { RendererOwner, RendererResourceScopes } from '../renderer-resource-scopes'
import type { SmokeFailureCheckpoint } from './failure-evidence.mts'

const OPERATION_TIMEOUT_MS = 10_000
const PREDICATE_TIMEOUT_MS = 2_000
const POLL_INTERVAL_MS = 25
const DIAGNOSIS_TIMEOUT_MS = 1_000

export interface RendererAuthorityTiming {
  readonly operationTimeoutMs: number
  readonly predicateTimeoutMs: number
  readonly pollIntervalMs: number
  readonly diagnosisTimeoutMs: number
}

const DEFAULT_TIMING: RendererAuthorityTiming = {
  operationTimeoutMs: OPERATION_TIMEOUT_MS,
  predicateTimeoutMs: PREDICATE_TIMEOUT_MS,
  pollIntervalMs: POLL_INTERVAL_MS,
  diagnosisTimeoutMs: DIAGNOSIS_TIMEOUT_MS,
}

interface BoundedOperationOptions {
  readonly timeoutMs?: number
  readonly checkpoint?: (checkpoint: SmokeFailureCheckpoint) => void
}

class RendererAuthorityTimeoutError extends Error {}

/** Exercise only the document and window transitions that require real Electron. */
export async function verifyRendererAuthorityLifecycle(options: {
  readonly win: BrowserWindow
  readonly resources: RendererResourceScopes
  readonly checkpoint: (checkpoint: SmokeFailureCheckpoint) => void
}): Promise<string> {
  const { win, resources, checkpoint } = options
  const ownerId = win.webContents.id
  let current: RendererOwner | undefined
  let resourceDisposed = false
  try {
    current = resources.currentOwner(ownerId)
    const owner = current
    // Renderer recovery owns replacement-document and route revocation. This
    // probe isolates the remaining real-Electron boundary: destroying the
    // BrowserWindow must revoke a resource owned by its renderer generation.
    resources.register(owner, { lifetime: 'renderer', type: 'filename-search' }, () => {
      resourceDisposed = true
    })
    checkpoint('renderer-authority-resource-registered')

    await waitForElectronEvent(
      win,
      'destroyed',
      () => win.destroy(),
      'renderer-authority-destruction-awaiting',
      checkpoint,
    )
    checkpoint('renderer-authority-destroyed')
    await waitForRendererAuthorityCondition(
      'renderer-authority-resource-revocation-awaiting',
      () => resourceDisposed && !resources.isCurrent(owner),
      'webContents destruction retained its renderer resource',
      checkpoint,
    )
    checkpoint('renderer-authority-resource-revoked')

    return `generation ${owner.generation} · resource revoked on destruction`
  } catch (error) {
    const state = await collectFailureStateWithinDeadline({
      win,
      resources,
      current,
      resourceDisposed,
    })
    throw new Error(
      `Renderer authority lifecycle failed: ${
        error instanceof Error ? error.message : String(error)
      }; state=${JSON.stringify(state)}`,
      { cause: error },
    )
  }
}

/** Run one named Electron boundary with its own deadline and semantic checkpoint. */
function runBoundedRendererAuthorityOperation<T>(
  operation: SmokeFailureCheckpoint,
  execute: () => T | PromiseLike<T>,
  options: BoundedOperationOptions = {},
): Promise<T> {
  options.checkpoint?.(operation)
  return withRendererAuthorityTimeout(
    Promise.resolve().then(execute),
    operation,
    options.timeoutMs ?? OPERATION_TIMEOUT_MS,
  )
}

async function waitForElectronEvent(
  win: BrowserWindow,
  event: 'destroyed',
  trigger: () => void,
  operation: SmokeFailureCheckpoint,
  checkpoint: (checkpoint: SmokeFailureCheckpoint) => void,
): Promise<void> {
  const target = win.webContents as unknown as {
    once(name: string, listener: () => void): void
    removeListener(name: string, listener: () => void): void
  }
  let completed: () => void = () => undefined
  try {
    await runBoundedRendererAuthorityOperation(
      operation,
      () =>
        new Promise<void>((resolve, reject) => {
          completed = resolve
          target.once(event, completed)
          try {
            trigger()
          } catch (error) {
            reject(error instanceof Error ? error : new Error(String(error)))
          }
        }),
      { checkpoint },
    )
  } finally {
    target.removeListener(event, completed)
  }
}

export async function waitForRendererAuthorityCondition(
  operation: SmokeFailureCheckpoint,
  predicate: () => boolean | Promise<boolean>,
  message: string,
  checkpoint: (checkpoint: SmokeFailureCheckpoint) => void,
  timing: RendererAuthorityTiming = DEFAULT_TIMING,
): Promise<void> {
  checkpoint(operation)
  const deadline = Date.now() + timing.operationTimeoutMs
  for (;;) {
    const remaining = deadline - Date.now()
    if (remaining <= 0) throw new Error(`${message} (${operation})`)
    try {
      if (
        await withRendererAuthorityTimeout(
          Promise.resolve().then(predicate),
          operation,
          Math.min(timing.predicateTimeoutMs, remaining),
        )
      ) {
        return
      }
    } catch (error) {
      if (error instanceof RendererAuthorityTimeoutError) throw error
      // Destruction may briefly reject work while native cleanup settles.
    }
    if (Date.now() >= deadline) throw new Error(`${message} (${operation})`)
    await delay(Math.min(timing.pollIntervalMs, deadline - Date.now()))
  }
}

async function collectFailureStateWithinDeadline(options: {
  readonly win: BrowserWindow
  readonly resources: RendererResourceScopes
  readonly current: RendererOwner | undefined
  readonly resourceDisposed: boolean
}): Promise<unknown> {
  const diagnosis = Promise.resolve().then(() => ({
    destroyed: options.win.isDestroyed(),
    currentGeneration: options.current?.generation,
    currentCurrent: options.current
      ? options.resources.isCurrent(options.current)
      : undefined,
    resourceDisposed: options.resourceDisposed,
  }))
  try {
    return await withRendererAuthorityTimeout(
      diagnosis,
      'failure-diagnosis',
      DEFAULT_TIMING.diagnosisTimeoutMs,
    )
  } catch {
    return 'diagnosis-timeout'
  }
}

async function withRendererAuthorityTimeout<T>(
  promise: Promise<T>,
  operation: string,
  timeoutMs: number,
): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(
          () =>
            reject(
              new RendererAuthorityTimeoutError(
                `Renderer authority ${operation} timed out after ${timeoutMs}ms`,
              ),
            ),
          timeoutMs,
        )
      }),
    ])
  } finally {
    if (timer) clearTimeout(timer)
  }
}

function delay(timeoutMs: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, timeoutMs))
}
