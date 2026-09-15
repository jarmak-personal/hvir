import { authorizeDocumentRead } from '../../viewer/document-read-authority'
import type { SkillagerExposureActionRequest } from '../../../shared/skillager-exposure-plan'
import type { SkillagerWorkspaceExposure } from '../../../shared/skillager'
import type { SkillagerRequest, SkillagerSearchRequest } from '../../../shared/skillager'
import type { IpcRegistrar } from '../authority-router'
import type { IpcDeps } from '../deps'

type SkillagerIpcDeps = Pick<IpcDeps, 'skillager'>

export function registerSkillagerIpc(ipc: IpcRegistrar, deps: SkillagerIpcDeps): void {
  ipc.handle('skillager:open-document', (request, context) =>
    deps.skillager.content.open(
      context.owner(),
      {
        ...qualifySkillagerRequest(ipc.authority, request),
        selection: {
          kind: request.selection.kind,
          skillId: boundedText(request.selection.skillId),
          libraryId:
            request.selection.libraryId === undefined
              ? undefined
              : boundedText(request.selection.libraryId),
          expectedHash:
            request.selection.expectedHash === undefined
              ? undefined
              : boundedText(request.selection.expectedHash),
          agent: request.selection.agent,
          root: ipc.authority.reconstructHostPath(request.selection.root),
          path: ipc.authority.reconstructHostPath(request.selection.path),
        },
      },
      (path) => authorizeDocumentRead(ipc.authority, { path }),
    ),
  )
  ipc.handle('skillager:read-document', (request, context) =>
    deps.skillager.content.read(context.owner(), {
      ...qualifySkillagerRequest(ipc.authority, request),
      contentId: boundedText(request.contentId),
      entry: boundedText(request.entry),
      documentEntry:
        request.documentEntry === undefined
          ? undefined
          : boundedText(request.documentEntry),
    }),
  )
  ipc.handle('skillager:release-document', (request, context) =>
    deps.skillager.content.release(context.owner(), boundedText(request.contentId)),
  )
  ipc.handle('skillager:cancel-document', (request, context) => {
    if (!request || !Number.isSafeInteger(request.requestId) || request.requestId < 1)
      throw new Error('Invalid skill document cancellation.')
    return deps.skillager.content.cancel(context.owner(), request.requestId)
  })
  ipc.handle('skillager:sync-status', (request, context) =>
    deps.skillager.librarySync.observe(
      context.owner(),
      qualifySkillagerRequest(ipc.authority, request),
    ),
  )
  ipc.handle('skillager:sync-approved', (request, context) =>
    deps.skillager.librarySync.apply(context.owner(), {
      ...qualifySkillagerRequest(ipc.authority, request),
      observationId: boundedText(request.observationId),
    }),
  )
  ipc.handle('skillager:cancel-sync', (request, context) => {
    if (!request || !Number.isSafeInteger(request.requestId) || request.requestId < 1)
      throw new Error('Invalid library sync cancellation.')
    return deps.skillager.librarySync.cancel(context.owner(), request.requestId)
  })
  ipc.handle('skillager:project-metadata', (request, context) =>
    deps.skillager.projectMetadata(context.owner(), {
      ...qualifySkillagerRequest(ipc.authority, request),
      browseAgent: request.browseAgent,
    }),
  )
  ipc.handle('skillager:prepare-project-setup', (request, context) =>
    deps.skillager.prepareProjectSetup(
      context.owner(),
      qualifySkillagerRequest(ipc.authority, request),
    ),
  )
  ipc.handle('skillager:start-project-setup', (request, context) =>
    deps.skillager.startProjectSetup(context.owner(), {
      setupId: boundedText(request?.setupId),
      cols: request.cols,
      rows: request.rows,
      position: request.position,
    }),
  )
  ipc.handle('skillager:release-project-setup', (request, context) =>
    deps.skillager.releaseProjectSetup(context.owner(), boundedText(request?.setupId)),
  )
  ipc.handle('skillager:exposure-lineage', (request, context) =>
    deps.skillager.exposureLineage(context.owner(), {
      ...qualifySkillagerRequest(ipc.authority, request),
      destination: {
        projectId: boundedText(request.destination?.projectId),
        workspaceId: boundedText(request.destination?.workspaceId),
        root: ipc.authority.workspaceRoot(
          ipc.authority.reconstructHostPath(request.destination?.root),
        ),
      },
    }),
  )
  ipc.handle('skillager:preview-exposure', (request, context) =>
    deps.skillager.previewExposure(
      context.owner(),
      qualifyExposureRequest(ipc.authority, request),
    ),
  )
  ipc.handle('skillager:apply-exposure', (request, context) =>
    deps.skillager.applyExposure(context.owner(), boundedText(request?.previewId)),
  )
  ipc.handle('skillager:release-exposure', (request, context) =>
    deps.skillager.releaseExposure(context.owner(), boundedText(request?.previewId)),
  )
  ipc.handle('skillager:cancel-exposure', (request, context) => {
    if (!request || !Number.isSafeInteger(request.requestId) || request.requestId < 1)
      throw new Error('Invalid exposure cancellation.')
    return deps.skillager.cancelExposure(context.owner(), request.requestId)
  })
  ipc.handle('skillager:cancel-review', (request, context) => {
    if (!request || !Number.isSafeInteger(request.requestId) || request.requestId < 1)
      throw new Error('Invalid review cancellation.')
    return deps.skillager.cancelReview(context.owner(), request.requestId)
  })
  ipc.handle('skillager:review', (request, context) =>
    deps.skillager.review(context.owner(), {
      ...qualifySkillagerRequest(ipc.authority, request),
      skillId: boundedText(request.skillId),
      update:
        request.update === undefined
          ? undefined
          : qualifyUpdateRequest(ipc.authority, request.update),
    }),
  )
  ipc.handle('skillager:history', (request, context) =>
    deps.skillager.history(context.owner(), {
      ...qualifySkillagerRequest(ipc.authority, request),
      skillId: boundedText(request.skillId),
    }),
  )
  ipc.handle('skillager:review-content', (request, context) =>
    deps.skillager.reviewContent(context.owner(), {
      ...qualifySkillagerRequest(ipc.authority, request),
      reviewId: boundedText(request.reviewId),
      entry: boundedText(request.entry),
      documentEntry:
        request.documentEntry === undefined
          ? undefined
          : boundedText(request.documentEntry),
    }),
  )
  ipc.handle('skillager:review-diff', (request, context) =>
    deps.skillager.reviewDiff(context.owner(), {
      ...qualifySkillagerRequest(ipc.authority, request),
      reviewId: boundedText(request.reviewId),
      fromHash:
        request.fromHash === undefined ? undefined : boundedText(request.fromHash),
    }),
  )
  ipc.handle('skillager:accept-review', (request, context) =>
    deps.skillager.acceptReview(context.owner(), {
      ...qualifySkillagerRequest(ipc.authority, request),
      reviewId: boundedText(request.reviewId),
    }),
  )
  ipc.handle('skillager:release-review', (request, context) =>
    deps.skillager.releaseReview(context.owner(), boundedText(request?.reviewId)),
  )
  ipc.handle('skillager:configure', (request, context) => {
    if (!request || typeof request.enabled !== 'boolean')
      throw new Error('Invalid Skillager setting.')
    deps.skillager.configure(context.owner(), request.enabled)
  })
  ipc.handle('skillager:probe', (request, context) => {
    if (!request) throw new Error('Invalid Skillager executable.')
    const executable =
      request.executable === undefined
        ? undefined
        : ipc.authority.reconstructHostPath(request.executable)
    if (executable && executable.hostId !== 'local')
      throw new Error('Skillager executable must be local.')
    return deps.skillager.probe(context.owner(), executable)
  })
  ipc.handle('skillager:choose-library-folder', (request, context) =>
    deps.skillager.chooseLibraryFolder(context.owner(), boundedText(request?.probeId)),
  )
  ipc.handle('skillager:initialize-library', (request, context) => {
    if (!request || typeof request.gitHistory !== 'boolean')
      throw new Error('Invalid library history choice.')
    return deps.skillager.initializeLibrary(
      context.owner(),
      boundedText(request.selectionId),
      request.gitHistory,
    )
  })
  ipc.handle('skillager:reconcile-library', (request, context) =>
    deps.skillager.reconcileLibrary(context.owner(), boundedText(request?.probeId)),
  )
  ipc.handle('skillager:connect', (request, context) => {
    if (!request || typeof request.probeId !== 'string' || request.probeId.length > 128)
      throw new Error('Invalid Skillager connection.')
    return deps.skillager.connect(context.owner(), request.probeId)
  })
  ipc.handle('skillager:disconnect', (_request, context) =>
    deps.skillager.disconnect(context.owner()),
  )
  ipc.handle('skillager:inventory', (request, context) =>
    deps.skillager.inventory(context.owner(), {
      ...qualifySkillagerRequest(ipc.authority, request),
      browseAgent: request.browseAgent,
    }),
  )
  ipc.handle('skillager:search', (request, context) =>
    deps.skillager.search(context.owner(), {
      ...qualifySkillagerRequest(ipc.authority, request),
      query: request.query,
      scope: request.scope,
      browseAgent: request.browseAgent,
      view: request.view,
      includeInstalled: request.includeInstalled,
    } satisfies SkillagerSearchRequest),
  )
  ipc.handle('skillager:cancel', (request, context) => {
    if (!request || !['search', 'inventory', 'project'].includes(request.kind))
      throw new Error('Invalid Skillager cancellation.')
    deps.skillager.cancel(context.owner(), request.kind, request.requestId)
  })
}

