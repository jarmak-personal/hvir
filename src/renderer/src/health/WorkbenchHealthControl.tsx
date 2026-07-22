import { useState, type ReactElement } from 'react'

import type { WorkbenchHealthItem } from '../../../shared'
import { ConfirmationDialog } from '../workbench/ConfirmationDialog'
import { useWorkbenchHealth } from './use-workbench-health'
import { useDiagnosticEvidence } from './use-diagnostic-evidence'
import { DiagnosticReportDialog } from '../diagnostics/DiagnosticReportDialog'
import {
  ResponsivenessDiagnosticsIndicator,
  ResponsivenessDiagnosticsPanel,
} from '../diagnostics/ResponsivenessDiagnosticsControls'
import { useResponsivenessDiagnostics } from '../diagnostics/use-responsiveness-diagnostics'

export function WorkbenchHealthControl(): ReactElement {
  const [open, setOpen] = useState(false)
  const [reportOpen, setReportOpen] = useState(false)
  const health = useWorkbenchHealth()
  const evidence = useDiagnosticEvidence()
  const responsiveness = useResponsivenessDiagnostics()
  const unresolved = health.snapshot.items.filter((item) => item.state !== 'resolved')
  const newCount = unresolved.filter((item) => item.state === 'open').length
  const critical = unresolved.some((item) => item.severity === 'critical')
  const label = !health.ready
    ? 'Workbench health: loading'
    : health.snapshot.evidence === 'unavailable'
      ? `Workbench health: evidence unavailable, ${unresolved.length} unresolved fault${unresolved.length === 1 ? '' : 's'}`
      : unresolved.length === 0
        ? 'Workbench health: no unresolved faults'
        : `Workbench health: ${unresolved.length} unresolved fault${unresolved.length === 1 ? '' : 's'}, ${newCount} open`

  return (
    <>
      <ResponsivenessDiagnosticsIndicator
        diagnostics={responsiveness}
        onOpen={() => setOpen(true)}
      />
      <button
        type="button"
        className={`workbench-health-toggle${critical ? ' critical' : ''}${newCount > 0 ? ' new' : ''}${health.snapshot.evidence === 'unavailable' ? ' unavailable' : ''}`}
        aria-label={label}
        title={label}
        onClick={() => setOpen(true)}
      >
        <span aria-hidden="true">◇</span>
        {unresolved.length > 0 ? <b>{unresolved.length}</b> : null}
      </button>
      {open ? (
        <ConfirmationDialog
          labelledBy="workbench-health-title"
          actions={[{ label: 'Close', kind: 'cancel', onSelect: () => setOpen(false) }]}
          className="workbench-health-dialog"
        >
          <header className="workbench-health-heading">
            <div>
              <h2 id="workbench-health-title">Workbench health</h2>
              <p>
                Application faults observed by hvir, separate from terminal attention.
              </p>
            </div>
            <EvidenceState evidence={health.snapshot.evidence} />
          </header>
          {health.snapshot.items.length === 0 ? (
            <p className="workbench-health-empty">No workbench faults observed.</p>
          ) : (
            <ol className="workbench-health-list">
              {health.snapshot.items.map((item) => (
                <HealthItem
                  item={item}
                  key={`${item.kind}:${item.occurrenceId}`}
                  onAcknowledge={() => health.acknowledge(item.occurrenceId)}
                />
              ))}
            </ol>
          )}
          {health.snapshot.dropped > 0 ? (
            <p className="workbench-health-dropped">
              {health.snapshot.dropped} older health item
              {health.snapshot.dropped === 1 ? '' : 's'} omitted by the local bound.
            </p>
          ) : null}
          <DiagnosticEvidenceDetails evidence={evidence} />
          <ResponsivenessDiagnosticsPanel diagnostics={responsiveness} />
          <button
            type="button"
            className="prepare-diagnostic-report"
            onClick={() => {
              setOpen(false)
              setReportOpen(true)
            }}
          >
            Prepare diagnostic report
          </button>
        </ConfirmationDialog>
      ) : null}
      {reportOpen ? (
        <DiagnosticReportDialog onClose={() => setReportOpen(false)} />
      ) : null}
    </>
  )
}

