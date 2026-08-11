import { describe, expect, it, vi } from 'vitest'

import type { IpcRegistrar } from '../src/main/ipc/authority-router'
import { registerClipboardIpc } from '../src/main/ipc/features/clipboard'
import { MAX_CLIPBOARD_WRITE_TEXT } from '../src/shared'

describe('terminal clipboard write IPC', () => {
  it('writes qualified, bounded text to the system clipboard', async () => {
    const { handler, writeText, owner } = fixture()

    await handler({ text: 'copied from a remote tmux' })

    expect(owner).toHaveBeenCalledOnce()
    expect(writeText).toHaveBeenCalledExactlyOnceWith('copied from a remote tmux')
  })

  it('rejects an empty write instead of clearing the clipboard', async () => {
    const { handler, writeText } = fixture()

    await expect(handler({ text: '' })).rejects.toThrow('Invalid clipboard write')
    expect(writeText).not.toHaveBeenCalled()
  })

  it('rejects a non-string payload', async () => {
    const { handler, writeText } = fixture()

    await expect(handler({ text: 42 })).rejects.toThrow('Invalid clipboard write')
    expect(writeText).not.toHaveBeenCalled()
  })

  it('rejects text over the shared bound', async () => {
    const { handler, writeText } = fixture()

    await expect(
      handler({ text: 'a'.repeat(MAX_CLIPBOARD_WRITE_TEXT + 1) }),
    ).rejects.toThrow('Clipboard write exceeds the permitted size')
    expect(writeText).not.toHaveBeenCalled()
  })

  it('accepts text exactly at the bound', async () => {
    const { handler, writeText } = fixture()
    const text = 'b'.repeat(MAX_CLIPBOARD_WRITE_TEXT)

    await handler({ text })

    expect(writeText).toHaveBeenCalledExactlyOnceWith(text)
  })
})

function fixture() {
  const handlers = new Map<
    string,
    (request: unknown, context: { owner: () => unknown }) => unknown
  >()
  const owner = vi.fn(() => ({ id: 1, generation: 1 }))
  const context = { owner }
  const ipc = {
    handleSend: (
      channel: string,
      handler: (request: unknown, context: { owner: () => unknown }) => unknown,
    ) => {
      handlers.set(channel, handler)
    },
  } as unknown as IpcRegistrar
  const writeText = vi.fn()
  registerClipboardIpc(ipc, { systemClipboard: { writeText } })
  const handler = handlers.get('terminal:clipboard-write')
  if (!handler) throw new Error('Clipboard write handler was not registered')
  return {
    handler: async (request: unknown) => await handler(request, context),
    writeText,
    owner,
  }
}
