// @vitest-environment happy-dom

import { afterEach, describe, expect, it, vi } from 'vitest'
import { createGhosttyTerminalPane } from '../src/renderer/src/terminal/ghostty-terminal-pane'
import { terminalThemeForAppearance } from '../src/renderer/src/terminal/terminal-palette'
import { ghosttyState } from './fixtures/ghostty-terminal-pane-mock'

vi.mock('ghostty-web', async () => {
  const { ghosttyWebMock } = await import('./fixtures/ghostty-terminal-pane-mock')
  const { FitAddon } = await vi.importActual<typeof import('ghostty-web')>('ghostty-web')
  return { ...ghosttyWebMock, FitAddon }
})

afterEach(() => ghosttyState.instances.splice(0))

describe('terminal adapter wheel ownership', () => {
  it('supplies shipped wheel choices and forwards engine reports exactly once', async () => {
    const pane = await createGhosttyTerminalPane(
      terminalThemeForAppearance('dark'),
      { fontFamily: 'monospace', fontSize: 13 },
      {
        cursorDefaults: { shape: 'block', blink: 'terminal' },
        ligatures: true,
        modifiedKeyProtocol: 'modify-other-keys',
        metaEnterAliasesControl: true,
        composerSubmitMode: 'enter',
      },
    )
    const container = document.createElement('div')
    pane.mount(container)
    const engine = ghosttyState.instances[0]!
    expect(engine.wheelScroll).toEqual({
      linesPerStep: 3,
      maxMouseReports: 5,
      maxFallbackKeys: 1,
      alternateScreenFallback: 'page',
      mouseEncoding: 'sgr',
    })
    const input = vi.fn()
    pane.events.onData(input)
    engine.emitData('\u001b[<65;1;1M')
    expect(input).toHaveBeenCalledExactlyOnceWith('\u001b[<65;1;1M', 'user')
    pane.dispose()
    engine.emitData('\u001b[6~')
    expect(input).toHaveBeenCalledOnce()
  })
})
