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
          <p>{program.description}</p>
          <pre>
            {program.host}: {program.canonicalExecutable}
          </pre>
        </div>
      ))}
      <p>
        Programs run with your account’s access. hvir does not restrict them to read-only
        work.
      </p>
      {proposal.programs.every(
        (program) =>
          !program.configuration.args.length &&
          !Object.keys(program.configuration.env).length,
      ) ? (
        <p>No extra arguments or environment overrides.</p>
      ) : null}
      <details>
        <summary>Complete configuration</summary>
        {proposal.programs.map((program) => (
          <div key={program.connector}>
            <p>{program.connector}</p>
            <pre>{JSON.stringify(program.configuration, null, 2)}</pre>
          </div>
        ))}
      </details>
      {error ? <p role="alert">{error}</p> : null}
    </ConfirmationDialog>
  )
}