function qualifySkillagerRequest(
  authority: IpcRegistrar['authority'],
  request: SkillagerRequest,
): SkillagerRequest {
  if (
    !request ||
    typeof request.connectionId !== 'string' ||
    request.connectionId.length > 128
  )
    throw new Error('Invalid Skillager request.')
  return {
    connectionId: request.connectionId,
    requestId: request.requestId,
    agent: request.agent,
    workspaceRoot: authority.workspaceRoot(
      authority.reconstructHostPath(request.workspaceRoot),
    ),
  }
}

function boundedText(value: unknown): string {
  if (typeof value !== 'string' || !value || value.length > 16384 || value.includes('\0'))
    throw new Error('Invalid Skillager review selection.')
  return value
}

function qualifyExposureRequest(
  authority: IpcRegistrar['authority'],
  request: SkillagerExposureActionRequest,
): SkillagerExposureActionRequest {
  const base = qualifySkillagerRequest(authority, request)
  const destination = {
    projectId: boundedText(request.destination?.projectId),
    workspaceId: boundedText(request.destination?.workspaceId),
    root: authority.workspaceRoot(
      authority.reconstructHostPath(request.destination?.root),
    ),
  }
  if (request.action === 'remove-router')
    return {
      ...base,
      destination,
      action: request.action,
      exposure: qualifyCopy(authority, request.exposure),
    }
  if (request.action === 'plan') {
    if (
      !Array.isArray(request.origins) ||
      request.origins.length > 128 ||
      !Array.isArray(request.exposures) ||
      request.exposures.length > 128 ||
      JSON.stringify(request.plan).length > 65536
    )
      throw new Error('Invalid local action selection.')
    return {
      ...base,
      destination,
      action: 'plan',
      plan: request.plan,
      origins: request.origins.map(
        (
          origin: import('../../../shared/skillager-exposure-plan').SkillagerNativeSelection,
        ) => ({
          originId: boundedText(origin.originId),
          lineageId: boundedText(origin.lineageId),
          sourceIdentity: boundedText(origin.sourceIdentity),
          skillId: boundedText(origin.skillId),
          path: authority.reconstructHostPath(origin.path),
        }),
      ),
      exposures: request.exposures.map((copy: SkillagerWorkspaceExposure) =>
        qualifyCopy(authority, copy, true),
      ),
    }
  }
  if (
    !request.destination ||
    !['add', 'change', 'remove', 'update'].includes(request.action) ||
    !['native', 'stub'].includes(request.mode)
  )
    throw new Error('Invalid exposure action.')
  const exposure = request.exposure
  return {
    ...base,
    skillId: boundedText(request.skillId),
    mode: request.mode,
    action: request.action,
    reviewId: request.reviewId === undefined ? undefined : boundedText(request.reviewId),
    destination,
    exposure: exposure === undefined ? undefined : qualifyCopy(authority, exposure),
  }
}

