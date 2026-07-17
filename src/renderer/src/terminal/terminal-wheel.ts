const DOM_DELTA_PIXEL = 0
const DOM_DELTA_LINE = 1
const DOM_DELTA_PAGE = 2
const LINES_PER_WHEEL_STEP = 3
const FALLBACK_CELL_HEIGHT = 16
const MAX_SGR_REPORTS_PER_EVENT = 5

const PAGE_UP = '\x1b[5~'
const PAGE_DOWN = '\x1b[6~'

export interface TerminalWheelEvent {
  readonly deltaY: number
  readonly deltaMode: number
  readonly offsetX: number
  readonly offsetY: number
  readonly shiftKey: boolean
  readonly altKey: boolean
  readonly ctrlKey: boolean
}

export interface TerminalWheelState {
  readonly alternateScreen: boolean
  readonly mouseTracking: boolean
  readonly sgrMouse: boolean
  readonly cols: number
  readonly rows: number
  readonly cellWidth: number
  readonly cellHeight: number
}

export interface TerminalWheelResult {
  readonly handled: boolean
  readonly data: readonly string[]
}

type WheelRoute = 'page' | 'sgr'

const unhandled: TerminalWheelResult = { handled: false, data: [] }
const consumed: TerminalWheelResult = { handled: true, data: [] }

/**
 * Translate browser wheel input into bounded terminal input.
 *
 * Browser trackpads emit a gesture as many fractional pixel events. Keep their
 * remainder across events so distance, rather than browser event frequency,
 * determines when the terminal receives another navigation action.
 */
export class TerminalWheelController {
  private route: WheelRoute | undefined
  private remainder = 0

  handle(event: TerminalWheelEvent, state: TerminalWheelState): TerminalWheelResult {
    if (!Number.isFinite(event.deltaY) || event.deltaY === 0) return unhandled

    if (state.mouseTracking) {
      // SGR is the only mouse encoding we synthesize. Consuming unsupported
      // legacy modes is safer than injecting PageUp/PageDown or history arrows
      // into an application that explicitly requested mouse input.
      if (!state.sgrMouse) {
        this.reset()
        return consumed
      }

      const steps = this.consumeSteps(event, state.cellHeight, 'sgr')
      if (steps === 0) return consumed
      const { col, row } = wheelCell(event, state)
      const modifier =
        (event.shiftKey ? 4 : 0) + (event.altKey ? 8 : 0) + (event.ctrlKey ? 16 : 0)
      const button = (steps > 0 ? 65 : 64) + modifier
      const report = `\x1b[<${button};${col};${row}M`
      return {
        handled: true,
        data: Array.from({ length: Math.abs(steps) }, () => report),
      }
    }

    if (state.alternateScreen) {
      const steps = this.consumeSteps(event, state.cellHeight, 'page')
      if (steps === 0) return consumed
      return { handled: true, data: [steps > 0 ? PAGE_DOWN : PAGE_UP] }
    }

    // Normal-screen terminals own their local scrollback. Do not let a partial
    // alternate-screen gesture carry into a later mode change.
    this.reset()
    return unhandled
  }

  private consumeSteps(
    event: TerminalWheelEvent,
    cellHeight: number,
    route: WheelRoute,
  ): number {
    if (this.route !== route) {
      this.remainder = 0
      this.route = route
    }

    const delta = normalizedWheelDelta(event, cellHeight)
    if (this.remainder !== 0 && Math.sign(this.remainder) !== Math.sign(delta)) {
      this.remainder = 0
    }

    const total = this.remainder + delta
    const wholeSteps = Math.trunc(total)
    if (wholeSteps === 0) {
      this.remainder = total
      return 0
    }

    // Retain only the fractional distance. Very large synthetic or accelerated
    // events are bounded here rather than leaking their overflow into later
    // browser events.
    this.remainder = total - wholeSteps
    const limit = route === 'page' ? 1 : MAX_SGR_REPORTS_PER_EVENT
    return Math.max(-limit, Math.min(wholeSteps, limit))
  }

  private reset(): void {
    this.route = undefined
    this.remainder = 0
  }
}

function normalizedWheelDelta(event: TerminalWheelEvent, cellHeight: number): number {
  switch (event.deltaMode) {
    case DOM_DELTA_PAGE:
      return event.deltaY
    case DOM_DELTA_LINE:
      return event.deltaY / LINES_PER_WHEEL_STEP
    case DOM_DELTA_PIXEL:
    default: {
      const rowHeight =
        Number.isFinite(cellHeight) && cellHeight > 0 ? cellHeight : FALLBACK_CELL_HEIGHT
      return event.deltaY / (rowHeight * LINES_PER_WHEEL_STEP)
    }
  }
}

function wheelCell(
  event: Pick<TerminalWheelEvent, 'offsetX' | 'offsetY'>,
  state: Pick<TerminalWheelState, 'cols' | 'rows' | 'cellWidth' | 'cellHeight'>,
): { col: number; row: number } {
  const cellWidth =
    Number.isFinite(state.cellWidth) && state.cellWidth > 0 ? state.cellWidth : 1
  const cellHeight =
    Number.isFinite(state.cellHeight) && state.cellHeight > 0
      ? state.cellHeight
      : FALLBACK_CELL_HEIGHT
  const col =
    Math.floor((Number.isFinite(event.offsetX) ? event.offsetX : 0) / cellWidth) + 1
  const row =
    Math.floor((Number.isFinite(event.offsetY) ? event.offsetY : 0) / cellHeight) + 1
  const cols = Math.max(1, Math.trunc(state.cols))
  const rows = Math.max(1, Math.trunc(state.rows))
  return {
    col: Math.max(1, Math.min(col, cols)),
    row: Math.max(1, Math.min(row, rows)),
  }
}
