import type { HostConnectionState } from '../../src/shared/fs-types'
import { vi } from 'vitest'
import { asHostId, hostPath, localPath } from '../../src/shared/host-path'
import type { ExtensionActivation } from '../../src/main/extensions/activation'
import type { ProjectHost } from '../../src/main/project-host/project-host'
import {
  ExtensionConnectorApprovalOwner,
  type ConnectorHostCatalog,
} from '../../src/main/extensions/connector-approval'
import {
  ExtensionConnectorExecutionOwner,
  type ConnectorCaller,
} from '../../src/main/extensions/connector-execution'
import type {
  ExtensionConnectorConfiguration,
  ExtensionConnectorApproval,
} from '../../src/shared/extensions/connectors'

export function connectorFixture(
  context: 'application' | 'workspace' = 'application',
  outputBytes = 4 * 1024 * 1024,
  scratch = '/state/scratch',
  revision?: ExtensionActivation['revision'],
) {
  const activation: ExtensionActivation = {
    installationId: 'installation',
    generation: 'generation',
    revision:
      revision ??
      ({
        hash: 'revision',
        manifest: {
          id: 'example',
          name: 'Example',
          version: '1.0.0',
          contract: '1.0',
          requiredCapabilities: ['connector.execute'],
          optionalCapabilities: [],
          access: [],
          views: [
            {
              id: 'main',
              title: 'Main',
              entry: 'index.html',
              placement: 'application',
              representations: ['view'],
            },
          ],
          connectors: [
            {
              id: 'tool',
              description: 'Installed tool',
              context,
              timeoutMs: 120_000,
              outputBytes,
              environment: ['TOOL_HOME'],
            },
          ],
        },
        assets: new Map(),
        warnings: [],
        root: localPath('/packages/revision'),
      } as unknown as ExtensionActivation['revision']),
  }
  const listeners = new Set<() => void>()
  const host = {
    hostId: asHostId(context === 'application' ? 'local' : 'remote'),
    connectionState: 'connected' as HostConnectionState,
    watchTier: 'polling',
    connect: vi.fn(() => Promise.resolve()),
    realpath: vi.fn<ProjectHost['realpath']>((path: ReturnType<typeof localPath>) =>
      Promise.resolve(path),
    ),
    stat: vi.fn<ProjectHost['stat']>(() =>
      Promise.resolve({
        type: 'file',
        mode: 0o755,
        size: 3,
        mtimeMs: 0,
      }),
    ),
    exec: vi.fn<ProjectHost['exec']>(() =>
      Promise.resolve({
        code: 0,
        signal: null,
        stdout: 'result',
        stderr: '',
      }),
    ),
  }
  const finiteExec = {
    tryExec: vi.fn(
      (
        command: string,
        args: readonly string[],
        opts?: Parameters<ProjectHost['exec']>[2],
      ) => host.exec(command, args, opts),
    ),
  }
  const connectorHost = {
    ...host,
    finiteExec,
    get connectionState() {
      return host.connectionState
    },
  }
  const hosts: ConnectorHostCatalog = {
    local: { hostId: asHostId('local') },
    listHosts: () => [
      {
        hostId: host.hostId,
        label: host.hostId,
        kind: context === 'application' ? 'local' : 'ssh',
        connectionState: 'connected',
        watchTier: 'polling',
      },
    ],
    hostById: (id) => (id === host.hostId ? connectorHost : undefined),
    materializeHost: (id) => {
      if (id !== host.hostId) throw new Error('Unknown host')
      return Promise.resolve(connectorHost)
    },
    onHostStateChange: (listener) => {
      listeners.add(listener)
      return () => {
        listeners.delete(listener)
      }
    },
  }
  let state: unknown = []
  const active = new Map([[activation.installationId, activation]])
  const write = vi.fn((value: unknown, current: () => void) => {
    current()
    state = JSON.parse(JSON.stringify(value)) as unknown
    return Promise.resolve()
  })
  const authority = {
    active,
    assertWritable: vi.fn(() => Promise.resolve()),
    readConnectorApprovals: () => Promise.resolve(state),
    saveConnectorApprovals: write,
  }
  const approvals = new ExtensionConnectorApprovalOwner(
    hosts,
    authority,
    (id, connector) => execution?.revoke(id, connector),
  )
  const execution = new ExtensionConnectorExecutionOwner(
    approvals,
    localPath(scratch),
    authority.assertWritable,
  )
  const controller = new AbortController()
  let demand = true,
    live = true
  const workspace = {
    value: {
      surface: 'viewer' as const,
      visible: true,
      workspace: { id: '42-workspace', name: 'Workspace', host: host.hostId },
    },
    root: hostPath(host.hostId, '/workspace'),
    current: () => live,
  }
  const caller: ConnectorCaller = {
    activation,
    view: 'view',
    signal: controller.signal,
    current: () => {
      if (!live || active.get(activation.installationId) !== activation)
        throw new Error('Revoked caller')
    },
    context: (id) => (id === workspace.value.workspace.id ? workspace : undefined),
    demand: () => demand,
  }
  const input = {
    connector: 'tool',
    host: host.hostId,
    args: ['status'],
    ...(context === 'workspace' ? { workspace: workspace.value.workspace.id } : {}),
  }
  const approve = async (
    executable = '/installed/tool',
    configuration: ExtensionConnectorConfiguration = {
      args: ['--json'],
      env: { TOOL_HOME: '/library' },
    },
  ): Promise<ExtensionConnectorApproval> => {
    await approvals.start()
    const prepared = await approvals.prepare(
      {
        installationId: activation.installationId,
        connector: 'tool',
        host: host.hostId,
        executable,
        configuration,
      },
      () => undefined,
    )
    await approvals.approve(prepared.token)
    return prepared.approval
  }
  return {
    activation,
    active,
    host,
    hosts,
    finiteExec,
    authority,
    approvals,
    execution,
    controller,
    caller,
    input,
    approve,
    write,
    state: () => state,
    setState: (value: unknown) => {
      state = value
    },
    endDemand: () => {
      demand = false
      execution.revalidate()
    },
    endContext: () => {
      live = false
      execution.revalidate()
    },
    disconnect: () => {
      host.connectionState = 'disconnected'
      for (const listener of listeners) listener()
    },
    dispose: () => {
      execution.dispose()
      approvals.dispose()
    },
  }
}
