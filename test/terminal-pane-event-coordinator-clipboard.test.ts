import { describe, expect, it } from 'vitest'

import { TerminalPaneEventCoordinator } from '../src/renderer/src/terminal/terminal-pane-event-coordinator'
import type { TerminalEvent } from '../src/renderer/src/terminal/terminal-pane'

describe('TerminalPaneEventCoordinator OSC 52 clipboard handling', () => {
  it('forwards the still-encoded payload, leaving decoding to clipboard policy', () => {
    const coordinator = new TerminalPaneEventCoordinator('fallback title')
    const data = Buffer.from('copied from a remote tmux', 'utf8').toString('base64')
    const event: TerminalEvent = {
      type: 'clipboard',
      operation: 'write',
      selection: 'c',
      data,
    }

    expect(coordinator.handle(event)).toEqual({
      clipboardWrite: { selection: 'c', data },
    })
  })

  it('never answers a clipboard read query', () => {
    const coordinator = new TerminalPaneEventCoordinator('fallback title')
    const event: TerminalEvent = {
      type: 'clipboard',
      operation: 'read',
      selection: 'c',
    }

    expect(coordinator.handle(event)).toBeUndefined()
  })
})
