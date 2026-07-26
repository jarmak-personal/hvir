import { useEffect, useRef, useState, type ReactElement } from 'react'

import {
  isDiagnosticReportActionResult,
  isDiagnosticReportStateResult,
  type DiagnosticReportFailure,
  type DiagnosticReportState,
} from '../../../shared'
import { ConfirmationDialog } from '../workbench/ConfirmationDialog'
import { ownedDiagnosticCaptureMasks } from './owned-capture-masks'

export function DiagnosticReportDialog({
  onClose,
}: {
  readonly onClose: () => void
}): ReactElement {
  const reportId = useRef<string | undefined>(undefined)
  const [state, setState] = useState<DiagnosticReportState>()
  const [busy, setBusy] = useState<
    'create' | 'capture' | 'copy' | 'save' | 'delete' | undefined
  >('create')
  const [message, setMessage] = useState('Preparing bounded local report…')

  useEffect(() => {
    const id = crypto.randomUUID()
    reportId.current = id
    let active = true
    setBusy('create')
    void window.hvir
      .invoke('diagnostic-report:create', { reportId: id })
      .then((result) => {
        if (!active || reportId.current !== id) return
        if (!isDiagnosticReportStateResult(result) || !result.ok) {
          setMessage(
            failureMessage(result && 'reason' in result ? result.reason : undefined),
          )
          return
        }
        setState(result.state)
        setMessage('Review every structured field before Copy or Save.')
      })
      .catch(
        () =>
          active &&
          reportId.current === id &&
          setMessage(failureMessage('storage-unavailable')),
      )
      .finally(
        () =>
          active && setBusy((current) => (current === 'create' ? undefined : current)),
      )
    return () => {
      active = false
      if (reportId.current === id) reportId.current = undefined
      void window.hvir
        .invoke('diagnostic-report:cancel', { reportId: id })
        .catch(() => undefined)
    }
  }, [])

  const close = (): void => {
    const id = reportId.current
    reportId.current = undefined
    if (id)
      void window.hvir
        .invoke('diagnostic-report:cancel', { reportId: id })
        .catch(() => undefined)
    onClose()
  }

  const capture = (): void => {
    const id = reportId.current
    const masks = ownedDiagnosticCaptureMasks()
    if (!id || !masks) {
      setMessage(
        'Screenshot unavailable: the owned-surface mask inventory exceeded its bound.',
      )
      return
    }
    setBusy('capture')
    setMessage('Capturing once and masking owned content surfaces…')
    void window.hvir
      .invoke('diagnostic-report:capture', { reportId: id, masks })
      .then((result) => {
        if (reportId.current !== id) return
        if (!isDiagnosticReportStateResult(result) || !result.ok) {
          setMessage(
            failureMessage(result && 'reason' in result ? result.reason : undefined),
          )
          return
        }
        setState(result.state)
        setMessage('Screenshot included. Inspect the exact image before Copy or Save.')
      })
      .catch(
        () => reportId.current === id && setMessage(failureMessage('capture-failed')),
      )
      .finally(
        () =>
          reportId.current === id &&
          setBusy((current) => (current === 'capture' ? undefined : current)),
      )
  }

  const action = (kind: 'copy' | 'save'): void => {
    const id = reportId.current
    if (!id) return
    setBusy(kind)
    setMessage(
      kind === 'copy'
        ? 'Writing the reviewed artifact to the clipboard…'
        : 'Choose an explicit local destination…',
    )
    void window.hvir
      .invoke(`diagnostic-report:${kind}`, { reportId: id })
      .then((result) => {
        if (reportId.current !== id) return
        if (!isDiagnosticReportActionResult(result) || !result.ok) {
          setMessage(
            failureMessage(result && 'reason' in result ? result.reason : undefined),
          )
          return
        }
        setMessage(
          result.outcome === 'cancelled'
            ? 'Save cancelled; the temporary report is unchanged.'
            : kind === 'copy'
              ? 'Exact reviewed artifact copied.'
              : 'Exact reviewed artifact saved.',
        )
      })
      .catch(
        () => reportId.current === id && setMessage(failureMessage('action-unavailable')),
      )
      .finally(
        () =>
          reportId.current === id &&
          setBusy((current) => (current === kind ? undefined : current)),
      )
  }

  const deleteReport = (): void => {
    const id = reportId.current
    if (!id) return
    setBusy('delete')
    void window.hvir
      .invoke('diagnostic-report:delete', { reportId: id })
      .then((result) => {
        if (reportId.current !== id) return
        if (!isDiagnosticReportActionResult(result) || !result.ok) {
          setMessage(
            failureMessage(result && 'reason' in result ? result.reason : undefined),
          )
          return
        }
        reportId.current = undefined
        onClose()
      })
      .catch(
        () =>
          reportId.current === id && setMessage(failureMessage('storage-unavailable')),
      )
      .finally(
        () =>
          reportId.current === id &&
          setBusy((current) => (current === 'delete' ? undefined : current)),
      )
  }

  return (
    <ConfirmationDialog
      labelledBy="diagnostic-report-title"
      actions={[{ label: 'Close', kind: 'cancel', onSelect: close }]}
      className="diagnostic-report-dialog"
    >
      <header>
        <h2 id="diagnostic-report-title">Review diagnostic report</h2>
        <p>Local, bounded, and never sent to a harness automatically.</p>
      </header>
      <p className="diagnostic-report-status" role="status">
        {message}
      </p>
      {state ? (
        <>
          <section aria-labelledby="diagnostic-report-structured-title">
            <h3 id="diagnostic-report-structured-title">Exact structured fields</h3>
            <dl className="diagnostic-report-evidence-scopes">
              <dt>Current lifetime</dt>
              <dd>
                {scopeSummary(state.artifact.report.diagnostics.scopes.currentLifetime)}
              </dd>
              <dt>Preceding lifetime</dt>
              <dd>
                {scopeSummary(state.artifact.report.diagnostics.scopes.precedingLifetime)}
              </dd>
            </dl>
            <pre className="diagnostic-report-preview">
              {JSON.stringify(state.artifact.report, null, 2)}
            </pre>
          </section>
          <section
            className="diagnostic-report-image"
            aria-labelledby="diagnostic-report-image-title"
          >
            <h3 id="diagnostic-report-image-title">Optional screenshot</h3>
            {state.artifact.screenshot ? (
              <>
                <img
                  src={state.artifact.screenshot.dataUrl}
                  alt="Exact masked diagnostic screenshot"
                />
                <p>
                  Masks are based on the workbench layout measured immediately before
                  capture. Confirm every sensitive surface is fully covered in this exact
                  image before Copy or Save.
                </p>
                <dl>
                  <dt>Media type</dt>
                  <dd>{state.artifact.screenshot.mediaType}</dd>
                  <dt>Dimensions</dt>
                  <dd>
                    {state.artifact.screenshot.width} × {state.artifact.screenshot.height}
                  </dd>
                  <dt>Bytes</dt>
                  <dd>{state.artifact.screenshot.bytes}</dd>
                  <dt>SHA-256</dt>
                  <dd>
                    <code>{state.artifact.screenshot.sha256}</code>
                  </dd>
                  <dt>Masked surfaces</dt>
                  <dd>{state.artifact.screenshot.masked.join(', ') || 'none'}</dd>
                </dl>
              </>
            ) : (
              <p>No screenshot is captured by default.</p>
            )}
            <button type="button" disabled={busy !== undefined} onClick={capture}>
              {state.artifact.screenshot
                ? 'Replace screenshot'
                : 'Capture masked screenshot'}
            </button>
          </section>
          <p className="diagnostic-report-storage">
            Temporary copy: {state.storage.location} · retained at most{' '}
            {state.storage.retentionHours} hours.
          </p>
          <div className="diagnostic-report-actions">
            <button
              type="button"
              disabled={busy !== undefined}
              onClick={() => action('copy')}
            >
              Copy exact artifact
            </button>
            <button
              type="button"
              disabled={busy !== undefined}
              onClick={() => action('save')}
            >
              Save exact artifact…
            </button>
            <button
              type="button"
              disabled={busy !== undefined}
              className="danger-button"
              onClick={deleteReport}
            >
              Delete temporary report
            </button>
          </div>
        </>
      ) : null}
    </ConfirmationDialog>
  )
}

function failureMessage(reason: DiagnosticReportFailure | undefined): string {
  if (reason === 'capture-failed')
    return 'Screenshot capture failed; the structured report is unchanged.'
  if (reason === 'report-too-large') return 'Report exceeded its fixed local size bound.'
  if (reason === 'stale-renderer')
    return 'This report belongs to an earlier renderer generation.'
  if (reason === 'report-not-found') return 'The temporary report is no longer available.'
  if (reason === 'invalid-request')
    return 'The report request was rejected by its closed schema.'
  if (reason === 'action-unavailable') return 'The requested local action is unavailable.'
  if (reason === 'evidence-changed')
    return 'Local evidence changed while the report was being prepared. Try again.'
  return 'Local diagnostic storage is unavailable.'
}

function scopeSummary(scope: {
  readonly availability: 'included' | 'partial' | 'unavailable'
  readonly eventCount: number
}): string {
  const label =
    scope.availability === 'included'
      ? 'included'
      : scope.availability === 'partial'
        ? 'partially available'
        : 'unavailable'
  return `${label} · ${scope.eventCount} ${scope.eventCount === 1 ? 'event' : 'events'}`
}
