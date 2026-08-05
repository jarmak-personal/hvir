// @vitest-environment happy-dom

import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { RepositoryImageView } from '../src/renderer/src/viewer/RepositoryImageView'
import { localPath, type ReadAssetResponse } from '../src/shared'

let host: HTMLDivElement
let root: Root
let invoke: ReturnType<typeof vi.fn>
let createObjectUrl: ReturnType<typeof vi.fn>
let revokeObjectUrl: ReturnType<typeof vi.fn>

beforeEach(() => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true)
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

describe('rendered repository image refresh', () => {
  it('keeps the previous image until replacement and revokes every owned URL', async () => {
    const path = localPath('/repo/image.png')
    const first = deferred<AssetResult>()
    const second = deferred<AssetResult>()
    const late = deferred<AssetResult>()
    invoke
      .mockReturnValueOnce(first.promise)
      .mockReturnValueOnce(second.promise)
      .mockReturnValueOnce(late.promise)
    createObjectUrl
      .mockReturnValueOnce('blob:first')
      .mockReturnValueOnce('blob:second')
      .mockReturnValueOnce('blob:late')

    render(path, 0)
    await act(async () => {
      first.resolve(asset(path, 1))
      await settle()
    })
    expect(host.querySelector('img')?.getAttribute('src')).toBe('blob:first')

    render(path, 1)
    expect(host.querySelector('img')?.getAttribute('src')).toBe('blob:first')
    expect(host.querySelector('.viewer-empty')).toBeNull()
    expect(revokeObjectUrl).not.toHaveBeenCalled()

    await act(async () => {
      second.resolve(asset(path, 2))
      await settle()
    })
    expect(host.querySelector('img')?.getAttribute('src')).toBe('blob:second')
    expect(revokeObjectUrl).toHaveBeenCalledWith('blob:first')

    render(path, 2)
    act(() => root.unmount())
    expect(revokeObjectUrl).toHaveBeenCalledWith('blob:second')
    await act(async () => {
      late.resolve(asset(path, 3))
      await settle()
    })
    expect(revokeObjectUrl).toHaveBeenCalledWith('blob:late')

    root = createRoot(host)
  })
})

type AssetResult = { readonly ok: true; readonly value: ReadAssetResponse }

function asset(path: ReturnType<typeof localPath>, byte: number): AssetResult {
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

function render(path: ReturnType<typeof localPath>, version: number): void {
  act(() => {
    root.render(<RepositoryImageView path={path} refreshVersion={version} />)
  })
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
