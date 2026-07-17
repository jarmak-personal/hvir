import { describe, expect, it } from 'vitest'

import {
  TerminalWheelController,
  type TerminalWheelEvent,
  type TerminalWheelState,
} from '../src/renderer/src/terminal/terminal-wheel'

const baseState: TerminalWheelState = {
  alternateScreen: false,
  mouseTracking: false,
  sgrMouse: false,
  cols: 80,
  rows: 24,
  cellWidth: 10,
  cellHeight: 10,
}

function wheel(
  deltaY: number,
  overrides: Partial<TerminalWheelEvent> = {},
): TerminalWheelEvent {
  return {
    deltaY,
    deltaMode: 1,
    offsetX: 0,
    offsetY: 0,
    shiftKey: false,
    altKey: false,
    ctrlKey: false,
    ...overrides,
  }
}

function state(overrides: Partial<TerminalWheelState> = {}): TerminalWheelState {
  return { ...baseState, ...overrides }
}

describe('terminal wheel behavior', () => {
  it('leaves normal-screen scrollback to the terminal engine', () => {
    const controller = new TerminalWheelController()

    expect(controller.handle(wheel(3), state())).toEqual({ handled: false, data: [] })
    expect(controller.handle(wheel(0), state({ alternateScreen: true }))).toEqual({
      handled: false,
      data: [],
    })
  })

  it('accumulates fractional trackpad distance before sending one page key', () => {
    const controller = new TerminalWheelController()
    const alternate = state({ alternateScreen: true })
    const pixels = { deltaMode: 0 }

    expect(controller.handle(wheel(10, pixels), alternate)).toEqual({
      handled: true,
      data: [],
    })
    expect(controller.handle(wheel(10, pixels), alternate)).toEqual({
      handled: true,
      data: [],
    })
    expect(controller.handle(wheel(10, pixels), alternate)).toEqual({
      handled: true,
      data: ['\x1b[6~'],
    })
  })

  it('bounds accelerated alternate-screen events to one page action', () => {
    const controller = new TerminalWheelController()
    const alternate = state({ alternateScreen: true })

    expect(controller.handle(wheel(300, { deltaMode: 0 }), alternate)).toEqual({
      handled: true,
      data: ['\x1b[6~'],
    })
    expect(controller.handle(wheel(-1, { deltaMode: 2 }), alternate)).toEqual({
      handled: true,
      data: ['\x1b[5~'],
    })
  })

  it('drops partial momentum when wheel direction reverses', () => {
    const controller = new TerminalWheelController()
    const alternate = state({ alternateScreen: true })

    expect(controller.handle(wheel(2), alternate).data).toEqual([])
    expect(controller.handle(wheel(-1), alternate).data).toEqual([])
    expect(controller.handle(wheel(-2), alternate).data).toEqual(['\x1b[5~'])
  })

  it('resets accumulated distance when local scrollback takes ownership', () => {
    const controller = new TerminalWheelController()
    const alternate = state({ alternateScreen: true })

    expect(controller.handle(wheel(2), alternate).data).toEqual([])
    expect(controller.handle(wheel(3), state()).handled).toBe(false)
    expect(controller.handle(wheel(1), alternate).data).toEqual([])
  })

  it('emits bounded SGR wheel reports with cell coordinates and modifiers', () => {
    const controller = new TerminalWheelController()
    const mouse = state({ mouseTracking: true, sgrMouse: true })

    expect(
      controller.handle(
        wheel(18, {
          offsetX: 24,
          offsetY: 35,
          ctrlKey: true,
        }),
        mouse,
      ),
    ).toEqual({
      handled: true,
      data: Array.from({ length: 5 }, () => '\x1b[<81;3;4M'),
    })

    expect(
      controller.handle(
        wheel(-3, {
          offsetX: 999,
          offsetY: -5,
          shiftKey: true,
          altKey: true,
        }),
        mouse,
      ).data,
    ).toEqual(['\x1b[<76;80;1M'])
  })

  it('consumes unsupported mouse encodings without injecting keyboard input', () => {
    const controller = new TerminalWheelController()
    const legacyMouse = state({
      alternateScreen: true,
      mouseTracking: true,
      sgrMouse: false,
    })

    expect(controller.handle(wheel(3), legacyMouse)).toEqual({ handled: true, data: [] })
  })
})
