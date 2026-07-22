import { useCallback, useEffect, useMemo, useRef, useState } from 'react'

import {
  RENDERER_RESPONSIVENESS_MAX_OBSERVATIONS,
  type ResponsivenessDiagnosticsState,
  type ResponsivenessStopReason,
} from '../../../shared'
import {
  RendererResponsivenessDetector,
  supportsRendererResponsivenessDiagnostics,
} from './renderer-responsiveness-detector'

export interface ResponsivenessDiagnosticsController {
  readonly ready: boolean
  readonly supported: boolean
  readonly state?: ResponsivenessDiagnosticsState
  readonly remainingMs: number
  readonly start: () => void
  readonly stop: () => void
  readonly deleteEvidence: () => void
}

export function useResponsivenessDiagnostics(): ResponsivenessDiagnosticsController {
  const [state, setState] = useState<ResponsivenessDiagnosticsState>()
  const [now, setNow] = useState(Date.now())
  const detector = useRef<RendererResponsivenessDetector | undefined>(undefined)
  const stateRef = useRef(state)
  stateRef.current = state

  const apply = useCallback((next: ResponsivenessDiagnosticsState) => {
    setState(next)
    stateRef.current = next
    if (next.status === 'active') detector.current?.start(next.diagnosticSessionId)
    else detector.current?.dispose()
  }, [])

  useEffect(() => {
    detector.current = new RendererResponsivenessDetector({
      observe: (observation) => {
        window.hvir.diagnostics.recordResponsivenessObservation(observation)
        setState((current) =>
          current?.status === 'active' &&
          current.diagnosticSessionId === observation.diagnosticSessionId
            ? {
                ...current,
                observationCount: Math.min(
                  RENDERER_RESPONSIVENESS_MAX_OBSERVATIONS,
                  current.observationCount + observation.observationCount,
                ),
              }
            : current,
        )
      },
      stop: (reason) => stopWithReason(reason, stateRef, apply),
    })
    window.hvir
      .invoke('responsiveness-diagnostics:get', undefined)
      .then(apply)
      .catch(() => undefined)
    return () => detector.current?.dispose()
  }, [apply])

  useEffect(() => {
    if (state?.status !== 'active') return
    const timer = window.setInterval(() => {
      const current = Date.now()
      setNow(current)
      if (current >= Date.parse(state.expiresAt)) {
        window.hvir
          .invoke('responsiveness-diagnostics:get', undefined)
          .then(apply)
          .catch(() => undefined)
      }
    }, 1_000)
    return () => window.clearInterval(timer)
  }, [apply, state])

  const start = useCallback(() => {
    if (!supportsRendererResponsivenessDiagnostics()) return
    window.hvir
      .invoke('responsiveness-diagnostics:start', undefined)
      .then(apply)
      .catch(() => undefined)
  }, [apply])

  const stop = useCallback(() => {
    const current = stateRef.current
    if (current?.status !== 'active') return
    detector.current?.dispose()
    window.hvir.diagnostics.flushResponsivenessObservations()
    window.hvir
      .invoke('responsiveness-diagnostics:stop', {
        diagnosticSessionId: current.diagnosticSessionId,
        reason: 'user-stop',
      })
      .then(apply)
      .catch(() => undefined)
  }, [apply])

  const deleteEvidence = useCallback(() => {
    const current = stateRef.current
    if (current?.status !== 'active' && current?.status !== 'complete') return
    detector.current?.dispose()
    window.hvir.diagnostics.flushResponsivenessObservations()
    window.hvir
      .invoke('responsiveness-diagnostics:delete', {
        diagnosticSessionId: current.diagnosticSessionId,
      })
      .then(apply)
      .catch(() => undefined)
  }, [apply])

  return useMemo(
    () => ({
      ready: state !== undefined,
      supported: supportsRendererResponsivenessDiagnostics(),
      state,
      remainingMs:
        state?.status === 'active' ? Math.max(0, Date.parse(state.expiresAt) - now) : 0,
      start,
      stop,
      deleteEvidence,
    }),
    [deleteEvidence, now, start, state, stop],
  )
}

function stopWithReason(
  reason: Extract<ResponsivenessStopReason, 'backgrounded' | 'api-unavailable'>,
  state: React.RefObject<ResponsivenessDiagnosticsState | undefined>,
  apply: (next: ResponsivenessDiagnosticsState) => void,
): void {
  const current = state.current
  if (current?.status !== 'active') return
  window.hvir.diagnostics.flushResponsivenessObservations()
  window.hvir
    .invoke('responsiveness-diagnostics:stop', {
      diagnosticSessionId: current.diagnosticSessionId,
      reason,
    })
    .then(apply)
    .catch(() => undefined)
}
