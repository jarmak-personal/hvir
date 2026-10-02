import { useEffect, useState, type ReactElement } from 'react'
import type { AgentAccessState } from '../../../shared/agent/contract'
import { ConfirmationDialog } from './ConfirmationDialog'

/** Main-issued finite decisions remain reachable independently of Settings and extension views. */
export function AgentConfirmationDialog({
  nested,
}: {
  readonly nested: boolean
}): ReactElement | null {
  const [state, setState] = useState<AgentAccessState>()
  useEffect(() => {
    let current = true,
      updated = false
    const unsubscribe = window.hvir.on('agent:access-changed', (next) => {
      if (current) {
        updated = true
        setState(next)
      }
    })
    void window.hvir.invoke('agent:access', undefined).then(
      (next) => {
        if (current && !updated) setState(next)
      },
      () => undefined,
    )
    return () => {
      current = false
      void unsubscribe()
    }
  }, [])
  const confirmation = state?.confirmations[0]
  if (!confirmation) return null
  return (
    <ConfirmationDialog
      nested={nested}
      labelledBy="agent-confirmation-title"
      actions={[
        {
          label: 'Cancel',
          kind: 'cancel',
          onSelect: () =>
            void window.hvir
              .invoke('agent:decide', { id: confirmation.id, accept: false })
              .catch(() => undefined),
        },
        {
          label: 'Allow this action',
          kind: 'destructive',
          onSelect: () =>
            void window.hvir
              .invoke('agent:decide', { id: confirmation.id, accept: true })
              .catch(() => undefined),
        },
      ]}
    >
      <h4 id="agent-confirmation-title">{confirmation.title}</h4>
      <p>
        Declared effects: {confirmation.effects.join(', ')}. Workspace:{' '}
        {confirmation.workspace ?? 'application'}. Session:{' '}
        {confirmation.session ?? 'none'}.
      </p>
      <pre>{confirmation.input}</pre>
      <p>
        Expires after 30 seconds. Native declarations do not prove complete side-effect
        detection or confinement.
      </p>
    </ConfirmationDialog>
  )
}
