import { useEffect, useRef, useState, type ReactElement } from 'react'
import {
  containsHostPath,
  dirnameHostPath,
  HTML_SANDBOX,
  resolveRenderedLink,
} from '../../../shared'
import type { SkillagerReviewContent as Content } from '../../../shared/skillager-review'
import { renderMarkdown, useMarkdownRendererGeneration } from '../viewer/markdown-client'
import { SourceView } from '../viewer/SourceView'
import { initialViewerPosition } from '../viewer/viewer-position'
import { useAppTheme } from '../theme'
import type { SkillagerReviewController } from './use-skillager-review'

const ignore = (): void => undefined

export function SkillagerReviewContent({
  id,
  content,
  source,
  diff,
  controller,
}: {
  readonly id: string
  readonly content?: Content
  readonly source: boolean
  readonly diff?: string
  readonly controller: SkillagerReviewController
}): ReactElement {
  const capture = useRef<(() => ReturnType<typeof initialViewerPosition>) | undefined>(
    undefined,
  )
  const [imageUrl, setImageUrl] = useState<string>()
  useEffect(() => {
    setImageUrl(undefined)
    if (!content?.image) return
    const url = URL.createObjectURL(
      new Blob([Uint8Array.from(content.image.bytes).buffer], {
        type: content.image.mime,
      }),
    )
    setImageUrl(url)
    return () => URL.revokeObjectURL(url)
  }, [content])
  if (!content)
    return <p className="skillager-hint">Choose a file in the verified tree.</p>
  if (source || diff !== undefined)
    return (
      <SourceView
        readOnly
        path={content.path}
        content={diff ?? content.text ?? ''}
        size={diff?.length ?? content.size}
        position={initialViewerPosition('source')}
        onContent={ignore}
        onSave={ignore}
        onPosition={ignore}
        blame={[]}
        blameStatus=""
        positionCapture={capture}
        onNavigationHandled={ignore}
        registerFindTarget={() => ignore}
      />
    )
  if (content.image)
    return imageUrl ? (
      <img className="skillager-review-image" src={imageUrl} alt={content.entry} />
    ) : (
      <p>Preparing image…</p>
    )
  if (content.htmlUrl)
    return (
      <iframe
        className="skillager-review-html"
        title={`Reviewed ${content.entry}`}
        sandbox={HTML_SANDBOX}
        src={content.htmlUrl}
      />
    )
  if (content.text === undefined)
    return (
      <p>
        Binary file · {content.size.toLocaleString()} bytes. Included in the verified
        tree; no text preview is available.
      </p>
    )
  if (/\.(?:md|markdown)$/i.test(content.entry))
    return <ReviewedMarkdown id={id} content={content} controller={controller} />
  return (
    <SkillagerReviewContent id={id} content={content} source controller={controller} />
  )
}

/** Renders retained content; every embedded image resolves through the same review lease. */
function ReviewedMarkdown({
  id,
  content,
  controller,
}: {
  readonly id: string
  readonly content: Content
  readonly controller: SkillagerReviewController
}): ReactElement {
  const element = useRef<HTMLDivElement>(null)
  const [error, setError] = useState(false)
  const theme = useAppTheme(),
    generation = useMarkdownRendererGeneration()
  const asset = controller.asset
  useEffect(() => {
    let disposed = false
    const urls = new Set<string>()
    const root = element.current
    root?.replaceChildren()
    setError(false)
    void renderMarkdown(content.text!, theme)
      .then(async (html) => {
        if (disposed || !root) return
        const template = document.createElement('template')
        template.innerHTML = html
        const images = [...template.content.querySelectorAll<HTMLImageElement>('img')]
        const sources = images.map((image) => image.getAttribute('src'))
        for (const image of images) image.removeAttribute('src')
        root.replaceChildren(template.content)
        await Promise.all(
          images.map(async (image, index) => {
            const target = resolveRenderedLink(content.path, sources[index] ?? '')
            if (
              target.kind !== 'file' ||
              !containsHostPath(dirnameHostPath(content.path), target.path)
            ) {
              image.alt = 'Image outside this reviewed document is unavailable'
              return
            }
            const parent = content.entry.split('/').slice(0, -1).join('/')
            const relative = target.path.path.slice(
              dirnameHostPath(content.path).path.length + 1,
            )
            const entry = parent ? `${parent}/${relative}` : relative
            try {
              const result = await asset(id, content.entry, entry)
              if (disposed || !result?.ok || !result.value.image) return
              const url = URL.createObjectURL(
                new Blob([Uint8Array.from(result.value.image.bytes).buffer], {
                  type: result.value.image.mime,
                }),
              )
              urls.add(url)
              image.src = url
            } catch {
              if (!disposed) image.alt = 'Reviewed image unavailable'
            }
          }),
        )
      })
      .catch(() => {
        if (!disposed) setError(true)
      })
    return () => {
      disposed = true
      for (const url of urls) URL.revokeObjectURL(url)
      root?.replaceChildren()
    }
  }, [id, content, asset, theme, generation])
  return error ? (
    <pre>{content.text}</pre>
  ) : (
    <div
      ref={element}
      className="markdown-body skillager-review-markdown"
      onClick={(event) => {
        const anchor = (event.target as Element).closest('a[href]')
        if (!anchor) return
        event.preventDefault()
        const target = resolveRenderedLink(
          content.path,
          anchor.getAttribute('href') ?? '',
        )
        const detail = controller.states[id]?.detail
        if (
          target.kind !== 'file' ||
          !detail ||
          !containsHostPath(detail.root, target.path)
        )
          return
        const entry = target.path.path.slice(detail.root.path.length + 1)
        if (detail.files.some((file) => file.entry === entry))
          void controller.content(id, entry)
      }}
    />
  )
}
