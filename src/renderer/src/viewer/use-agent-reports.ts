import { useEffect, useState } from 'react'
import type { AgentReportSummary } from '../../../shared/agent/contract'

/** Read-only presentation subscription; content/handles remain with the main viewer owner. */
export function useAgentReportSummaries(): readonly AgentReportSummary[] {
  const [reports, setReports] = useState<readonly AgentReportSummary[]>([])
  useEffect(() => {
    let current = true,
      updated = false
    const unsubscribe = window.hvir.on('agent:reports-changed', (next) => {
      if (current) {
        updated = true
        setReports(next)
      }
    })
    void window.hvir.invoke('agent:reports', undefined).then(
      (next) => {
        if (current && !updated) setReports(next)
      },
      () => undefined,
    )
    return () => {
      current = false
      void unsubscribe()
    }
  }, [])
  return reports
}
