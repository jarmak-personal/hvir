import {
  containsHostPath,
  isProjectFileEntryName,
  joinHostPath,
  type ExternalFileGrantResult,
  type ExternalMoveGrantResult,
  type ExternalMovePickerSelection,
  type HostPath,
  type ProjectFileCreateKind,
  type ProjectFileDeletionDisclosure,
  type ProjectFileExternalMoveDisclosure,
  type ProjectFileOperationProgress,
  type ProjectFileOperationResult,
  type ProjectFileOperationStartResult,
  type ProjectFileOrganizationRequest,
} from '../../shared'
import type { RendererOwner } from '../renderer-resource-scopes'
import { createProjectEntry } from './create-project-entry'
import type { ExternalFileGrantRegistry } from './external-file-grants'
import { copyExternalFileGrant } from './external-file-copy'
import type { ExternalMovePickerPort } from './electron-external-move-picker'
import {
  acquireExternalMove as acquireExternalMoveGrant,
  discloseExternalMove as discloseExternalMoveCapability,
  startExternalMove,
} from './external-file-move-operation'
import {
  assertNormalizedAbsoluteProjectPath,
  boundedProjectFileReason,
  proveRealProjectDirectory,
} from './project-file-confinement'
import { organizeProjectEntry } from './project-entry-organization'
import {
  discloseProjectEntryDeletion,
  startProjectEntryDeletion,
  type ProjectFileDeletionInput,
} from './project-entry-deletion-operation'
import {
  projectEntryCancelled,
  projectEntryDestination,
  projectEntryFailed,
} from './project-entry-operation-results'
import {
  ProjectFileOperationRuntime,
  type ProjectFileOperationResourcePort,
  type ProjectFileWorkspaceAuthority,
} from './project-file-operation-runtime'
import { ProjectFileStagingCleanup } from './staging-cleanup'
import {
  PROJECT_FILE_COPY_LIMITS,
  type ProjectFileCopyLimits,
} from './verified-project-copy'

export {
  PROJECT_FILE_OPERATION_DEADLINE_MS,
  type ProjectFileOperationResourceLease,
  type ProjectFileOperationResourcePort,
  type ProjectFileWorkspaceAuthority,
} from './project-file-operation-runtime'

export interface ProjectFileCreateInput {
  readonly owner: RendererOwner
  readonly workspaceRoot: HostPath
  readonly destinationDirectory: HostPath
  readonly name: string
  readonly kind: ProjectFileCreateKind
}

export interface ProjectFileExternalCopyInput {
  readonly owner: RendererOwner
  readonly workspaceRoot: HostPath
  readonly destinationDirectory: HostPath
  readonly grantId: string
  readonly grantGeneration: number
  readonly publish: (progress: ProjectFileOperationProgress) => void
}

export interface ProjectFileOrganizationInput {
  readonly owner: RendererOwner
  readonly request: ProjectFileOrganizationRequest
  readonly publish: (progress: ProjectFileOperationProgress) => void
}

export type { ProjectFileDeletionInput } from './project-entry-deletion-operation'

export class ProjectFileOperationCoordinator {
  private readonly runtime: ProjectFileOperationRuntime
  private readonly stagingCleanup: ProjectFileStagingCleanup

  constructor(
    private readonly options: {
      readonly resolveWorkspace: (
        root: HostPath,
      ) => ProjectFileWorkspaceAuthority | undefined
      readonly resources: ProjectFileOperationResourcePort
      readonly externalFiles?: ExternalFileGrantRegistry
      readonly externalMovePicker?: ExternalMovePickerPort
      readonly readClipboardPaths?: () => readonly string[]
      readonly createOperationId?: () => string
      readonly createStagingId?: () => string
      readonly createTemporaryId?: () => string
      readonly deadlineMs?: number
      readonly copyLimits?: ProjectFileCopyLimits
      readonly stagingCleanup?: ProjectFileStagingCleanup
    },
  ) {
    this.stagingCleanup = options.stagingCleanup ?? new ProjectFileStagingCleanup()
    this.runtime = new ProjectFileOperationRuntime({
      resolveWorkspace: options.resolveWorkspace,
      resources: options.resources,
      createOperationId: options.createOperationId,
      deadlineMs: options.deadlineMs,
    })
  }

