// @vitest-environment happy-dom

import { afterEach, describe, expect, it, vi } from 'vitest'
import { GHOSTTY_TERMINAL_CAPABILITY_PROFILE } from '../scripts/ghostty-terminal-capability-profile.mts'
import { createGhosttyTerminalPane } from '../src/renderer/src/terminal/ghostty-terminal-pane'
import { terminalThemeForAppearance } from '../src/renderer/src/terminal/terminal-palette'
import { ghosttyState } from './fixtures/ghostty-terminal-pane-mock'

const fitState: { options?: unknown } = vi.hoisted(() => ({}))

vi.mock('ghostty-web', async () => {
  const { ghosttyWebMock } = await import('./fixtures/ghostty-terminal-pane-mock')
  const { FitAddon } = await vi.importActual<typeof import('ghostty-web')>('ghostty-web')
  return {
    ...ghosttyWebMock,
    FitAddon: class extends FitAddon {
      constructor(options?: ConstructorParameters<typeof FitAddon>[0]) {
        super(options)
        fitState.options = options
      }
    },
  }
})

afterEach(() => ghosttyState.instances.splice(0))

describe('terminal adapter wheel ownership', () => {
  it('matches the capability profile options and forwards engine reports exactly once', async () => {
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
    const profile = GHOSTTY_TERMINAL_CAPABILITY_PROFILE
    expect(engine.wheelScroll).toEqual({
      linesPerStep: profile.mouseInput.linesPerStep,
      maxMouseReports: profile.mouseInput.maxMouseReports,
      maxFallbackKeys: profile.mouseInput.maxFallbackKeys,
      alternateScreenFallback: profile.mouseInput.alternateScreenFallback,
      mouseEncoding: 'sgr',
    })
    expect(profile.mouseInput.encoding).toBe(`${engine.wheelScroll!.mouseEncoding}-1006`)
    expect(fitState.options).toEqual({
      resizeDebounceMs: profile.fitting.resizeDebounceMs,
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
