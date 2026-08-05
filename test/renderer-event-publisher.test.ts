import { beforeEach, describe, expect, it, vi } from 'vitest'

const electron = vi.hoisted(() => ({
  windows: [] as Array<{
    isDestroyed: ReturnType<typeof vi.fn>
    webContents: {
      id: number
      isCrashed: ReturnType<typeof vi.fn>
      isDestroyed: ReturnType<typeof vi.fn>
      mainFrame: {
        isDestroyed: ReturnType<typeof vi.fn>
        postMessage: ReturnType<typeof vi.fn>
      }
    }
  }>,
}))

vi.mock('electron', () => ({
  BrowserWindow: { getAllWindows: () => electron.windows },
}))

import { RendererEventPublisher } from '../src/main/renderer-event-publisher'

const healthSnapshot = {
  version: 1,
  evidence: 'memory-only',
  items: [],
  dropped: 0,
} as const

function windowFixture(id: number) {
  return {
    isDestroyed: vi.fn(() => false),
    webContents: {
      id,
      isCrashed: vi.fn(() => false),
      isDestroyed: vi.fn(() => false),
      mainFrame: {
        isDestroyed: vi.fn(() => false),
        postMessage: vi.fn(),
      },
    },
  }
}

describe('RendererEventPublisher', () => {
  beforeEach(() => {
    electron.windows = []
  })

  it('broadcasts only to live renderer processes', () => {
    const alive = windowFixture(1)
    const crashed = windowFixture(2)
    const destroyedContents = windowFixture(3)
    crashed.webContents.isCrashed.mockReturnValue(true)
    destroyedContents.webContents.isDestroyed.mockReturnValue(true)
    electron.windows = [alive, crashed, destroyedContents]
    const publisher = new RendererEventPublisher({ isCurrent: () => true })

    publisher.toWindows('workbench-health:state', healthSnapshot)

    expect(alive.webContents.mainFrame.postMessage).toHaveBeenCalledOnce()
    expect(crashed.webContents.mainFrame.postMessage).not.toHaveBeenCalled()
    expect(destroyedContents.webContents.mainFrame.postMessage).not.toHaveBeenCalled()
  })

  it('requires both current ownership and a live target process', () => {
    const target = windowFixture(7)
    electron.windows = [target]
    const isCurrent = vi.fn(() => true)
    const publisher = new RendererEventPublisher({ isCurrent })
    const owner = { id: 7, generation: 2 }

    target.webContents.isCrashed.mockReturnValue(true)
    publisher.toRenderer(owner, 'workbench-health:state', healthSnapshot)
    target.webContents.isCrashed.mockReturnValue(false)
    isCurrent.mockReturnValue(false)
    publisher.toRenderer(owner, 'workbench-health:state', healthSnapshot)

    expect(target.webContents.mainFrame.postMessage).not.toHaveBeenCalled()
  })
})
