import type { SmokeFailureCheckpoint } from './failure-evidence.mts'

const OPERATION_TIMEOUT_MS = 30_000
const DIAGNOSIS_TIMEOUT_MS = 1_000

export interface ViewerPositionOperationTiming {
  readonly operationTimeoutMs: number
  readonly diagnosisTimeoutMs: number
}

export const DEFAULT_VIEWER_POSITION_OPERATION_TIMING: ViewerPositionOperationTiming = {
  operationTimeoutMs: OPERATION_TIMEOUT_MS,
  diagnosisTimeoutMs: DIAGNOSIS_TIMEOUT_MS,
}

type ViewerPositionCheckpoint = Extract<
  SmokeFailureCheckpoint,
  `viewer-position-${string}`
>

/** Bound one real-renderer operation while retaining its last semantic checkpoint. */
export async function runViewerPositionOperation<T>(options: {
  readonly awaiting: ViewerPositionCheckpoint
  readonly ready: ViewerPositionCheckpoint
  readonly checkpoint: (checkpoint: SmokeFailureCheckpoint) => void
  readonly execute: () => T | PromiseLike<T>
  readonly timing?: ViewerPositionOperationTiming
}): Promise<T> {
  const timing = options.timing ?? DEFAULT_VIEWER_POSITION_OPERATION_TIMING
  options.checkpoint(options.awaiting)
  const result = await withinDeadline(
    Promise.resolve().then(options.execute),
    timing.operationTimeoutMs,
    `${options.awaiting} timed out after ${timing.operationTimeoutMs}ms`,
  )
  options.checkpoint(options.ready)
  return result
}

/** Keep timeout diagnostics from becoming a second unbounded renderer operation. */
export async function collectViewerPositionFailureState(
  read: () => unknown,
  timing: ViewerPositionOperationTiming = DEFAULT_VIEWER_POSITION_OPERATION_TIMING,
): Promise<unknown> {
  try {
    return await withinDeadline(
      Promise.resolve().then(read),
      timing.diagnosisTimeoutMs,
      'viewer position diagnosis timed out',
    )
  } catch {
    return { unavailable: true }
  }
}

async function withinDeadline<T>(
  operation: Promise<T>,
  timeoutMs: number,
  message: string,
): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined
  try {
    return await Promise.race([
      operation,
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => reject(new Error(message)), timeoutMs)
      }),
    ])
  } finally {
    if (timer) clearTimeout(timer)
  }
}
