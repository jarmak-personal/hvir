import { describe, expect, it } from 'vitest'

import {
  verifyTerminalActivity,
  type TerminalPresentationSample,
} from '../src/main/smoke/capacity-terminals'

describe('capacity terminal presentation accounting', () => {
  it('distinguishes hidden parsing from visible presentation', () => {
    const before = samples()
    const after = before.map((sample, index) => ({
      ...sample,
      parsedWrites: sample.parsedWrites + (index >= 1 && index <= 3 ? 20 : 0),
      renderFrames: sample.renderFrames + (index === 0 ? 30 : 0),
    }))

    expect(
      verifyTerminalActivity(before, after, ['terminal-1', 'terminal-2', 'terminal-3']),
    ).toEqual({
      hiddenPanes: 11,
      hiddenParsedWrites: 60,
      hiddenPresentationFrames: 0,
      visiblePresentationFrames: 30,
    })
  })

  it('rejects a frame attributed to a hidden terminal', () => {
    const before = samples()
    const after = before.map((sample, index) => ({
      ...sample,
      parsedWrites: sample.parsedWrites + (index >= 1 && index <= 3 ? 1 : 0),
      renderFrames: sample.renderFrames + (index === 0 || index === 2 ? 1 : 0),
    }))

    expect(() =>
      verifyTerminalActivity(before, after, ['terminal-1', 'terminal-2', 'terminal-3']),
    ).toThrow('hidden terminal terminal-2 presented work')
  })
})

function samples(): readonly TerminalPresentationSample[] {
  return Array.from({ length: 12 }, (_, index) => ({
    sessionId: `terminal-${index}`,
    visible: index === 0,
    parsedWrites: 10,
    renderRequests: 12,
    renderFrames: 4,
    fullRenderFrames: 1,
    paused: index !== 0,
    pendingFrame: false,
  }))
}
