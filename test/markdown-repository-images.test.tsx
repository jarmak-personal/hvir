// @vitest-environment happy-dom

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { MarkdownRepositoryImages } from '../src/renderer/src/viewer/markdown-repository-images'
import { asHostId, hostPath, localPath, type ReadAssetResponse } from '../src/shared'

let invoke: ReturnType<typeof vi.fn>
let createObjectUrl: ReturnType<typeof vi.fn>
let revokeObjectUrl: ReturnType<typeof vi.fn>

beforeEach(() => {
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
  vi.restoreAllMocks()
})

describe('Markdown repository images', () => {
  it('declares exact dependencies and replaces only a matching host-qualified asset', async () => {
    const documentPath = localPath('/repo/docs/readme.md')
    const dependency = localPath('/repo/assets/diagram.png')
    const first = deferred<AssetResult>()
    const replacement = deferred<AssetResult>()
    const late = deferred<AssetResult>()
    invoke
      .mockReturnValueOnce(first.promise)
      .mockReturnValueOnce(replacement.promise)
      .mockReturnValueOnce(late.promise)
    createObjectUrl
      .mockReturnValueOnce('blob:first')
      .mockReturnValueOnce('blob:replacement')
      .mockReturnValueOnce('blob:late')
    const root = document.createElement('div')
    root.innerHTML = [
      '<img alt="diagram" src="../assets/diagram.png">',
      '<img alt="external" src="https://example.com/image.png">',
    ].join('')
    const images = new MarkdownRepositoryImages(documentPath)

    expect(images.hydrate(root)).toEqual([dependency])
    expect(invoke).toHaveBeenCalledOnce()
    expect(invoke).toHaveBeenCalledWith('fs:read-asset', { path: dependency })
    first.resolve(asset(dependency, 1))
    await settle()
    const repositoryImage = root.querySelector<HTMLImageElement>('img[alt="diagram"]')
    expect(repositoryImage?.getAttribute('src')).toBe('blob:first')

    invoke.mockClear()
    images.refresh(root, localPath('/repo/assets/other.png'))
    images.refresh(root, hostPath(asHostId('ssh:fixture'), dependency.path))
    expect(invoke).not.toHaveBeenCalled()
    expect(repositoryImage?.getAttribute('src')).toBe('blob:first')

    images.refresh(root, dependency)
    expect(invoke).toHaveBeenCalledOnce()
    expect(repositoryImage?.getAttribute('src')).toBe('blob:first')
    replacement.resolve(asset(dependency, 2))
    await settle()
    expect(repositoryImage?.getAttribute('src')).toBe('blob:replacement')
    expect(revokeObjectUrl).toHaveBeenCalledWith('blob:first')

    images.refresh(root, dependency)
    images.dispose()
    expect(revokeObjectUrl).toHaveBeenCalledWith('blob:replacement')
    late.resolve(asset(dependency, 3))
    await settle()
    expect(revokeObjectUrl).toHaveBeenCalledWith('blob:late')
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
