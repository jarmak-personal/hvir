import { createPortal } from 'react-dom'
import { useEffect, useState, type ReactElement } from 'react'
import type { ExtensionSourceTrashProposal } from '../../../shared/extensions/source-trash'
import type { WorkspacePathRemovalCapability } from '../viewer/workspace-path-removal'
import { FileDeletionDialog } from './FileDeletionDialog'
import { useFileDeletionActions } from './use-file-deletion-actions'

/** Trusted requests enter the same Files review and operation controller as its own menu. */
export function SourceTrashDialog({
  removal,
}: {
  readonly removal: WorkspacePathRemovalCapability
}): ReactElement | null {
  const [running, setRunning] = useState<ExtensionSourceTrashProposal>()
  const [proposals, setProposals] = useState<readonly ExtensionSourceTrashProposal[]>([])
  useEffect(() => {
    let current = true,
      published = false
    const stop = window.hvir.on('extensions:source-trash-changed', (next) => {
      published = true
      if (current) setProposals(next)
    })
    void window.hvir.invoke('extensions:source-trash-proposals', undefined).then(
      (next) => {
        if (current && !published) setProposals(next)
      },
      () => undefined,
    )
    return () => {
      current = false
      void stop()
    }
  }, [])
  const proposal = running ?? proposals[0]
  return proposal
    ? createPortal(
        <RequestedTrash
          key={proposal.id}
          proposal={proposal}
          removal={removal}
          onStart={() => setRunning(proposal)}
          onFinish={() => setRunning(undefined)}
        />,
        document.body,
      )
    : null
}

function RequestedTrash({
  proposal,
  removal,
  onStart,
  onFinish,
}: {
  readonly proposal: ExtensionSourceTrashProposal
  readonly removal: WorkspacePathRemovalCapability
  readonly onStart: () => void
  readonly onFinish: () => void
}): ReactElement | null {
  const [failed, setFailed] = useState(false)
  const controller = useFileDeletionActions({
    root: proposal.root,
    directRequest: { id: proposal.id, source: proposal.path },
    launch: () =>
      window.hvir.invoke('extensions:source-trash-confirm', { id: proposal.id }),
    onDismiss: () => {
      onFinish()
      void window.hvir
        .invoke('extensions:source-trash-cancel', { id: proposal.id })
        .catch(() => undefined)
    },
    reviewPathRemoval: (target) =>
      removal.reviewWorkspacePathRemoval(proposal.root, target),
    closeCleanPath: (target) => removal.closeWorkspaceCleanPath(proposal.root, target),
    onStart,
    onComplete: onFinish,
    onError: () => setFailed(true),
  })
  return (
    <FileDeletionDialog
      controller={controller}
      allowCancelOperation
      canConfirm={!failed}
    />
  )
}
