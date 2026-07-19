import { beforeEach, describe, expect, it, vi } from 'vitest'

const electron = vi.hoisted(() => ({ handle: vi.fn(), unhandle: vi.fn() }))
vi.mock('electron', () => ({ protocol: electron }))

import { HtmlPreviewProtocol } from '../src/main/html-preview-protocol'
import { localPath } from '../src/shared'

describe('HtmlPreviewProtocol ownership', () => {
  beforeEach(() => {
    electron.handle.mockClear()
    electron.unhandle.mockClear()
  })

  it('isolates release by renderer generation and workspace', () => {
    const previews = new HtmlPreviewProtocol()
    previews.register()
    const previous = { id: 10, generation: 1 }
    const current = { id: 10, generation: 2 }
    const firstRoot = localPath('/project/first')
    const secondRoot = localPath('/project/second')
    const first = previews.create('<p>first</p>', previous, firstRoot)
    const second = previews.create('<p>second</p>', current, secondRoot)

    previews.release(first.id, current)
    previews.releaseWorkspace(secondRoot)

    const handler = electron.handle.mock.calls[0]?.[1] as (request: Request) => Response
    expect(handler(new Request(first.url)).status).toBe(200)
    expect(handler(new Request(second.url)).status).toBe(404)

    previews.releaseOwner(previous)
    expect(handler(new Request(first.url)).status).toBe(404)
    previews.dispose()
  })
})
