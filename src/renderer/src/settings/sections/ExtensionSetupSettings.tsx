import { useEffect, useRef, useState, type ReactElement } from 'react'
import type {
  ExtensionSetupReview,
  ExtensionSetupRow,
} from '../../../../shared/extensions/setup-review'
import type { AgentAccessState } from '../../../../shared/agent/contract'
import { useModalKeyboard } from '../../workbench/use-modal-keyboard'

/** Trusted setup chrome owns subscriptions and cancellation; main owns the immutable review. */
export function ExtensionSetupSettings({
  installation,
  disabled,
  onSettled,
}: {
  readonly installation: string
  readonly disabled: boolean
  readonly onSettled: () => void
}): ReactElement {
  const [review, setReview] = useState<ExtensionSetupReview>()
  const [busy, setBusy] = useState(false),
    [notice, setNotice] = useState('')
  const [agent, setAgent] = useState<AgentAccessState>()
  const request = useRef<string | undefined>(undefined)
  const lifetime = useRef({ generation: 0 })
  const templateRequest = useRef(0)
  const saving = useRef<string | undefined>(undefined)
  const close = () => {
    templateRequest.current++
    const id = request.current
    request.current = undefined
    if (id)
      void window.hvir.invoke('extensions:setup-cancel', { request: id }).catch(() => {})
    setReview(undefined)
    setBusy(false)
  }
  const cancel = () => {
    if (
      review &&
      (review.phase === 'saving' ||
        (review.phase === 'ready' && saving.current === review.request))
    ) {
      void window.hvir
        .invoke('extensions:setup-cancel', { request: review.request })
        .catch(() => {})
      setReview({ ...review, phase: 'stopping' })
    } else close()
  }
  useEffect(() => {
    const life = lifetime.current
    life.generation++
    const stop = window.hvir.on('extensions:setup-changed', (next) => {
      if (request.current === next.request) setReview(next)
    })
    let agentPublished = false
    const stopAgent = window.hvir.on('agent:access-changed', (value) => {
      agentPublished = true
      setAgent(value)
    })
    let current = true
    void window.hvir.invoke('agent:access', undefined).then(
      (value) => {
        if (current && !agentPublished) setAgent(value)
      },
      () => {},
    )
    return () => {
      life.generation++
      current = false
      close()
      void stop()
      void stopAgent()
    }
  }, [installation])
  useEffect(() => {
    if (disabled) close()
  }, [disabled])

  const start = async () => {
    templateRequest.current++
    const id = crypto.randomUUID()
    request.current = id
    setNotice('')
    setBusy(true)
    try {
      const next = await window.hvir.invoke('extensions:setup-import', {
        installationId: installation,
        request: id,
      })
      if (request.current === id)
        setReview((previous) =>
          next && previous?.request === id && previous.phase === 'ended'
            ? previous
            : next,
        )
    } catch (reason) {
      if (request.current === id) {
        setNotice(message(reason))
        setReview(undefined)
      }
    } finally {
      if (request.current === id) setBusy(false)
    }
  }
  const select = async (id: string, selected: boolean) => {
    if (!review || busy) return
    const token = review.request
    setBusy(true)
    try {
      const rows = review.rows
        .filter((row) => (row.id === id ? selected : row.selected))
        .map((row) => row.id)
      const next = await window.hvir.invoke('extensions:setup-select', {
        request: token,
        rows,
      })
      if (request.current === token)
        setReview((previous) => (previous?.phase === 'ended' ? previous : next))
    } catch (reason) {
      if (request.current === token) setNotice(message(reason))
    } finally {
      if (request.current === token) setBusy(false)
    }
  }
  const apply = async () => {
    if (!review || busy) return
    const token = review.request
    const generation = lifetime.current.generation
    saving.current = token
    setBusy(true)
    try {
      const next = await window.hvir.invoke('extensions:setup-apply', { request: token })
      if (request.current === token) setReview(next)
    } catch (reason) {
      if (request.current === token) setNotice(message(reason))
    } finally {
      if (saving.current === token) saving.current = undefined
      if (lifetime.current.generation === generation) onSettled()
      if (request.current === token) {
        setBusy(false)
      }
    }
  }
  return (
    <div className="extension-setup-controls">
      <details>
        <summary>Setup…</summary>
        <div className="settings-actions">
          <button
            type="button"
            className="hvir-button"
            disabled={disabled || busy}
            onClick={() => {
              const generation = lifetime.current.generation
              const copy = ++templateRequest.current
              const current = () =>
                lifetime.current.generation === generation &&
                templateRequest.current === copy
              setNotice('')
              void window.hvir
                .invoke('extensions:setup-template', { installationId: installation })
                .then(async (text) => {
                  if (!current()) return
                  await navigator.clipboard.writeText(text)
                  if (current())
                    setNotice(
                      'Template copied. Ask your agent to fill in the paths, then review the JSON file here.',
                    )
                })
                .catch((reason: unknown) => {
                  if (current()) setNotice(message(reason))
                })
            }}
          >
            Get setup template
          </button>
          <button
            type="button"
            className="hvir-button"
            disabled={disabled || busy || !!review}
            onClick={() => void start()}
          >
            Review setup…
          </button>
        </div>
      </details>
      {busy && !review ? (
        <p role="status" className="hvir-meta">
          Checking setup…{' '}
          <button type="button" className="hvir-button" onClick={cancel}>
            Cancel
          </button>
        </p>
      ) : null}
      {notice && !review ? (
        <p role="status" className="hvir-meta">
          {notice}
        </p>
      ) : null}
      {review ? (
        <ExtensionSetupDialog
          review={review}
          busy={busy}
          notice={notice}
          agent={agent}
          onCancel={cancel}
          onSelect={(id, selected) => void select(id, selected)}
          onApply={() => void apply()}
        />
      ) : null}
    </div>
  )
}

