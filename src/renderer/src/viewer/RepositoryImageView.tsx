import { useEffect, useRef, useState, type ReactElement } from 'react'

import { unwrapOperation, type HostPath } from '../../../shared'

interface RepositoryImage {
  readonly url: string
  readonly size: number
  readonly mimeType: string
}

export function RepositoryImageView({
  path,
  refreshVersion,
}: {
  readonly path: HostPath
  readonly refreshVersion: number
}): ReactElement {
  const [image, setImage] = useState<RepositoryImage>()
  const imageRef = useRef<RepositoryImage>(undefined)
  const requestGeneration = useRef(0)
  const [dimensions, setDimensions] = useState<string>()
  const [error, setError] = useState<string>()

  useEffect(() => {
    const generation = (requestGeneration.current += 1)
    setError(undefined)
    void window.hvir.invoke('fs:read-asset', { path }).then(
      (result) => {
        try {
          const asset = unwrapOperation(result)
          const objectUrl = URL.createObjectURL(
            new Blob([new Uint8Array(asset.data)], { type: asset.mimeType }),
          )
          if (requestGeneration.current !== generation) {
            URL.revokeObjectURL(objectUrl)
            return
          }
          const previous = imageRef.current
          const replacement = {
            url: objectUrl,
            size: asset.size,
            mimeType: asset.mimeType,
          }
          imageRef.current = replacement
          setImage(replacement)
          setDimensions(undefined)
          if (previous) URL.revokeObjectURL(previous.url)
        } catch (reason) {
          if (requestGeneration.current === generation && !imageRef.current)
            setError(reason instanceof Error ? reason.message : String(reason))
        }
      },
      (reason: unknown) => {
        if (requestGeneration.current === generation && !imageRef.current)
          setError(reason instanceof Error ? reason.message : String(reason))
      },
    )
    return () => {
      if (requestGeneration.current === generation) requestGeneration.current += 1
    }
  }, [path, refreshVersion])

  useEffect(
    () => () => {
      requestGeneration.current += 1
      if (imageRef.current) URL.revokeObjectURL(imageRef.current.url)
      imageRef.current = undefined
    },
    [],
  )

  if (error && !image)
    return <div className="viewer-empty error">Image unavailable: {error}</div>
  if (!image) return <div className="viewer-empty">Loading image…</div>
  return (
    <figure className="rendered-scroll image-view">
      <img
        src={image.url}
        alt={path.path.split('/').at(-1) ?? 'Repository image'}
        onLoad={(event) => {
          const element = event.currentTarget
          setDimensions(`${element.naturalWidth} × ${element.naturalHeight}`)
        }}
      />
      <figcaption>
        <span>{dimensions ?? 'Image'}</span>
        <span>{image.mimeType}</span>
        <span>{formatAssetBytes(image.size)}</span>
      </figcaption>
    </figure>
  )
}

function formatAssetBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KiB`
  return `${(bytes / (1024 * 1024)).toFixed(1)} MiB`
}
