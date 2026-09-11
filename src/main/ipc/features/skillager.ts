import type { SkillagerExposureRequest } from '../../../shared/skillager-exposure'
import type { SkillagerRequest, SkillagerSearchRequest } from '../../../shared/skillager'
import type { IpcRegistrar } from '../authority-router'
import type { IpcDeps } from '../deps'

type SkillagerIpcDeps = Pick<IpcDeps, 'skillager'>

export function registerSkillagerIpc(ipc: IpcRegistrar, deps: SkillagerIpcDeps): void {
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
          : qualifyExposureRequest(ipc.authority, request.update),
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
  ipc.handle('skillager:connect', (request, context) => {
    if (!request || typeof request.probeId !== 'string' || request.probeId.length > 128)
      throw new Error('Invalid Skillager connection.')
    return deps.skillager.connect(context.owner(), request.probeId)
  })
  ipc.handle('skillager:disconnect', (_request, context) =>
    deps.skillager.disconnect(context.owner()),
  )
  ipc.handle('skillager:inventory', (request, context) =>
    deps.skillager.inventory(
      context.owner(),
      qualifySkillagerRequest(ipc.authority, request),
    ),
  )
  ipc.handle('skillager:search', (request, context) =>
    deps.skillager.search(context.owner(), {
      ...qualifySkillagerRequest(ipc.authority, request),
      query: request.query,
      scope: request.scope,
    } satisfies SkillagerSearchRequest),
  )
  ipc.handle('skillager:cancel', (request, context) => {
    if (!request || !['search', 'inventory'].includes(request.kind))
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
  request: SkillagerExposureRequest,
): SkillagerExposureRequest {
  const base = qualifySkillagerRequest(authority, request)
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
    destination: {
      projectId: boundedText(request.destination.projectId),
      workspaceId: boundedText(request.destination.workspaceId),
      root: authority.workspaceRoot(
        authority.reconstructHostPath(request.destination.root),
      ),
    },
    exposure:
      exposure === undefined
        ? undefined
        : {
            id: boundedText(exposure.id),
            skillId: boundedText(exposure.skillId),
            target: authority.reconstructHostPath(exposure.target),
            mode: boundedText(exposure.mode),
            status: boundedText(exposure.status),
          },
  }
}
