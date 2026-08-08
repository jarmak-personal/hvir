import { hostPathEquals } from '../../shared'
import type { ManagedPty } from '../pty/pty-supervisor'

export type PreparedDocumentReviewTerminal = Pick<
  ManagedPty,
  | 'id'
  | 'instanceId'
  | 'ownerId'
  | 'ownerGeneration'
  | 'hostId'
  | 'workspaceRoot'
  | 'providerId'
  | 'capabilities'
  | 'profileId'
  | 'launchRevision'
  | 'providerContractVersion'
  | 'composerSubmitMode'
>

/** Captures the exact live terminal authority that a prepared delivery binds. */
export function snapshotDocumentReviewTerminal(
  terminal: ManagedPty,
): PreparedDocumentReviewTerminal {
  return {
    id: terminal.id,
    instanceId: terminal.instanceId,
    ownerId: terminal.ownerId,
    ownerGeneration: terminal.ownerGeneration,
    hostId: terminal.hostId,
    workspaceRoot: terminal.workspaceRoot,
    providerId: terminal.providerId,
    capabilities: terminal.capabilities,
    profileId: terminal.profileId,
    launchRevision: terminal.launchRevision,
    providerContractVersion: terminal.providerContractVersion,
    composerSubmitMode: terminal.composerSubmitMode,
  }
}

export function matchesPreparedDocumentReviewTerminal(
  current: ManagedPty,
  prepared: PreparedDocumentReviewTerminal,
): boolean {
  return (
    current.id === prepared.id &&
    current.instanceId === prepared.instanceId &&
    current.ownerId === prepared.ownerId &&
    current.ownerGeneration === prepared.ownerGeneration &&
    current.hostId === prepared.hostId &&
    current.providerId === prepared.providerId &&
    current.profileId === prepared.profileId &&
    current.launchRevision === prepared.launchRevision &&
    current.providerContractVersion === prepared.providerContractVersion &&
    current.composerSubmitMode === prepared.composerSubmitMode &&
    sameCapabilities(current.capabilities, prepared.capabilities) &&
    hostPathEquals(current.workspaceRoot, prepared.workspaceRoot)
  )
}

function sameCapabilities(
  left: ManagedPty['capabilities'],
  right: ManagedPty['capabilities'],
): boolean {
  return (
    left.sessionIdentity === right.sessionIdentity &&
    left.exactResume === right.exactResume &&
    left.contextPresentation === right.contextPresentation &&
    left.reviewInsertContractRevision === right.reviewInsertContractRevision &&
    left.reviewSendNowContractRevision === right.reviewSendNowContractRevision
  )
}
