import type { Terminal as GhosttyTerminal } from 'ghostty-web'

import { calculateTerminalFit } from './terminal-fit'

const RESIZE_SETTLE_MS = 75

type FittableTerminal = Pick<GhosttyTerminal, 'cols' | 'element' | 'resize' | 'rows'> & {
  readonly renderer?: {
    getMetrics(): { readonly width: number; readonly height: number }
  }
}

/**
 * hvir-owned replacement for ghostty-web 0.4's FitAddon.
 *
 * That addon reserves 15px for a separate scrollbar even though ghostty-web
 * paints its scrollbar on the canvas, and it drops observations while its
 * resize lock is active. This controller uses the complete content box and
 * always schedules a trailing fit after layout settles.
 */
export class TerminalFitController {
  private observer: ResizeObserver | undefined
  private resizeTimer: number | undefined
  private resizeFrame: number | undefined
  private afterSettledFit: (() => void) | undefined
  private generation = 0
  private enabled = false
  private disposed = false

  constructor(private readonly terminal: FittableTerminal) {}

  fit(): void {
    if (this.disposed) return
    const element = this.terminal.element
    const metrics = this.terminal.renderer?.getMetrics()
    if (!element || !metrics) return
    const style = window.getComputedStyle(element)
    const dimensions = calculateTerminalFit({
      clientWidth: element.clientWidth,
      clientHeight: element.clientHeight,
      paddingTop: cssPixels(style.paddingTop),
      paddingRight: cssPixels(style.paddingRight),
      paddingBottom: cssPixels(style.paddingBottom),
      paddingLeft: cssPixels(style.paddingLeft),
      cellWidth: metrics.width,
      cellHeight: metrics.height,
    })
    if (
      !dimensions ||
      (dimensions.cols === this.terminal.cols && dimensions.rows === this.terminal.rows)
    ) {
      return
    }
    this.terminal.resize(dimensions.cols, dimensions.rows)
  }

  resume(afterSettledFit?: () => void): void {
    if (this.disposed) return
    this.enabled = true
    if (afterSettledFit) this.afterSettledFit = afterSettledFit
    if (!this.observer && this.terminal.element) {
      this.observer = new ResizeObserver(() => this.scheduleTrailingFit())
      this.observer.observe(this.terminal.element)
    }
    this.scheduleTrailingFit()
  }

  suspend(): void {
    if (this.disposed) return
    this.enabled = false
    this.generation += 1
    this.observer?.disconnect()
    this.observer = undefined
    this.cancelPendingFit()
    this.afterSettledFit = undefined
  }

  dispose(): void {
    if (this.disposed) return
    this.suspend()
    this.disposed = true
  }

  private cancelPendingFit(): void {
    if (this.resizeTimer !== undefined) window.clearTimeout(this.resizeTimer)
    if (this.resizeFrame !== undefined) window.cancelAnimationFrame(this.resizeFrame)
    this.resizeTimer = undefined
    this.resizeFrame = undefined
  }

  private scheduleTrailingFit(): void {
    if (!this.enabled || this.disposed) return
    this.cancelPendingFit()
    const generation = ++this.generation
    this.resizeTimer = window.setTimeout(() => {
      if (!this.enabled || this.disposed || generation !== this.generation) return
      this.resizeTimer = undefined
      this.resizeFrame = window.requestAnimationFrame(() => {
        if (!this.enabled || this.disposed || generation !== this.generation) return
        this.resizeFrame = undefined
        this.fit()
        const afterSettledFit = this.afterSettledFit
        this.afterSettledFit = undefined
        afterSettledFit?.()
      })
    }, RESIZE_SETTLE_MS)
  }
}

function cssPixels(value: string): number {
  const parsed = Number.parseFloat(value)
  return Number.isFinite(parsed) ? parsed : 0
}
