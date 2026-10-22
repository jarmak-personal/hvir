import { useEffect, useState, type ReactElement } from 'react'
import type { ExtensionConnectionProposal } from '../../../shared/extensions/connectors'
import { ConfirmationDialog } from './ConfirmationDialog'

/** Displays main-issued bindings; this renderer supplies consent, never program configuration. */
export function ConnectionConfirmationDialog({
  nested,
}: {
  readonly nested: boolean
}): ReactElement | null {
  const [proposals, setProposals] = useState<readonly ExtensionConnectionProposal[]>([])
  useEffect(() => {
    let current = true,
      published = false
    const unsubscribe = window.hvir.on(
      'extensions:connection-proposals-changed',
      (next) => {
        if (!current) return
        published = true
        setProposals(next)
      },
    )
    void window.hvir.invoke('extensions:connection-proposals', undefined).then(
      (next) => {
        if (current && !published) setProposals(next)
      },
      () => undefined,
    )
    return () => {
      current = false
      void unsubscribe()
    }
  }, [])
  const proposal = proposals[0]
  return proposal ? (
    <ConnectionDecision key={proposal.id} proposal={proposal} nested={nested} />
  ) : null
}

function ConnectionDecision({
  proposal,
  nested,
}: {
  readonly proposal: ExtensionConnectionProposal
  readonly nested: boolean
}): ReactElement {
  const [busy, setBusy] = useState(false),
    [error, setError] = useState<string>()
  const respond = (accepted: boolean): void => {
    setBusy(true)
    void window.hvir
      .invoke('extensions:connection-decide', { id: proposal.id, accepted })
      .catch((reason: unknown) => {
        setBusy(false)
        setError(
          reason instanceof Error
            ? reason.message
            : 'Connection decision could not be delivered. Check current program access before trying again.',
        )
      })
  }
  return (
    <ConfirmationDialog
      className="extension-confirmation-dialog"
      nested={nested}
      labelledBy="connection-confirmation-title"
      busy={busy}
      actions={[
        { label: 'Not now', kind: 'cancel', onSelect: () => respond(false) },
        { label: 'Connect', kind: 'primary', onSelect: () => respond(true) },
      ]}
    >
      <h4 id="connection-confirmation-title">Connect {proposal.name}</h4>
      {proposal.programs.map((program) => (
        <div key={program.connector}>
          <p>Run {proposal.name}</p>
          <pre>
            {program.host}: {program.canonicalExecutable}
          </pre>
        </div>
      ))}
      {proposal.source ? (
        <div>
          <p>Read selected files in this project</p>
          <p>{proposal.source.workspace}</p>
          <pre>
            {proposal.source.root.hostId}: {proposal.source.root.path}
          </pre>
        </div>
      ) : null}
      {proposal.programs.length ? (
        <p>The program runs with your account’s access.</p>
      ) : null}
      <details>
        <summary>Details</summary>
        {proposal.programs.map((program) => (
          <div key={program.connector}>
            <p>{program.description}</p>
            <p>
              {program.context === 'workspace'
                ? 'This program can run for projects on this computer. Commands start in their project folder; that folder does not limit access to your account.'
                : 'This connector uses hvir’s local scratch folder, separate from project selection.'}
            </p>
            <p>{program.connector}</p>
            <pre>{JSON.stringify(program.configuration, null, 2)}</pre>
          </div>
        ))}
        {proposal.source ? (
          <p>
            Only selected files in this exact project/worktree. Program and read access
            can be revoked independently.
          </p>
        ) : null}
      </details>
      {error ? <p role="alert">{error}</p> : null}
    </ConfirmationDialog>
  )
}
