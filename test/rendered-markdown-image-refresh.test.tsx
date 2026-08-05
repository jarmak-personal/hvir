// @vitest-environment happy-dom

import { act, type ReactNode } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { RenderedView } from '../src/renderer/src/viewer/RenderedView'
import { renderMarkdown } from '../src/renderer/src/viewer/markdown-client'
import type { ViewerPositionCapture } from '../src/renderer/src/viewer/viewer-position'
import { localPath, type HostPath, type ReadAssetResponse } from '../src/shared'

vi.mock('../src/renderer/src/viewer/markdown-client', () => ({
  renderMarkdown: vi.fn(),
  resetMarkdownRenderer: vi.fn(),
}))

let host: HTMLDivElement
let root: Root
let invoke: ReturnType<typeof vi.fn>
let createObjectUrl: ReturnType<typeof vi.fn>
let revokeObjectUrl: ReturnType<typeof vi.fn>

beforeEach(() => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true)
  vi.stubGlobal(
    'Highlight',
    class extends Set<Range> {
      constructor(...ranges: Range[]) {
        super(ranges)
      }
    },
  )
  vi.stubGlobal('CSS', {
    highlights: {
      set: vi.fn(),
      delete: vi.fn(),
    },
  })
  host = document.createElement('div')
  document.body.append(host)
  root = createRoot(host)
  invoke = vi.fn()
  createObjectUrl = vi.fn()
  revokeObjectUrl = vi.fn()
  Object.defineProperty(window, 'hvir', {
    configurable: true,
    value: { invoke },
  })
  Object.defineProperty(URL, 'createObjectURL', {
    configurable: true,
    value: createObjectUrl,
  })
  Object.defineProperty(URL, 'revokeObjectURL', {
    configurable: true,
    value: revokeObjectUrl,
  })
})

afterEach(() => {
  act(() => root.unmount())
  host.remove()
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
})

describe('RenderedView Markdown repository image refresh', () => {
  it('keeps the Markdown tree and nonmatching image mounted while replacing one dependency', async () => {
    const documentPath = localPath('/repo/docs/readme.md')
    const firstPath = localPath('/repo/assets/first.png')
    const secondPath = localPath('/repo/assets/second.png')
    const first = deferred<AssetResult>()
    const second = deferred<AssetResult>()
    const replacement = deferred<AssetResult>()
    invoke
      .mockReturnValueOnce(first.promise)
      .mockReturnValueOnce(second.promise)
      .mockReturnValueOnce(replacement.promise)
    createObjectUrl
      .mockReturnValueOnce('blob:first')
      .mockReturnValueOnce('blob:second')
      .mockReturnValueOnce('blob:first-replacement')
    vi.mocked(renderMarkdown).mockResolvedValue(
      [
        '<p data-render-sentinel="true">Stable prose</p>',
        '<img alt="first" src="../assets/first.png">',
        '<img alt="second" src="../assets/second.png">',
      ].join(''),
    )
    const onDependencies = vi.fn()
    const positionCapture: ViewerPositionCapture = { current: undefined }
    const registerFindTarget = (): (() => void) => () => undefined
    const props = {
      path: documentPath,
      content: '# Images',
      position: { mode: 'rendered' as const, line: 1, scrollTop: 0 },
      onPosition: vi.fn(),
      positionCapture,
      onOpenPath: vi.fn(),
      onDependencies,
      registerFindTarget,
    }

    render(<RenderedView {...props} />)
    await act(async () => settle())
    expect(onDependencies).toHaveBeenCalledWith([firstPath, secondPath])

    await act(async () => {
      first.resolve(asset(firstPath, 1))
      second.resolve(asset(secondPath, 2))
      await settle()
    })
    const container = host.querySelector<HTMLElement>('.markdown-body')
    const sentinel = host.querySelector<HTMLElement>('[data-render-sentinel]')
    const firstImage = host.querySelector<HTMLImageElement>('img[alt="first"]')
    const secondImage = host.querySelector<HTMLImageElement>('img[alt="second"]')
    expect(firstImage?.getAttribute('src')).toBe('blob:first')
    expect(secondImage?.getAttribute('src')).toBe('blob:second')

    render(<RenderedView {...props} refresh={{ version: 1, path: firstPath }} />)
    expect(invoke).toHaveBeenCalledTimes(3)
    expect(invoke).toHaveBeenLastCalledWith('fs:read-asset', { path: firstPath })
    expect(host.querySelector('.markdown-body')).toBe(container)
    expect(host.querySelector('[data-render-sentinel]')).toBe(sentinel)
    expect(host.querySelector('img[alt="first"]')).toBe(firstImage)
    expect(host.querySelector('img[alt="second"]')).toBe(secondImage)
    expect(firstImage?.getAttribute('src')).toBe('blob:first')
    expect(secondImage?.getAttribute('src')).toBe('blob:second')

    await act(async () => {
      replacement.resolve(asset(firstPath, 3))
      await settle()
    })
    expect(host.querySelector('.markdown-body')).toBe(container)
    expect(host.querySelector('[data-render-sentinel]')).toBe(sentinel)
    expect(host.querySelector('img[alt="first"]')).toBe(firstImage)
    expect(host.querySelector('img[alt="second"]')).toBe(secondImage)
    expect(firstImage?.getAttribute('src')).toBe('blob:first-replacement')
    expect(secondImage?.getAttribute('src')).toBe('blob:second')
    expect(revokeObjectUrl).toHaveBeenCalledWith('blob:first')
    expect(revokeObjectUrl).not.toHaveBeenCalledWith('blob:second')
  })
})

type AssetResult = { readonly ok: true; readonly value: ReadAssetResponse }

function asset(path: HostPath, byte: number): AssetResult {
  return {
    ok: true,
    value: {
      path,
      data: new Uint8Array([byte]),
      size: 1,
      mimeType: 'image/png',
    },
  }
}

function render(view: ReactNode): void {
  act(() => root.render(view))
}

function deferred<T>(): {
  readonly promise: Promise<T>
  readonly resolve: (value: T) => void
} {
  let resolve!: (value: T) => void
  return {
    promise: new Promise<T>((accept) => {
      resolve = accept
    }),
    resolve,
  }
}

async function settle(): Promise<void> {
  await Promise.resolve()
  await Promise.resolve()
}