  async create(input: ProjectFileCreateInput): Promise<ProjectFileOperationResult> {
    this.assertCreateInput(input)
    const identity = await this.runtime.prepare(input.owner, input.workspaceRoot)
    const admission = this.runtime.activate(identity)
    if (admission.outcome === 'busy') {
      return { outcome: 'busy', reason: admission.reason, items: [] }
    }
    const { operation } = admission
    try {
      const item = await createProjectEntry({
        host: identity.host,
        workspaceRoot: identity.workspaceRoot,
        canonicalRoot: identity.canonicalRoot,
        destinationDirectory: input.destinationDirectory,
        name: input.name,
        kind: input.kind,
        signal: operation.abort.signal,
        assertCurrent: () => this.runtime.assertCurrent(identity, operation.abort.signal),
      })
      return {
        outcome: 'completed',
        operationId: identity.operationId,
        generation: identity.generation,
        items: [item],
      }
    } finally {
      await this.runtime.release(operation)
    }
  }

  acquireClipboard(owner: RendererOwner): Promise<ExternalFileGrantResult> {
    this.runtime.assertRenderer(owner)
    const paths = this.options.readClipboardPaths?.() ?? []
    return this.requireExternalFiles().acquire(owner, paths)
  }

  acquireDropped(
    owner: RendererOwner,
    paths: readonly string[],
  ): Promise<ExternalFileGrantResult> {
    this.runtime.assertRenderer(owner)
    return this.requireExternalFiles().acquire(owner, paths)
  }

  discloseExternalMove(owner: RendererOwner): ProjectFileExternalMoveDisclosure {
    return discloseExternalMoveCapability(
      this.runtime,
      this.requireExternalFiles(),
      this.options.externalMovePicker,
      owner,
    )
  }

  async acquireExternalMove(
    owner: RendererOwner,
    selection: ExternalMovePickerSelection,
  ): Promise<ExternalMoveGrantResult> {
    return acquireExternalMoveGrant(
      this.runtime,
      this.requireExternalFiles(),
      this.options.externalMovePicker,
      owner,
      selection,
    )
  }

  async copyExternal(
    input: ProjectFileExternalCopyInput,
  ): Promise<ProjectFileOperationStartResult> {
    this.assertExternalCopyInput(input)
    const identity = await this.runtime.prepare(input.owner, input.workspaceRoot)
    const canonicalDestinationDirectory = await proveRealProjectDirectory(
      identity.host,
      identity.workspaceRoot,
      identity.canonicalRoot,
      input.destinationDirectory,
    )
    const stagingReservation = this.stagingCleanup.reserve(identity.host)
    if (!stagingReservation) return stagingBusy()
    let grant
    try {
      grant = this.requireExternalFiles().consume(
        input.owner,
        input.grantId,
        input.grantGeneration,
      )
    } catch (reason) {
      stagingReservation.release()
      throw reason
    }
    let admission
    try {
      admission = this.runtime.activate(identity, input.publish, grant.items.length)
    } catch (reason) {
      grant.revoke()
      stagingReservation.release()
      throw reason
    }
    if (admission.outcome === 'busy') {
      grant.revoke()
      stagingReservation.release()
      return admission
    }
    const { operation } = admission
    this.runtime.launch(
      operation,
      () =>
        copyExternalFileGrant({
          operationId: identity.operationId,
          generation: identity.generation,
          visibleDestinationDirectory: input.destinationDirectory,
          canonicalDestinationDirectory,
          destinationHost: identity.host,
          grant,
          signal: operation.abort.signal,
          assertCurrent: () => {
            this.runtime.assertCurrent(identity, operation.abort.signal)
            grant.assertCurrent()
          },
          revalidateDestinationDirectory: () =>
            proveRealProjectDirectory(
              identity.host,
              identity.workspaceRoot,
              identity.canonicalRoot,
              input.destinationDirectory,
            ),
          limits: this.options.copyLimits ?? PROJECT_FILE_COPY_LIMITS,
          createStagingId: this.options.createStagingId,
          cleanupStaging: (host, path) => this.stagingCleanup.cleanup(host, path),
          onProgress: (completedItems, totalItems, currentName) => {
            operation.latestCompletedItems = completedItems
            this.runtime.publish(operation, {
              workspaceRoot: identity.workspaceRoot,
              operationId: identity.operationId,
              generation: identity.generation,
              phase: operation.abort.signal.aborted ? 'cancelling' : 'copying',
              completedItems,
              totalItems,
              ...(currentName ? { currentName } : {}),
            })
          },
        }),
      (failure) => {
        const reason = boundedProjectFileReason(
          operation.abort.signal.reason ?? failure,
          'The external file operation stopped unexpectedly',
        )
        return {
          outcome: 'completed',
          operationId: identity.operationId,
          generation: identity.generation,
          items: grant.items.map((item) => ({
            itemId: item.itemId,
            destination: joinHostPath(input.destinationDirectory, item.name),
            status: operation.abort.signal.aborted ? 'cancelled' : 'failed',
            effect: 'none',
            reason,
          })),
        }
      },
      () => {
        grant.revoke()
        stagingReservation.release()
      },
    )
    return started(identity.operationId, identity.generation, grant.items.length)
  }

