import { net, type BrowserWindow } from 'electron'

import type { HostPath } from '../../shared'
import type { HtmlPreviewProtocol } from '../html-preview-protocol'
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
  readonly htmlPreviews: HtmlPreviewProtocol
  readonly root: HostPath
  readonly checkpoint: (checkpoint: SmokeFailureCheckpoint) => void
}): Promise<string> {
  const { win, resources, htmlPreviews, root, checkpoint } = options
  const ownerId = win.webContents.id
  let current: RendererOwner | undefined
  let destructionPreviewUrl: string | undefined
  try {
    current = resources.currentOwner(ownerId)
    // Renderer recovery owns the real replacement-document proof. This focused
    // boundary proves the independent BrowserWindow destruction transition.
    const destructionPreview = htmlPreviews.create(
      '<p>renderer destruction authority</p>',
      current,
      root,
    )
    destructionPreviewUrl = destructionPreview.url
    const previewStatus = await runBoundedRendererAuthorityOperation(
      'renderer-authority-preview-fetch-awaiting',
      () => fetchPreviewStatus(destructionPreview.url),
      { checkpoint },
    )
    if (previewStatus !== 200) {
      throw new Error(`destruction preview did not open: status ${previewStatus}`)
    }
    checkpoint('renderer-authority-preview-available')

    await waitForElectronEvent(
      win,
      'destroyed',
      () => win.destroy(),
      'renderer-authority-destruction-awaiting',
      checkpoint,
    )
    checkpoint('renderer-authority-destroyed')
    await waitForRendererAuthorityCondition(
      'renderer-authority-preview-revocation-awaiting',
      () => previewRevokedAfterRuntimeSuspend(destructionPreview.url),
      'webContents destruction retained its HTML preview',
      checkpoint,
    )
    checkpoint('renderer-authority-preview-revoked')

    return `generation ${current.generation} · preview revoked on destruction`
  } catch (error) {
    const state = await collectFailureStateWithinDeadline({
      win,
      resources,
      current,
      destructionPreviewUrl,
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

function fetchPreviewStatus(url: string): Promise<number> {
  return net.fetch(url).then((response) => response.status)
}

async function previewRevokedAfterRuntimeSuspend(url: string): Promise<boolean> {
  try {
    return (await fetchPreviewStatus(url)) === 404
  } catch (error) {
    // Destroying the last window suspends the workbench and unregisters the
    // entire preview protocol. Electron reports that fail-closed result as an
    // unknown scheme on some platforms instead of routing one final 404.
    return error instanceof Error && error.message.includes('ERR_UNKNOWN_URL_SCHEME')
  }
}

async function collectFailureStateWithinDeadline(options: {
  readonly win: BrowserWindow
  readonly resources: RendererResourceScopes
  readonly current: RendererOwner | undefined
  readonly destructionPreviewUrl: string | undefined
}): Promise<unknown> {
  const diagnosis = Promise.resolve().then(async () => ({
    destroyed: options.win.isDestroyed(),
    currentGeneration: options.current?.generation,
    currentCurrent: options.current
      ? options.resources.isCurrent(options.current)
      : undefined,
    destructionPreview: await classifyPreviewStatus(
      options.destructionPreviewUrl,
      DEFAULT_TIMING.diagnosisTimeoutMs,
    ),
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

async function classifyPreviewStatus(
  url: string | undefined,
  timeoutMs: number,
): Promise<'not-created' | 'available' | 'revoked' | 'unavailable'> {
  if (!url) return 'not-created'
  try {
    const status = await withRendererAuthorityTimeout(
      fetchPreviewStatus(url),
      'failure-preview-status',
      timeoutMs,
    )
    if (status === 200) return 'available'
    if (status === 404) return 'revoked'
    return 'unavailable'
  } catch {
    return 'unavailable'
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