function ExtensionSetupDialog({
  review,
  busy,
  notice,
  agent,
  onCancel,
  onSelect,
  onApply,
}: {
  readonly review: ExtensionSetupReview
  readonly busy: boolean
  readonly notice: string
  readonly agent?: AgentAccessState
  readonly onCancel: () => void
  readonly onSelect: (id: string, selected: boolean) => void
  readonly onApply: () => void
}): ReactElement {
  const dialog = useRef<HTMLElement>(null)
  useModalKeyboard(dialog, onCancel, true)
  const existing = review.rows.filter((row) => row.state === 'unchanged')
  const changes = review.rows.filter((row) => row.state !== 'unchanged')
  const selected = changes.filter((row) => row.selected && row.state === 'ready').length
  const finished =
    review.phase === 'finished' || review.phase === 'ended' || review.phase === 'stopping'
  return (
    <div className="modal-backdrop nested">
      <section
        ref={dialog}
        role="dialog"
        aria-modal="true"
        aria-labelledby="extension-setup-title"
        className="project-dialog extension-setup-dialog"
        tabIndex={-1}
      >
        <h3 id="extension-setup-title">Review setup</h3>
        <p className="hvir-meta">
          {review.name} · {review.file}
        </p>
        <div className="extension-setup-rows">
          {changes.map((row) => (
            <SetupRow
              key={row.id}
              row={row}
              disabled={busy || review.phase !== 'ready'}
              onSelect={onSelect}
            />
          ))}
          {changes.some((row) => row.kind === 'program') ? (
            <p className="hvir-meta">
              Programs use your account’s access on the selected host.
            </p>
          ) : null}
          {review.rows.some((row) => row.kind === 'agent' && row.agentAccess) &&
          !agent?.enabled ? (
            <p className="hvir-meta">
              App-wide Agent access is {agent ? 'off' : 'unavailable'}. This choice does
              not turn it on.
            </p>
          ) : null}
          {existing.length ? (
            <details className="extension-setup-existing">
              <summary>{existing.length} settings already configured</summary>
              {existing.map((row) => (
                <SetupRow key={row.id} row={row} disabled onSelect={onSelect} />
              ))}
            </details>
          ) : null}
          {review.capacityError ? <p role="alert">{review.capacityError}</p> : null}
          {review.explanation || notice ? (
            <p role="status">{review.explanation || notice}</p>
          ) : null}
          {review.phase === 'stopping' ? (
            <p role="status" className="hvir-meta">
              Stopping… Waiting for the current change to finish.
            </p>
          ) : null}
          {review.phase === 'saving' ? (
            <p role="status" className="hvir-meta">
              Saving selected changes…
            </p>
          ) : null}
        </div>
        <div className="dialog-actions">
          <button
            className="hvir-button"
            type="button"
            data-modal-initial
            onClick={onCancel}
          >
            {finished ? 'Close' : 'Cancel'}
          </button>
          {!finished ? (
            <button
              className="hvir-button confirmation-action-primary"
              type="button"
              disabled={
                busy || review.phase !== 'ready' || !selected || !!review.capacityError
              }
              onClick={onApply}
            >
              Apply {selected} {selected === 1 ? 'change' : 'changes'}
            </button>
          ) : null}
        </div>
      </section>
    </div>
  )
}
function SetupRow({
  row,
  disabled,
  onSelect,
}: {
  readonly row: ExtensionSetupRow
  readonly disabled: boolean
  readonly onSelect: (id: string, selected: boolean) => void
}): ReactElement {
  const [reveal, setReveal] = useState(false)
  const status =
    row.state === 'saved'
      ? 'Saved'
      : row.state === 'blocked'
        ? 'Needs attention'
        : row.state === 'declined'
          ? 'Not applied'
          : row.state === 'failed'
            ? 'Failed'
            : row.state === 'interrupted-uncertain'
              ? 'Check current access'
              : undefined
  return (
    <div className="extension-setup-row">
      {row.state === 'ready' ? (
        <input
          type="checkbox"
          className="hvir-input"
          checked={row.selected}
          disabled={disabled}
          aria-label={row.title}
          onChange={(event) => onSelect(row.id, event.target.checked)}
        />
      ) : null}
      <div>
        <strong>{row.title}</strong>
        {row.location ? (
          <p className="hvir-meta">
            {row.location.hostId} · {row.location.path}
          </p>
        ) : null}
        {status ? <p className="hvir-meta">{status}</p> : null}
        {row.retainedSetting !== undefined &&
        (row.state === 'interrupted-uncertain' ||
          (row.state === 'saved' && !row.retainedSetting)) ? (
          <p className="hvir-meta">
            {row.retainedSetting
              ? 'The reviewed access is currently retained.'
              : 'The reviewed access is not currently retained.'}
          </p>
        ) : null}
        {row.explanation ? (
          <p role="status" className="hvir-meta">
            {row.explanation}
          </p>
        ) : null}
        {row.previousPrograms?.length || row.previousSources?.length ? (
          <p className="hvir-meta">Replaces saved access</p>
        ) : null}
        {row.program || row.source ? (
          <details>
            <summary>Details</summary>
            {row.program ? (
              <>
                <p>
                  Selected: {row.program.host} · {row.program.executable}
                </p>
                <p>Resolved: {row.program.canonicalExecutable}</p>
                <p>
                  Arguments:{' '}
                  {row.program.configuration.args.length
                    ? JSON.stringify(row.program.configuration.args)
                    : 'none'}
                </p>
                <p>
                  Environment:{' '}
                  {Object.keys(row.program.configuration.env).length
                    ? Object.entries(row.program.configuration.env)
                        .map(([key, value]) => `${key}=${reveal ? value : '••••'}`)
                        .join(', ')
                    : 'inherited'}
                </p>
                {Object.keys(row.program.configuration.env).length ||
                row.previousPrograms?.some(
                  (entry) => Object.keys(entry.configuration.env).length,
                ) ? (
                  <button
                    type="button"
                    className="hvir-button"
                    onClick={() => setReveal(!reveal)}
                  >
                    {reveal ? 'Hide values' : 'Reveal values'}
                  </button>
                ) : null}
                {row.previousPrograms?.map((entry) => (
                  <div key={entry.connector}>
                    {entry.host !== row.program!.host ||
                    entry.executable !== row.program!.executable ? (
                      <p>
                        Previous launcher: {entry.host} · {entry.executable}
                      </p>
                    ) : null}
                    {entry.canonicalExecutable !== row.program!.canonicalExecutable ? (
                      <p>Previous resolved program: {entry.canonicalExecutable}</p>
                    ) : null}
                    {JSON.stringify(entry.configuration.args) !==
                    JSON.stringify(row.program!.configuration.args) ? (
                      <p>
                        Previous arguments:{' '}
                        {entry.configuration.args.length
                          ? JSON.stringify(entry.configuration.args)
                          : 'none'}
                      </p>
                    ) : null}
                    {JSON.stringify(entry.configuration.env) !==
                    JSON.stringify(row.program!.configuration.env) ? (
                      <>
                        <p>
                          Previous environment:{' '}
                          {Object.keys(entry.configuration.env).length
                            ? Object.entries(entry.configuration.env)
                                .map(
                                  ([key, value]) => `${key}=${reveal ? value : '••••'}`,
                                )
                                .join(', ')
                            : 'inherited'}
                        </p>
                        <p>Environment overrides changed.</p>
                      </>
                    ) : null}
                  </div>
                ))}
              </>
            ) : null}
            {row.source ? (
              <p>
                {row.source.declaration.description} ·{' '}
                {row.source.declaration.mode === 'read-only'
                  ? 'Read selected files. No file writing.'
                  : row.source.declaration.mode === 'delivery-source'
                    ? 'Capture exported files from this folder.'
                    : 'Write and remove delivered files in this selected workspace.'}
              </p>
            ) : null}
            {row.previousSources?.map((entry, index) => (
              <p key={index}>
                Previous: {entry.root?.hostId} · {entry.root?.path}
              </p>
            ))}
          </details>
        ) : null}
      </div>
    </div>
  )
}
function message(reason: unknown): string {
  return reason instanceof Error ? reason.message : 'Setup could not be completed'
}
