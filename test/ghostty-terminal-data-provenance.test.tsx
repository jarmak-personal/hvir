// @vitest-environment happy-dom

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { createGhosttyTerminalPane } from '../src/renderer/src/terminal/ghostty-terminal-pane'
import type { TerminalPaneDataSource } from '../src/renderer/src/terminal/terminal-pane'
import { terminalThemeForAppearance } from '../src/renderer/src/terminal/terminal-palette'
import { ghosttyState, ghosttyWebMock } from './fixtures/ghostty-terminal-pane-mock'

vi.mock('ghostty-web', async () => {
  const { ghosttyWebMock } = await import('./fixtures/ghostty-terminal-pane-mock')
  return ghosttyWebMock
})

beforeEach(() => {
  ghosttyState.instances.splice(0)
  vi.stubGlobal(
    'ResizeObserver',
    class {
      observe(): void {}
      disconnect(): void {}
    },
  )
})

afterEach(() => {
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
  document.body.replaceChildren()
})

async function openPane() {
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
  pane.setPresentation('hidden')
  pane.mount(document.body)
  const records: Array<{ data: string; source: TerminalPaneDataSource }> = []
  pane.events.onData((data, source) => records.push({ data, source }))
  return { pane, state: ghosttyState.instances[0]!, records }
}

describe('Ghostty data-source adaptation', () => {
  it('uses producer provenance for reentrant input while a write is active', async () => {
    const { pane, state, records } = await openPane()
    vi.spyOn(ghosttyWebMock.Terminal.prototype, 'write').mockImplementation(() => {
      state.emitData('reentrant user', 'user')
      state.emitData('\x1b[0n', 'terminal-response')
    })
    pane.write('output')
    expect(records).toEqual([
      { data: 'reentrant user', source: 'user' },
      { data: '\x1b[0n', source: 'terminal-response' },
    ])
    pane.dispose()
  })

  it('preserves deferred response provenance and byte order without a write stack', async () => {
    const { pane, state, records } = await openPane()
    pane.write('output')
    await Promise.resolve().then(() => state.emitData('\x1b[1;1R', 'terminal-response'))
    state.emitData('paste', 'user')
    expect(records).toEqual([
      { data: '\x1b[1;1R', source: 'terminal-response' },
      { data: 'paste', source: 'user' },
    ])
    pane.dispose()
  })

  it('releases the subscription and rejects an engine callback retained past disposal', async () => {
    const { pane, state, records } = await openPane()
    const lateCallback = state.emitData.bind(state)
    pane.dispose()
    state.emitData('unsubscribed', 'user')
    lateCallback('late response', 'terminal-response')
    await Promise.resolve().then(() => lateCallback('late user', 'user'))
    expect(records).toEqual([])
  })
})
