import { useEffect, useState, type ReactElement } from 'react'
import type { AgentReport, AgentReportSummary } from '../../../shared/agent/contract'
import type { HostPath } from '../../../shared/host-path'
import { useAppTheme } from '../theme'
import { renderMarkdown, useMarkdownRendererGeneration } from './markdown-client'
import { handleRenderedLinkClick } from './rendered-link-handler'

export function AgentReportView({
  report,
  visible,
  onOpenPath,
}: {
  readonly report: AgentReportSummary
  readonly visible: boolean
  readonly onOpenPath: (path: HostPath) => void
}): ReactElement {
  const [content, setContent] = useState<AgentReport>(),
    [rendered, setRendered] = useState<{ id: string; version: number; html: string }>(),
    [error, setError] = useState('')
  const theme = useAppTheme(),
    rendererGeneration = useMarkdownRendererGeneration()
  useEffect(() => {
    let current = true
    setContent(undefined)
    setRendered(undefined)
    setError('')
    void window.hvir.invoke('agent:report-read', { id: report.id }).then(
      (value) => {
        if (current && value.id === report.id && value.version === report.version)
          setContent(value)
      },
      (reason: unknown) => {
        if (current)
          setError(reason instanceof Error ? reason.message : 'Report unavailable')
      },
    )
    return () => {
      current = false
    }
  }, [report.id, report.version])
  useEffect(() => {
    let current = true
    setRendered(undefined)
    if (content?.format === 'markdown')
      void renderMarkdown(content.content, theme, 'inert').then(
        (value) => {
          if (current)
            setRendered({ id: content.id, version: content.version, html: value })
        },
        () => {
          if (current) setError('Report rendering is unavailable')
        },
      )
    return () => {
      current = false
    }
  }, [content, theme, rendererGeneration])
  const displayed =
    content?.id === report.id && content.version === report.version ? content : undefined
  const html =
    displayed && rendered?.id === displayed.id && rendered.version === displayed.version
      ? rendered.html
      : ''
  useEffect(() => {
    if (visible && displayed && report.unread)
      void window.hvir
        .invoke('agent:report-viewed', { id: displayed.id, version: displayed.version })
        .catch(() => undefined)
  }, [displayed, report.unread, visible])
  return (
    <section
      className="agent-report-view hvir-panel hvir-scroll"
      aria-label={`Agent report: ${report.title}`}
    >
      <div className="hvir-toolbar">
        <strong>{report.title}</strong>
        <span className="hvir-meta">Agent report · {report.workspace}</span>
      </div>
      {error ? (
        <p role="alert">{error}</p>
      ) : !displayed ? (
        <p role="status">Loading report…</p>
      ) : displayed.format === 'text' || !html ? (
        <pre>{displayed.content}</pre>
      ) : (
        <div
          className="markdown-body"
          dangerouslySetInnerHTML={{ __html: html }}
          onClick={(event) =>
            handleRenderedLinkClick(event, displayed.root, onOpenPath, 'directory')
          }
        />
      )}
    </section>
  )
}
