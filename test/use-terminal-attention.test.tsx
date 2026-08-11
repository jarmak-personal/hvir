// @vitest-environment happy-dom

import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { useTerminalAttention } from '../src/renderer/src/terminal/use-terminal-attention'

let host: HTMLDivElement
let root: Root
let attention: ReturnType<typeof useTerminalAttention>
let send: ReturnType<typeof vi.fn>

beforeEach(() => {
  host = document.createElement('div')
  document.body.append(host)
  root = createRoot(host)
  send = vi.fn()
  Object.defineProperty(window, 'hvir', {
    configurable: true,
    value: { send },
  })
  act(() => root.render(<TerminalAttentionProbe />))
})

afterEach(() => {
  act(() => root.unmount())
  host.remove()
  vi.restoreAllMocks()
})

describe('terminal attention rollup bridge', () => {
  it('updates Working presentation without sending non-actionable OS attention', () => {
    expect(send).toHaveBeenCalledOnce()
    expect(send).toHaveBeenLastCalledWith('app:attention', { count: 0 })

    act(() => {
      attention.updateRollup('workspace:local:/repo', {
        actionable: 0,
        working: 1,
      })
    })
    expect(host.textContent).toContain('"working":1')
    expect(send).toHaveBeenCalledOnce()

    act(() => {
      attention.updateRollup('workspace:local:/repo', {
        actionable: 0,
        working: 2,
      })
    })
    expect(host.textContent).toContain('"working":2')
    expect(send).toHaveBeenCalledOnce()

    act(() => {
      attention.updateRollup('workspace:local:/repo', {
        actionable: 1,
        working: 2,
      })
    })
    expect(send).toHaveBeenCalledTimes(2)
    expect(send).toHaveBeenLastCalledWith('app:attention', { count: 1 })
  })
})

function TerminalAttentionProbe() {
  attention = useTerminalAttention()
  return <output>{JSON.stringify(attention.rollups)}</output>
}
