import type { SkillagerRequest, SkillagerSearchRequest } from '../../../shared/skillager'
import type { IpcRegistrar } from '../authority-router'
import type { IpcDeps } from '../deps'

type SkillagerIpcDeps = Pick<IpcDeps, 'skillager'>

export function registerSkillagerIpc(ipc: IpcRegistrar, deps: SkillagerIpcDeps): void {
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