  async moveExternal(
    input: ProjectFileExternalCopyInput,
  ): Promise<ProjectFileOperationStartResult> {
    this.assertExternalCopyInput(input)
    return startExternalMove({
      runtime: this.runtime,
      externalFiles: this.requireExternalFiles(),
      stagingCleanup: this.stagingCleanup,
      limits: this.options.copyLimits ?? PROJECT_FILE_COPY_LIMITS,
      createStagingId: this.options.createStagingId,
      input,
    })
  }

  async organize(
    input: ProjectFileOrganizationInput,
  ): Promise<ProjectFileOperationStartResult> {
    this.assertOrganizationInput(input)
    const { request } = input
    const identity = await this.runtime.prepare(input.owner, request.workspaceRoot)
    const stagingReservation =
      request.action === 'duplicate'
        ? this.stagingCleanup.reserve(identity.host)
        : undefined
    if (request.action === 'duplicate' && !stagingReservation) return stagingBusy()
    let admission
    try {
      admission = this.runtime.activate(identity, input.publish, 1)
    } catch (reason) {
      stagingReservation?.release()
      throw reason
    }
    if (admission.outcome === 'busy') {
      stagingReservation?.release()
      return admission
    }
    const { operation } = admission
    this.runtime.launch(
      operation,
      async () => {
        this.runtime.publish(operation, {
          workspaceRoot: identity.workspaceRoot,
          operationId: identity.operationId,
          generation: identity.generation,
          phase:
            request.action === 'rename'
              ? 'renaming'
              : request.action === 'move'
                ? 'moving'
                : 'duplicating',
          completedItems: 0,
          totalItems: 1,
        })
        const item = await organizeProjectEntry({
          request,
          host: identity.host,
          canonicalRoot: identity.canonicalRoot,
          signal: operation.abort.signal,
          assertCurrent: () =>
            this.runtime.assertCurrent(identity, operation.abort.signal),
          limits: this.options.copyLimits ?? PROJECT_FILE_COPY_LIMITS,
          createStagingId: this.options.createStagingId,
          createTemporaryId: this.options.createTemporaryId,
          ...(request.action === 'move'
            ? { acquireStaging: () => this.stagingCleanup.reserve(identity.host) }
            : {}),
          cleanupStaging: (host, path) => this.stagingCleanup.cleanup(host, path),
        })
        return {
          outcome: 'completed',
          operationId: identity.operationId,
          generation: identity.generation,
          items: [item],
        }
      },
      (reason) => ({
        outcome: 'completed',
        operationId: identity.operationId,
        generation: identity.generation,
        items: [
          (operation.abort.signal.aborted ? projectEntryCancelled : projectEntryFailed)(
            request.source,
            projectEntryDestination(request),
            boundedProjectFileReason(
              operation.abort.signal.reason ?? reason,
              'The project entry operation stopped unexpectedly',
            ),
          ),
        ],
      }),
      () => stagingReservation?.release(),
    )
    return started(identity.operationId, identity.generation, 1)
  }

