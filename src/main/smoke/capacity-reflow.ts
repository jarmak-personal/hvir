import { performance } from 'node:perf_hooks'
import type { BrowserWindow } from 'electron'

/** Fixed geometry shared by every parsing/reflow comparison. */
export const CAPACITY_REFLOW_WIDTHS = [1100, 1300] as const
export const CAPACITY_REFLOW_HEIGHT = 800

export interface CapacityReflowReport {
  readonly samplesMs: readonly number[]
  readonly columns: readonly number[]
  readonly p50Ms: number
  readonly p95Ms: number
  readonly maxMs: number
}

/**
 * Measures window resize through settled terminal geometry, not native reflow alone.
 * Main owns the finite deadline, so a blocked renderer cannot disable the timeout.
 * The scenario runner additionally owns process-tree termination if cleanup stalls.
 */
export async function measureCapacityReflow(
  win: BrowserWindow,
): Promise<CapacityReflowReport> {
  const samplesMs: number[] = []
  const columns: number[] = []
  const original = win.getContentSize()
  try {
    let previous = await readColumns(win)
    for (let index = 0; index < 12; index++) {
      // Start with the wide geometry: preparation starts at the narrow geometry.
      const width = CAPACITY_REFLOW_WIDTHS[(index + 1) % 2]!
      const started = performance.now()
      win.setContentSize(width, CAPACITY_REFLOW_HEIGHT)
      const deadline = started + 5000
      let current = previous
      while (current === previous) {
        if (performance.now() > deadline) {
          throw new Error('capacity reflow geometry did not change before deadline')
        }
        current = await readColumns(win)
        if (current === previous) await delay(20)
      }
      samplesMs.push(performance.now() - started)
      columns.push(current)
      previous = current
      // Fixed spacing makes the workload finite and identical across candidates.
      await delay(Math.max(0, 2000 - (performance.now() - started)))
    }
    const sorted = [...samplesMs].sort((left, right) => left - right)
    return {
      samplesMs,
      columns,
      p50Ms: sorted[Math.ceil(sorted.length * 0.5) - 1]!,
      p95Ms: sorted[Math.ceil(sorted.length * 0.95) - 1]!,
      maxMs: sorted.at(-1)!,
    }
  } finally {
    if (!win.isDestroyed()) win.setContentSize(original[0]!, original[1]!)
  }
}

async function readColumns(win: BrowserWindow): Promise<number> {
  let timeout: ReturnType<typeof setTimeout> | undefined
  try {
    const columns: unknown = await Promise.race([
      win.webContents.executeJavaScript(`
        document.querySelector('.terminal-surface.active .terminal-engine-host')
          ?.__hvirTerminalPerformance?.cols
      `),
      new Promise<never>((_resolve, reject) => {
        timeout = setTimeout(
          () => reject(new Error('capacity reflow renderer did not respond')),
          5000,
        )
      }),
    ])
    if (typeof columns !== 'number' || !Number.isInteger(columns) || columns <= 0) {
      throw new Error('capacity reflow has no live terminal geometry')
    }
    return columns
  } finally {
    if (timeout) clearTimeout(timeout)
  }
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}