function qualifyCopy(
  authority: IpcRegistrar['authority'],
  copy: SkillagerWorkspaceExposure,
  members = false,
): SkillagerWorkspaceExposure {
  const router = members ? copy.router : undefined
  if (
    router &&
    (!Array.isArray(router.skillIds) ||
      router.skillIds.length > 64 ||
      (router.memberSources &&
        (!Array.isArray(router.memberSources) || router.memberSources.length > 64)))
  )
    throw new Error('Router member selection exceeds the action limit.')
  return {
    id: boundedText(copy.id),
    agent: copy.agent,
    skillId: copy.skillId == null ? undefined : boundedText(copy.skillId),
    sourceLibraryId:
      copy.sourceLibraryId == null ? undefined : boundedText(copy.sourceLibraryId),
    target: authority.reconstructHostPath(copy.target),
    mode: boundedText(copy.mode),
    status: boundedText(copy.status),
    router: router
      ? {
          ...router,
          skillIds: router.skillIds.map(boundedText),
          memberSources: router.memberSources?.map((member) => ({
            skillId: boundedText(member.skillId),
            sourceLibraryId:
              member.sourceLibraryId == null
                ? undefined
                : boundedText(member.sourceLibraryId),
          })),
        }
      : undefined,
  }
}

function qualifyUpdateRequest(
  authority: IpcRegistrar['authority'],
  request: SkillagerExposureActionRequest,
) {
  const qualified = qualifyExposureRequest(authority, request)
  if (qualified.action !== 'update')
    throw new Error('Expected explicit Update review selection.')
  return qualified
}