  async discloseDeletion(
    owner: RendererOwner,
    workspaceRoot: HostPath,
    source: HostPath,
  ): Promise<ProjectFileDeletionDisclosure> {
    this.assertDeletionTarget(workspaceRoot, source)
    return discloseProjectEntryDeletion(this.runtime, owner, workspaceRoot, source)
  }

  async delete(
    input: ProjectFileDeletionInput,
  ): Promise<ProjectFileOperationStartResult> {
    this.assertDeletionTarget(input.request.workspaceRoot, input.request.source)
    if (!['recoverable', 'permanent'].includes(input.request.confirmedRecovery)) {
      throw new Error('Invalid deletion confirmation')
    }
    return startProjectEntryDeletion(
      this.runtime,
      this.options.copyLimits ?? PROJECT_FILE_COPY_LIMITS,
      input,
    )
  }

  cancel(owner: RendererOwner, operationId: string, generation: number): boolean {
    return this.runtime.cancel(owner, operationId, generation)
  }

  async dispose(): Promise<void> {
    this.options.externalFiles?.dispose()
    await this.runtime.dispose()
    await this.stagingCleanup.dispose()
  }

  private assertCreateInput(input: ProjectFileCreateInput): void {
    this.assertAvailable()
    if (!isProjectFileEntryName(input.name)) throw new Error('Invalid entry name')
    if (input.kind !== 'file' && input.kind !== 'directory') {
      throw new Error('Invalid create operation kind')
    }
    assertDestination(input.workspaceRoot, input.destinationDirectory)
  }

  private assertExternalCopyInput(input: ProjectFileExternalCopyInput): void {
    this.assertAvailable()
    assertDestination(input.workspaceRoot, input.destinationDirectory)
    if (!input.grantId || input.grantId.length > 256) {
      throw new Error('Invalid external file grant')
    }
    if (!Number.isSafeInteger(input.grantGeneration) || input.grantGeneration < 1) {
      throw new Error('Invalid external file grant generation')
    }
  }

  private assertOrganizationInput(input: ProjectFileOrganizationInput): void {
    this.assertAvailable()
    const { request } = input
    assertNormalizedAbsoluteProjectPath(request.workspaceRoot)
    assertNormalizedAbsoluteProjectPath(request.source)
    if (!containsHostPath(request.workspaceRoot, request.source)) {
      throw new Error('The source escapes the workspace')
    }
    if (request.action === 'rename') {
      if (!isProjectFileEntryName(request.name)) throw new Error('Invalid entry name')
      return
    }
    assertDestination(request.workspaceRoot, request.destinationDirectory)
    if (request.action === 'duplicate' && !isProjectFileEntryName(request.name)) {
      throw new Error('Invalid entry name')
    }
  }

  private assertDeletionTarget(workspaceRoot: HostPath, source: HostPath): void {
    this.assertAvailable()
    assertNormalizedAbsoluteProjectPath(workspaceRoot)
    assertNormalizedAbsoluteProjectPath(source)
    if (!containsHostPath(workspaceRoot, source)) {
      throw new Error('The deletion target escapes the workspace')
    }
  }

  private assertAvailable(): void {
    if (this.runtime.isDisposed) throw new Error('Project file operations are disposed')
  }

  private requireExternalFiles(): ExternalFileGrantRegistry {
    this.assertAvailable()
    if (!this.options.externalFiles) {
      throw new Error('External file operations are unavailable')
    }
    return this.options.externalFiles
  }
}

function assertDestination(workspaceRoot: HostPath, destination: HostPath): void {
  assertNormalizedAbsoluteProjectPath(workspaceRoot)
  assertNormalizedAbsoluteProjectPath(destination)
  if (!containsHostPath(workspaceRoot, destination)) {
    throw new Error('The destination directory escapes the workspace')
  }
}

function stagingBusy(): ProjectFileOperationStartResult {
  return {
    outcome: 'busy',
    reason: 'Pending staging cleanup has reached the host safety limit',
  }
}

function started(
  operationId: string,
  generation: number,
  itemCount: number,
): ProjectFileOperationStartResult {
  return { outcome: 'started', operationId, generation, itemCount }
}