function DiagnosticEvidenceDetails({
  evidence,
}: {
  readonly evidence: ReturnType<typeof useDiagnosticEvidence>
}): ReactElement {
  const state = evidence.state
  return (
    <section className="workbench-health-storage" aria-label="Local diagnostic evidence">
      <h3>Local diagnostic evidence</h3>
      {state ? (
        <>
          <p>
            Recent memory is bounded to {state.recent.maxEvents} events /{' '}
            {formatBytes(state.recent.maxBytes)}.
          </p>
          {state.journal ? (
            <>
              <p>
                Journal bound: {state.journal.maxSegments} ×{' '}
                {formatBytes(state.journal.maxSegmentBytes)}, retained for{' '}
                {state.journal.retentionHours / 24} days.
              </p>
              <code>{state.journal.location}</code>
            </>
          ) : (
            <p>Durable journaling is disabled in this build.</p>
          )}
        </>
      ) : (
        <p>Loading local evidence details…</p>
      )}
      <button
        type="button"
        disabled={evidence.deleting || !state}
        onClick={evidence.deleteEvidence}
      >
        {evidence.deleting ? 'Deleting evidence…' : 'Delete local evidence'}
      </button>
      {evidence.message ? <p role="status">{evidence.message}</p> : null}
    </section>
  )
}

function HealthItem({
  item,
  onAcknowledge,
}: {
  readonly item: WorkbenchHealthItem
  readonly onAcknowledge: () => void
}): ReactElement {
  return (
    <li className={`workbench-health-item ${item.severity} ${item.state}`}>
      <div className="workbench-health-item-title">
        <strong>{healthKindLabel(item.kind)}</strong>
        <span>
          {item.severity} · {item.state}
        </span>
      </div>
      <p>
        {item.owner === 'window-manager' ? 'Window manager' : 'React error boundary'} ·
        renderer {item.ownerId}, generation {item.ownerGeneration} · {item.count}{' '}
        occurrence
        {item.count === 1 ? '' : 's'}
      </p>
      <p>Classification: {item.classification.replaceAll('-', ' ')}</p>
      <p>
        First {formatTime(item.firstObservedAt)} · last {formatTime(item.lastObservedAt)}
      </p>
      {item.recoveryOutcome ? (
        <p>Recovery: {recoveryLabel(item.recoveryOutcome)}</p>
      ) : null}
      <code>{item.correlation}</code>
      {item.state === 'open' ? (
        <button type="button" onClick={onAcknowledge}>
          Acknowledge
        </button>
      ) : null}
    </li>
  )
}

function EvidenceState({
  evidence,
}: {
  readonly evidence: 'durable' | 'memory-only' | 'unavailable'
}): ReactElement {
  const label =
    evidence === 'durable'
      ? 'Bounded local evidence'
      : evidence === 'memory-only'
        ? 'Memory-only evidence'
        : 'Durable evidence unavailable'
  return <span className={`workbench-health-evidence ${evidence}`}>{label}</span>
}

function healthKindLabel(kind: WorkbenchHealthItem['kind']): string {
  if (kind === 'react-render-contained') return 'Render failure contained'
  if (kind === 'main-document-load-failed') return 'Workbench document failed to load'
  if (kind === 'renderer-process-exited') return 'Renderer exited unexpectedly'
  return 'Renderer became unresponsive'
}

function recoveryLabel(
  outcome: NonNullable<WorkbenchHealthItem['recoveryOutcome']>,
): string {
  return outcome.replaceAll('-', ' ')
}

function formatTime(value: string): string {
  return new Date(value).toLocaleString()
}

function formatBytes(value: number): string {
  return value >= 1024 * 1024
    ? `${value / (1024 * 1024)} MiB`
    : `${Math.round(value / 1024)} KiB`
}
