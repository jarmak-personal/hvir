import type { ReactElement } from 'react'
import type { AgentReportSummary } from '../../../shared/agent/contract'
import {
  closeOnMiddleClick,
  guardMiddleClickClosePointerDown,
} from '../workbench/middle-click-close'

export interface AgentReportTabsProps {
  readonly reports: readonly AgentReportSummary[]
  readonly activeId?: string
  readonly onActivate: (id: string) => void
  readonly onClose: (id: string) => void
}
export function AgentReportTabs({
  reports,
  activeId,
  onActivate,
  onClose,
}: AgentReportTabsProps): ReactElement {
  return (
    <>
      {reports.map((report) => (
        <div
          key={report.id}
          className={`agent-report-tab viewer-tab${activeId === report.id ? ' active' : ''}`}
          role="tab"
          aria-selected={activeId === report.id}
          onMouseDown={guardMiddleClickClosePointerDown}
          onAuxClick={(event) => closeOnMiddleClick(event, () => onClose(report.id))}
        >
          <button type="button" onClick={() => onActivate(report.id)}>
            {report.title}
            {report.unread ? (
              <span
                className="hvir-meta agent-report-badge"
                aria-label="Unread agent report"
              >
                Agent
              </span>
            ) : null}
          </button>
          <button
            type="button"
            className="tab-close"
            aria-label={`Close agent report ${report.title}`}
            onClick={() => onClose(report.id)}
          >
            ×
          </button>
        </div>
      ))}
    </>
  )
}
