import { useEffect, useState, type ReactElement } from 'react'
import type { ExtensionSourceRequestProposal } from '../../../shared/extensions/source-access'
import { ConfirmationDialog } from './ConfirmationDialog'

/** Only main-issued canonical roots are presented; the guest cannot approve access. */
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
      nested={false}
      labelledBy="source-confirmation-title"
      busy={busy}
      actions={[
        { label: 'Not now', kind: 'cancel', onSelect: () => respond(false) },
        {
          label: 'Allow read-only access',
          kind: 'primary',
          onSelect: () => respond(true),
        },
      ]}
    >
      <h4 id="source-confirmation-title">Read with {proposal.name}</h4>
      <p>{proposal.description}</p>
      <pre>
        {proposal.root.hostId}: {proposal.root.path}
      </pre>
      <p>
        Allow this extension to read selected files in this folder. This does not permit
        writing files or grant access to agents.
      </p>
      {error ? <p role="alert">{error}</p> : null}
    </ConfirmationDialog>
  )
}
