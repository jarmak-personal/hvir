// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest'
import { renderMermaid } from '../src/renderer/src/viewer/mermaid-client'
import { MERMAID_LIMITS } from '../src/shared/presentation/mermaid-contract'

afterEach(() => {
  Reflect.deleteProperty(window, 'hvir')
})

describe('viewer diagram request lifetime', () => {
  it('cancels the exact request and rejects completion after replacement', async () => {
    let finish!: (svg: string) => void
    const invoke = vi.fn(
      (_channel: string, _request: { id: string }) =>
        new Promise<string>((resolve) => {
          finish = resolve
        }),
    )
    const send = vi.fn()
    Object.defineProperty(window, 'hvir', { configurable: true, value: { invoke, send } })
    const controller = new AbortController()
    const result = renderMermaid('graph TD; A-->B', 'dark', controller.signal)
    const request = invoke.mock.calls[0]![1]
    controller.abort()
    finish('<svg><text>stale</text></svg>')
    await expect(result).rejects.toThrow('cancelled')
    expect(send).toHaveBeenCalledExactlyOnceWith('mermaid:cancel', { id: request.id })
  })

  it('rejects oversize input before IPC and removes abort subscriptions after success', async () => {
    const invoke = vi.fn().mockResolvedValue('<svg><text>Diagram label</text></svg>')
    const send = vi.fn()
    Object.defineProperty(window, 'hvir', { configurable: true, value: { invoke, send } })
    const controller = new AbortController()
    await expect(
      renderMermaid(
        'x'.repeat(MERMAID_LIMITS.sourceCharacters + 1),
        'dark',
        controller.signal,
      ),
    ).rejects.toThrow('limit')
    expect(invoke).not.toHaveBeenCalled()
    await expect(
      renderMermaid('graph TD; A-->B', 'light', controller.signal),
    ).resolves.toContain('Diagram label')
    controller.abort()
    expect(send).not.toHaveBeenCalled()
  })
})
