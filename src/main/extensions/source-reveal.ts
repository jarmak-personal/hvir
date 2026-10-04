import { containsHostPath, hostPathEquals, type HostPath } from '../../shared/host-path'
import { extensionObject, extensionText } from '../../shared/extensions/validation'
import { readSourcePath, type ExtensionSourceApprovalOwner } from './source-approval'
import type { SourceCaller } from './source-reading'
import type { RendererOwner } from '../renderer-resource-scopes'

/** Read-only navigation into Files; grants never confer deletion or outside-project access. */
export class ExtensionSourceReveal {
  constructor(
    private readonly approvals: ExtensionSourceApprovalOwner,
    private readonly publish: (
      owner: RendererOwner,
      request: {
        readonly workspaceId: string
        readonly root: HostPath
        readonly path: HostPath
      },
    ) => void,
  ) {}

  async reveal(
    caller: SourceCaller,
    value: unknown,
    owner: RendererOwner,
  ): Promise<null> {
    if (!caller.allowed)
      throw new Error('Files reveal requires an ordinary human-selected view')
    const input = extensionObject(value),
      source = extensionText(input['source'], 'source identity', 80),
      path = readSourcePath(input['path']),
      grant = this.approvals.get(caller.activation, source),
      context = caller.context()
    if (
      !grant?.root ||
      grant.declaration.context !== 'workspace' ||
      !grant.workspaceId ||
      input['workspaceId'] !== grant.workspaceId ||
      !context?.root ||
      context.value.workspace?.id !== grant.workspaceId ||
      !hostPathEquals(context.root, grant.root) ||
      !containsHostPath(grant.root, path)
    )
      throw new Error('Reveal requires the exact granted current workspace directory')
    const root = grant.root,
      host = this.approvals.hosts.hostById(root.hostId)
    if (!host) throw new Error('Files reveal host is unavailable')
    const current = () => {
      caller.current()
      caller.signal.throwIfAborted()
      if (
        !context.current() ||
        host.connectionState !== 'connected' ||
        this.approvals.get(caller.activation, source) !== grant ||
        this.approvals.hosts.hostById(root.hostId) !== host ||
        caller.context()?.value.workspace?.id !== grant.workspaceId ||
        !caller.context()?.root ||
        !hostPathEquals(caller.context()!.root!, root)
      )
        throw new Error('Files reveal source or workspace was revoked')
    }
    current()
    if (!hostPathEquals(await host.realpath(root), root))
      throw new Error('Granted workspace root changed')
    current()
    const canonical = await host.realpath(path)
    current()
    if (!containsHostPath(root, canonical))
      throw new Error('Reveal directory escapes the workspace')
    if ((await host.stat(canonical)).type !== 'dir')
      throw new Error('Reveal selects an ordinary directory in Files')
    current()
    const rechecked = await host.realpath(path)
    current()
    const recheckedRoot = await host.realpath(root)
    current()
    if (!hostPathEquals(rechecked, canonical) || !hostPathEquals(recheckedRoot, root))
      throw new Error('Reveal directory changed during observation')
    current()
    this.publish(owner, { workspaceId: grant.workspaceId, root, path: canonical })
    return null
  }
}
