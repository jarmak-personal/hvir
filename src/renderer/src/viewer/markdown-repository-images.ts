import {
  hostPathEquals,
  resolveRenderedLink,
  unwrapOperation,
  type HvirApi,
  type HostPath,
} from '../../../shared'

/** Owns repository-backed image dependencies and object URLs for one rendered document. */
export class MarkdownRepositoryImages {
  private readonly generations = new Map<HTMLImageElement, number>()
  private readonly objectUrls = new Map<HTMLImageElement, string>()
  private disposed = false

  constructor(private readonly documentPath: HostPath) {}

  hydrate(root: HTMLElement): readonly HostPath[] {
    const dependencies = new Map<string, HostPath>()
    for (const image of root.querySelectorAll<HTMLImageElement>('img[src]')) {
      const dependency = this.dependency(image)
      if (!dependency) continue
      dependencies.set(`${dependency.hostId}:${dependency.path}`, dependency)
      void this.hydrateImage(image, dependency, false)
    }
    return [...dependencies.values()]
  }

  refresh(root: HTMLElement, changedPath: HostPath): void {
    if (this.disposed || hostPathEquals(this.documentPath, changedPath)) return
    for (const image of root.querySelectorAll<HTMLImageElement>('img')) {
      const dependency = this.dependency(image)
      if (dependency && hostPathEquals(dependency, changedPath)) {
        void this.hydrateImage(image, dependency, true)
      }
    }
  }

  dispose(): void {
    if (this.disposed) return
    this.disposed = true
    for (const image of this.generations.keys()) {
      this.generations.set(image, (this.generations.get(image) ?? 0) + 1)
    }
    for (const objectUrl of this.objectUrls.values()) URL.revokeObjectURL(objectUrl)
    this.generations.clear()
    this.objectUrls.clear()
  }

  private dependency(image: HTMLImageElement): HostPath | undefined {
    const source = image.dataset['hvirRepositorySrc'] ?? image.getAttribute('src')
    if (!source) return undefined
    const target = resolveRenderedLink(this.documentPath, source)
    if (target.kind !== 'file') return undefined
    image.dataset['hvirRepositorySrc'] = source
    return target.path
  }

  private async hydrateImage(
    image: HTMLImageElement,
    path: HostPath,
    preserveCurrent: boolean,
  ): Promise<void> {
    const generation = (this.generations.get(image) ?? 0) + 1
    this.generations.set(image, generation)
    if (!preserveCurrent) {
      image.removeAttribute('src')
      image.classList.add('markdown-image-loading')
    }
    try {
      const asset = unwrapOperation(await hvirApi().invoke('fs:read-asset', { path }))
      const objectUrl = URL.createObjectURL(
        new Blob([new Uint8Array(asset.data)], { type: asset.mimeType }),
      )
      if (this.disposed || this.generations.get(image) !== generation) {
        URL.revokeObjectURL(objectUrl)
        return
      }
      const previous = this.objectUrls.get(image)
      this.objectUrls.set(image, objectUrl)
      image.src = objectUrl
      image.classList.remove('markdown-image-loading')
      if (previous) URL.revokeObjectURL(previous)
    } catch (reason) {
      if (
        this.disposed ||
        this.generations.get(image) !== generation ||
        preserveCurrent
      ) {
        return
      }
      const unavailable = document.createElement('span')
      unavailable.className = 'markdown-image-unavailable'
      unavailable.textContent = image.alt
        ? `[Image unavailable: ${image.alt}]`
        : '[Repository image unavailable]'
      unavailable.title = reason instanceof Error ? reason.message : String(reason)
      image.replaceWith(unavailable)
    }
  }
}

function hvirApi(): HvirApi {
  return (globalThis as unknown as { readonly window: { readonly hvir: HvirApi } }).window
    .hvir
}
