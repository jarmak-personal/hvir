import { useCallback, useEffect, useState } from 'react'

import {
  isDiagnosticEvidenceDeleteResult,
  isDiagnosticEvidenceState,
  type DiagnosticEvidenceState,
} from '../../../shared'

export function useDiagnosticEvidence(): {
  readonly state: DiagnosticEvidenceState | undefined
  readonly deleting: boolean
  readonly message: string | undefined
  readonly deleteEvidence: () => void
} {
  const [state, setState] = useState<DiagnosticEvidenceState>()
  const [deleting, setDeleting] = useState(false)
  const [message, setMessage] = useState<string>()

  useEffect(() => {
    let active = true
    void window.hvir
      .invoke('diagnostic-evidence:get', undefined)
      .then((candidate) => {
        if (active && isDiagnosticEvidenceState(candidate)) setState(candidate)
      })
      .catch(() => {
        if (active) setMessage('Local evidence details are unavailable.')
      })
    return () => {
      active = false
    }
  }, [])

  const deleteEvidence = useCallback((): void => {
    if (deleting) return
    setDeleting(true)
    setMessage(undefined)
    void window.hvir
      .invoke('diagnostic-evidence:delete', undefined)
      .then((candidate) => {
        if (!isDiagnosticEvidenceDeleteResult(candidate)) {
          setMessage('Local evidence deletion returned an invalid result.')
          return
        }
        setState(candidate.state)
        setMessage(
          candidate.ok
            ? 'Local diagnostic evidence deleted.'
            : 'Local evidence could not be deleted. Retry when storage is available.',
        )
      })
      .catch(() => {
        setMessage(
          'Local evidence could not be deleted. Retry when storage is available.',
        )
      })
      .finally(() => setDeleting(false))
  }, [deleting])

  return { state, deleting, message, deleteEvidence }
}
