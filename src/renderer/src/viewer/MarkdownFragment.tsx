import { useEffect, useState, type ReactElement } from 'react'

import type { HostPath } from '../../../shared'
import { renderMarkdown, useMarkdownRendererGeneration } from './markdown-client'
import { handleRenderedLinkClick } from './rendered-link-handler'
import { useAppTheme } from '../theme'

interface MarkdownFragmentProps {
  readonly path: HostPath
  readonly content: string
  readonly className?: string
  readonly onOpenPath?: (path: HostPath) => void
}

export function MarkdownFragment({
  path,
  content,
  className = '',
  onOpenPath,
}: MarkdownFragmentProps): ReactElement {
  const renderGeneration = useMarkdownRendererGeneration()
  const theme = useAppTheme()
  const [html, setHtml] = useState('')
  const [error, setError] = useState(false)

  useEffect(() => {
    let cancelled = false
    setHtml('')
    setError(false)
    void renderMarkdown(content, theme).then(
      (rendered) => {
        if (!cancelled) setHtml(rendered)
      },
      () => {
        if (!cancelled) setError(true)
      },
    )
    return () => {
      cancelled = true
    }
  }, [content, renderGeneration, theme])

  if (error)
    return <pre className={`markdown-fragment-fallback ${className}`}>{content}</pre>
  if (!html)
    return <div className={`markdown-fragment-loading ${className}`}>Rendering…</div>

  return (
    <div
      className={`markdown-fragment markdown-body ${className}`}
      dangerouslySetInnerHTML={{ __html: html }}
      onClick={(event) => handleRenderedLinkClick(event, path, onOpenPath)}
    />
  )
}
