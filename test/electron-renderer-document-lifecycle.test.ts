import { describe, expect, it, vi } from 'vitest'

const electron = vi.hoisted(() => ({
  frames: new Map<string, { detached: boolean }>(),
}))

vi.mock('electron', () => ({
  webFrameMain: {
    fromId: (processId: number, routingId: number) =>
      electron.frames.get(`${processId}:${routingId}`),
  },
}))

import { installRendererDocumentLifecycle } from '../src/main/window/electron-renderer-document-lifecycle'

const ENTRY = 'file:///application/renderer/index.html'

function fixture() {
  electron.frames.clear()
  electron.frames.set('20:30', { detached: false })
  const listeners = new Map<string, ((...args: unknown[]) => void)[]>()
  const mainFrame = {
    processId: 20,
    routingId: 30,
    isDestroyed: vi.fn(() => false),
  }
  const contents = {
    mainFrame,
    on: (event: string, listener: (...args: unknown[]) => void) => {
      const current = listeners.get(event) ?? []
      current.push(listener)
      listeners.set(event, current)
    },
  }
  const emit = (event: string, ...args: unknown[]): void => {
    for (const listener of listeners.get(event) ?? []) listener(...args)
  }
  const handlers = {
    started: vi.fn(),
    committed: vi.fn(),
    loaded: vi.fn(),
    failed: vi.fn(),
  }
  installRendererDocumentLifecycle(contents as never, ENTRY, handlers)
  return { emit, handlers, mainFrame }
}

describe('renderer document lifecycle adapter', () => {
  it('accepts only the current workbench main frame', () => {
    const { emit, handlers } = fixture()

    emit('did-start-navigation', {}, ENTRY, false, true, 10, 15)
    emit('did-frame-navigate', {}, ENTRY, -1, '', true, 10, 15)
    emit('did-frame-finish-load', {}, true, 10, 15)
    emit('did-fail-load', {}, -105, 'private', ENTRY, true, 10, 15)
    expect(handlers.started).not.toHaveBeenCalled()
    expect(handlers.committed).not.toHaveBeenCalled()
    expect(handlers.loaded).not.toHaveBeenCalled()
    expect(handlers.failed).not.toHaveBeenCalled()

    emit('did-start-navigation', {}, ENTRY, false, true, 20, 30)
    emit('did-frame-navigate', {}, ENTRY, -1, '', true, 20, 30)
    emit('did-frame-finish-load', {}, true, 20, 30)
    emit('did-fail-load', {}, -105, 'private', ENTRY, true, 20, 30)

    expect(handlers.started).toHaveBeenCalledOnce()
    expect(handlers.committed).toHaveBeenCalledOnce()
    expect(handlers.loaded).toHaveBeenCalledOnce()
    expect(handlers.failed).toHaveBeenCalledWith(-105, 'private', ENTRY)
  })

  it('rejects a destroyed current frame and unrelated navigation', () => {
    const { emit, handlers, mainFrame } = fixture()
    mainFrame.isDestroyed.mockReturnValue(true)

    emit('did-start-navigation', {}, 'https://example.com', false, true, 20, 30)
    emit('did-frame-finish-load', {}, true, 20, 30)

    expect(handlers.started).not.toHaveBeenCalled()
    expect(handlers.loaded).not.toHaveBeenCalled()
  })

  it('tracks a live provisional main frame through failure or commit', () => {
    const { emit, handlers, mainFrame } = fixture()
    electron.frames.set('20:40', { detached: false })

    emit('did-start-navigation', {}, ENTRY, false, true, 20, 40)
    emit('did-fail-load', {}, -105, 'private', ENTRY, true, 20, 40)

    expect(handlers.started).toHaveBeenCalledOnce()
    expect(handlers.failed).toHaveBeenCalledWith(-105, 'private', ENTRY)

    emit('did-start-navigation', {}, ENTRY, false, true, 20, 40)
    mainFrame.routingId = 40
    emit('did-frame-navigate', {}, ENTRY, -1, '', true, 20, 40)
    emit('did-frame-finish-load', {}, true, 20, 40)

    expect(handlers.started).toHaveBeenCalledTimes(2)
    expect(handlers.committed).toHaveBeenCalledOnce()
    expect(handlers.loaded).toHaveBeenCalledOnce()
  })
})
