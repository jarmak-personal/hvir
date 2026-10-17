import { useEffect, useState, type ReactElement } from 'react'
import type { ExtensionSourceRequestProposal } from '../../../shared/extensions/source-access'
import { hostPathEquals } from '../../../shared/host-path'
import { ConfirmationDialog } from './ConfirmationDialog'

/** Preparation facts stay in trusted chrome; the guest cannot observe or approve them. */
export function SourceConfirmationDialog(): ReactElement | null {
  const [proposals, setProposals] = useState<readonly ExtensionSourceRequestProposal[]>(
    [],
  )
  useEffect(() => {
    let current = true,
      published = false
    const unsubscribe = window.hvir.on('extensions:source-proposals-changed', (next) => {
      if (!current) return
      published = true
      setProposals(next)
    })
    void window.hvir.invoke('extensions:source-proposals', undefined).then(
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
  return proposal ? <SourceDecision key={proposal.id} proposal={proposal} /> : null
}
function SourceDecision({
  proposal,
}: {
  readonly proposal: ExtensionSourceRequestProposal
}): ReactElement {
  const [busy, setBusy] = useState(false),
    [error, setError] = useState<string>()
  const respond = (accepted: boolean): void => {
    setBusy(true)
    void window.hvir
      .invoke('extensions:source-decide', { id: proposal.id, accepted })
      .catch((reason: unknown) => {
        setBusy(false)
        setError(
          reason instanceof Error
            ? reason.message
            : 'Read access decision could not be delivered.',
        )
      })
  }
  return (
    <ConfirmationDialog
      className="extension-confirmation-dialog"
      nested={false}
      labelledBy="source-confirmation-title"
      busy={busy}
      actions={[
        { label: 'Not now', kind: 'cancel', onSelect: () => respond(false) },
        {
          label: 'Allow read-only access',
          kind: 'primary',
          disabled: proposal.state !== 'ready',
          onSelect: () => respond(true),
        },
      ]}
    >
      <h4 id="source-confirmation-title">Read with {proposal.name}</h4>
      <p>{proposal.description}</p>
      {proposal.state === 'ready' ? (
        <>
          <p>Folder to read</p>
          <pre>
            {proposal.root.hostId}: {proposal.root.path}
          </pre>
          {!hostPathEquals(proposal.root, proposal.reportedRoot) ? (
            <>
              <p>Requested folder</p>
              <pre>
                {proposal.reportedRoot.hostId}: {proposal.reportedRoot.path}
              </pre>
            </>
          ) : null}
        </>
      ) : (
        <>
          <p>Requested folder (not verified)</p>
          <pre>
            {proposal.reportedRoot.hostId}: {proposal.reportedRoot.path}
          </pre>
        </>
      )}
      {proposal.state === 'preparing' ? <p>Checking this folder…</p> : null}
      {proposal.state === 'failed' ? (
        <p role="alert">
          {proposal.explanation} No read access was granted. Choose Not now to return.
        </p>
      ) : null}
      <p>
        Allow this extension to read selected files in this folder. This does not permit
        writing files or grant access to agents.
      </p>
      {error ? <p role="alert">{error}</p> : null}
    </ConfirmationDialog>
  )
}
