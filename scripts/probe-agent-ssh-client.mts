import { readFile } from 'node:fs/promises'
import { createHash, randomUUID } from 'node:crypto'
import { resolve } from 'node:path'
import { SshHost } from '../src/main/project-host/ssh-host'
import { LocalSshIdentitySource } from '../src/main/project-host/ssh-identity-source'
import { RemoteAgentClientOwner } from '../src/main/agent/remote-client-owner'
import {
  RemoteClientCache,
  type CachedRemoteClient,
} from '../src/main/agent/remote-client-cache'
import { identity as cacheIdentity } from '../src/main/agent/remote-client-cache-control'
import { AgentStreamAdmission } from '../src/main/agent/stream-admission'
import { AgentForwardScopeOwner } from '../src/main/agent/forward-scope'
import { AgentWorkbenchCommandOwner } from '../src/main/agent/command-owner'
import { LocalAgentAccessOwner } from '../src/main/agent/access-owner'
import { ExtensionContextOwner } from '../src/main/extensions/context-owner'
import { ExtensionActionOwner } from '../src/main/extensions/action-owner'
import { AgentReportOwner } from '../src/main/viewer/agent-report-owner'
import { hostPath, joinHostPath } from '../src/shared/host-path'
import { staticAgentReference } from '../src/shared/agent/commands'
import type { ProjectState } from '../src/shared/workspace-types'
import type { ExtensionActivation } from '../src/main/extensions/activation'
import type { ExtensionView } from '../src/shared/extensions/workbench'
import type { ExtensionInvocation } from '../src/shared/extensions/contract'

let operation = 'setup',
  status: number | null | undefined
async function main(): Promise<void> {
  // Real SFTP/Unix-forward/process probe. The presentation adapter is intentionally headless;
  // installed Electron and human walkthrough acceptance are separate gates.
  const target = process.argv[2],
    binary = resolve(process.argv[3] ?? ''),
    interruption = process.argv[4] ?? 'upload'
  if (!['directory', 'marker', 'upload'].includes(interruption))
    throw new Error('Select directory, marker or upload interruption')
  if (!['linux-x64', 'linux-arm64', 'macos-x64', 'macos-arm64'].includes(target ?? ''))
    throw new Error('Select the exact built client target and file')
  const required = (key: string): string => {
    const value = process.env[key]
    if (!value) throw new Error(`Missing ${key}`)
    return value
  }
  const alias = 'agent-client-probe',
    local = {
      readFile: (path: import('../src/shared/host-path').HostPath) => readFile(path.path),
    },
    identityPath = required('HVIR_REAL_SSH_IDENTITY_FILE'),
    identity = new LocalSshIdentitySource(local, [identityPath])
  const host = new SshHost({
    config: {
      alias,
      hostname: required('HVIR_REAL_SSH_HOST'),
      port: Number(required('HVIR_REAL_SSH_PORT')),
      user: required('HVIR_REAL_SSH_USER'),
      identityFiles: [identityPath],
    },
    identitySource: identity,
    trust: {
      trustedHostKey: () => required('HVIR_REAL_SSH_HOST_KEY'),
      rememberHostKey: () => Promise.reject(new Error('Fixture trust is pinned')),
    },
    prompter: { prompt: () => Promise.resolve(undefined) },
  })
  const root = hostPath(host.hostId, required('HVIR_REAL_SSH_ROOT_PARENT')),
    workspace = `workspace:${alias}:${root.path}`,
    owner = { id: 1, generation: 1 },
    lifetime = new AbortController(),
    instance = randomUUID()
  const bytes = await readFile(binary),
    sha256 = createHash('sha256').update(bytes).digest('hex')
  const state = {
    revision: 1,
    root,
    activeProjectId: 'fixture',
    activeWorkspaceId: workspace,
    connectionState: 'connected',
    watchTier: 'polling',
    projects: [
      {
        id: 'fixture',
        displayName: 'Fixture',
        registeredRoot: root,
        activeWorkspaceId: workspace,
        connectionState: 'connected',
        watchTier: 'polling',
        workspaces: [
          {
            id: workspace,
            root,
            name: 'Fixture',
            main: true,
            closed: false,
            missing: false,
            repository: false,
            changedFiles: 0,
          },
        ],
      },
    ],
  } satisfies ProjectState
  const contexts = new ExtensionContextOwner({
    projectState: () => state,
    observeProjects: () => () => undefined,
    sessions: { observationSnapshot: () => [], observe: () => () => undefined },
    ptys: { observationSnapshot: () => [], observe: () => () => undefined },
  })
  const activation = {
    installationId: 'probe',
    generation: 'accepted',
    revision: {
      hash: 'accepted-revision',
      manifest: {
        name: 'Protocol fixture',
        views: [{ id: 'main', title: 'Main', placement: 'workspace' }],
        actions: [
          {
            id: 'hello',
            title: 'Hello',
            view: 'main',
            agents: true,
            effects: { delete: false, replace: false },
          },
        ],
      },
    },
  } as unknown as ExtensionActivation
  const access = new LocalAgentAccessOwner(
      () => undefined,
      () => Promise.resolve(),
      { allowed: () => ['probe'], writable: () => true, signal: () => lifetime.signal },
    ),
    scopes = new AgentForwardScopeOwner(() => undefined),
    reports = new AgentReportOwner(() => undefined)
  let document: string | undefined, view: ExtensionView | undefined
  const actions = new ExtensionActionOwner({
    open: (_owner, installationId, contributionId, options, admit) => {
      admit()
      view = {
        id: 'fixture-view',
        installationId,
        contributionId,
        extensionName: 'Fixture',
        title: 'Main',
        partition: 'headless',
        url: 'hvir-extension://fixture/main',
        role: 'view',
        context: contexts.admit(owner, options.context).value,
      }
      return Promise.resolve(view)
    },
    dispatch: (id, invocation: ExtensionInvocation) => {
      queueMicrotask(() =>
        actions.result(id, invocation.id, {
          hello: true,
          workspace: invocation.context.workspace?.id,
        }),
      )
      return true
    },
    assertView: () => lifetime.signal.throwIfAborted(),
    runnable: () => undefined,
    cancelAction: () => undefined,
  })
  const commands = new AgentWorkbenchCommandOwner({
    access,
    contexts: () => contexts,
    activeInstallations: () => [activation],
    activeInstallation: () => activation,
    openView: (_owner, installationId, contributionId, options, admit) => {
      admit()
      return Promise.resolve({
        id: 'visible-fixture',
        installationId,
        contributionId,
        extensionName: 'Fixture',
        title: 'Main',
        partition: 'headless',
        url: 'hvir-extension://fixture/main',
        role: 'view',
        context: contexts.admit(owner, options.context).value,
      })
    },
    invokeAction: (...args) => actions.invoke(...args),
    reports,
    presentationOwner: () => owner,
    assertOwner: () => lifetime.signal.throwIfAborted(),
    host: (id) => (id === host.hostId ? host : undefined),
    openDocument: (_owner, value) => {
      document = value.path.path
    },
    forwardScopes: scopes,
    reference: (command) => Promise.resolve(staticAgentReference(command, () => ({}))!),
  })
  const cache = new RemoteClientCache(),
    acquire = cache.acquire.bind(cache)
  let cacheWork: Promise<CachedRemoteClient> | undefined
  cache.acquire = (...args) => {
    cacheWork = acquire(...args)
    return cacheWork
  }
  const admission = new AgentStreamAdmission((request, connection) =>
      commands.run(request, connection),
    ),
    remote = new RemoteAgentClientOwner(
      {
        instance,
        enabled: () => access.snapshot().enabled,
        assets: () => Promise.resolve({ bytes, sha256, target: target! }),
        admission,
        scopes,
        changed: () => undefined,
      },
      cache,
    )
  async function invoke(
    environment: Awaited<ReturnType<typeof remote.environment>>,
    argv: string[],
    input?: string,
  ) {
    operation = argv[0] ?? 'command'
    status = undefined
    const executable = environment.env.HVIR_AGENT_CLIENT
    if (!executable || !environment.env.HVIR_AGENT_ENDPOINT)
      throw new Error('Remote client setup unavailable')
    if (input !== undefined) {
      const handle = host.execStream(executable, argv, {
        env: { ...environment.env, HVIR_AGENT_WORKSPACE: workspace },
        input,
      })
      let stdout = '',
        stderr = ''
      handle.onStdout((data) => {
        stdout += data
      })
      handle.onStderr((data) => {
        stderr += data
      })
      const result = await new Promise<{ code: number | null }>((done, reject) => {
        const timer = setTimeout(() => {
          handle.dispose()
          reject(new Error('SSH stdin probe timed out'))
        }, 20_000)
        handle.onExit((value) => {
          clearTimeout(timer)
          done(value)
        })
        handle.onError((_error) => {
          clearTimeout(timer)
          reject(new Error('SSH client stream transport failed'))
        })
      })
      status = result.code
      status = result.code
      if (result.code !== 0 || stderr)
        throw new Error(`SSH client probe status failure (${result.code})`)
      return JSON.parse(stdout) as Record<string, unknown>
    }
    const result = await host.exec(executable, argv, {
      env: { ...environment.env, HVIR_AGENT_WORKSPACE: workspace },
      signal: AbortSignal.timeout(20_000),
      maxBuffer: 256 * 1024,
    })
    status = result.code
    if (result.code !== 0 || result.stderr)
      throw new Error(`SSH client probe status failure (${result.code})`)
    return JSON.parse(result.stdout) as Record<string, unknown>
  }
  try {
    await host.connect()
    await access.configure({ enabled: true, confirmDestructive: false })
    operation = `interrupted-${interruption}-preparation`
    const write = host.fileTransfer.writeFileChunksExclusive.bind(host.fileTransfer),
      execute = host.exec.bind(host)
    let disconnected: Promise<void> | undefined
    let partial: import('../src/shared/host-path').HostPath | undefined,
      partialIdentity = '',
      partialSha256 = '',
      partialBytes = 0
    const interrupt = async (
      path: import('../src/shared/host-path').HostPath,
      bytes?: Uint8Array,
    ): Promise<void> => {
      partial = path
      partialIdentity = await cacheIdentity(host, path, lifetime.signal)
      if (bytes) {
        partialSha256 = createHash('sha256').update(bytes).digest('hex')
        partialBytes = bytes.length
      }
      disconnected = host.dispose()
      await disconnected
    }
    host.exec = async (command, args, options) => {
      const result = await execute(command, args, options)
      if (
        interruption === 'directory' &&
        !partial &&
        result.code === 0 &&
        args[1]?.includes('\nmkdir "$1"\nprivate "$1"') &&
        /\/c\.[a-f0-9]{64}\.[a-f0-9-]{36}$/.test(args[3] ?? '')
      )
        await interrupt(hostPath(host.hostId, args[3]!))
      return result
    }
    host.fileTransfer.writeFileChunksExclusive = (path, chunks, options) => {
      if (
        partial ||
        !(interruption === 'marker'
          ? path.path.endsWith('/owned.json')
          : interruption === 'upload' && path.path.includes('/upload.'))
      )
        return write(path, chunks, options)
      return write(
        path,
        (async function* () {
          for await (const chunk of chunks) {
            const bytes = interruption === 'marker' ? chunk.subarray(0, 2) : chunk
            yield bytes
            await interrupt(path, bytes)
            throw new Error('Owned SSH preparation fixture disconnected')
          }
        })(),
        options,
      )
    }
    const failed = await remote.environment(host, lifetime.signal)
    host.fileTransfer.writeFileChunksExclusive = write
    host.exec = execute
    if (!partial || !disconnected || !failed.env.HVIR_AGENT_UNAVAILABLE)
      throw new Error('Interrupted SSH preparation did not return unavailable')
    await disconnected
    await cacheWork?.catch(() => undefined)
    operation = `interrupted-${interruption}-reconnect-connect`
    await host.connect()
    const verifyRetained = async (): Promise<void> => {
      operation = `interrupted-${interruption}-retained-identity`
      if ((await cacheIdentity(host, partial!, lifetime.signal)) !== partialIdentity)
        throw new Error('Original interrupted SSH object identity was not preserved')
      if (interruption === 'directory') {
        if ((await host.readdir(partial!)).length !== 0)
          throw new Error('Unreceipted directory changed')
        return
      }
      operation = `interrupted-${interruption}-retained-bytes`
      const retainedHash = createHash('sha256')
      let retainedBytes = 0
      for await (const chunk of host.fileTransfer.readFileChunks(partial!, {
        signal: lifetime.signal,
      })) {
        retainedBytes += chunk.length
        if (retainedBytes > partialBytes)
          throw new Error('Interrupted object exceeded its fixture bound')
        retainedHash.update(chunk)
      }
      if (retainedBytes !== partialBytes || retainedHash.digest('hex') !== partialSha256)
        throw new Error('Original interrupted SSH bytes changed')
      if (interruption !== 'upload') return
      operation = 'interrupted-upload-retained-marker'
      const pendingMarker = await host.readTextFilePrefix(
        joinHostPath(partial!, '..', 'owned.json'),
        4096,
      )
      const pending = JSON.parse(pendingMarker.content) as {
        pending?: boolean
        hash?: string
        upload?: { identity?: string }
      }
      if (
        !pendingMarker.complete ||
        pending.pending !== true ||
        pending.hash !== sha256 ||
        pending.upload?.identity !== partialIdentity
      )
        throw new Error('Original interrupted SSH revision marker was not preserved')
    }
    await verifyRetained()
    operation = 'interrupted-upload-reconnect-prepare'
    const a = await remote.environment(host, lifetime.signal),
      b = await remote.environment(host, lifetime.signal)
    if (!a.env.HVIR_AGENT_CLIENT || !b.env.HVIR_AGENT_CLIENT) {
      const reason = a.env.HVIR_AGENT_UNAVAILABLE ?? ''
      operation = reason.includes('unrecognized')
        ? 'prepare-unrecognized'
        : reason.includes('replaced')
          ? 'prepare-replaced'
          : reason.includes('capacity')
            ? 'prepare-capacity'
            : reason.includes('revoked')
              ? 'prepare-revoked'
              : 'prepare-unavailable'
      throw new Error('Fresh SSH client preparation failed')
    }
    if (
      a.env.HVIR_AGENT_CLIENT ===
      joinHostPath(
        partial,
        ...(interruption === 'directory' ? ['hvir-agent'] : ['..', 'hvir-agent']),
      ).path
    )
      throw new Error('Fresh SSH client reused the pending revision')
    await verifyRetained()
    if (a.env.HVIR_AGENT_CLIENT !== b.env.HVIR_AGENT_CLIENT)
      throw new Error('Second terminal did not reuse the exact client')
    const listing = await invoke(a, ['workspaces'])
    if (!JSON.stringify(listing).includes(workspace))
      throw new Error('Remote context discovery failed')
    await invoke(a, ['open', '--path', 'document.txt'])
    if (document !== joinHostPath(root, 'document.txt').path)
      throw new Error('Admitted document dispatch failed')
    await invoke(a, ['report', '--stdin'], 'Real SSH report 😃')
    if (reports.snapshot()[0]?.workspace !== workspace)
      throw new Error('Default report destination changed')
    const result = await invoke(a, [
      'run',
      '--extension',
      'probe',
      '--action',
      'hello',
      '--input',
      '{}',
    ])
    if (!JSON.stringify(result).includes(workspace))
      throw new Error('Authorized action lost destination')
    await invoke(a, ['help', 'report'])
    const clientPath = a.env.HVIR_AGENT_CLIENT
    if (!clientPath) throw new Error('Remote client path unavailable')
    const marker = joinHostPath(hostPath(host.hostId, clientPath), '..', 'owned.json'),
      markerStat = await host.stat(marker)
    if ((markerStat.mode & 0o777) !== 0o600)
      throw new Error('Actual SFTP cache marker mode is not private')
    await remote.revoke()
    await host.stat(hostPath(host.hostId, a.env.HVIR_AGENT_ENDPOINT!)).then(
      () => {
        throw new Error('Owned SSH socket leaf survived revocation')
      },
      (reason: unknown) => {
        if (
          !reason ||
          typeof reason !== 'object' ||
          !('code' in reason) ||
          !['2', 'ENOENT'].includes(String(reason.code))
        )
          throw new Error('SSH socket removal could not be verified')
      },
    )
    const stale = await host.exec(clientPath, ['workspaces'], {
      env: { ...a.env, HVIR_AGENT_WORKSPACE: workspace },
      signal: AbortSignal.timeout(12_000),
      maxBuffer: 4096,
    })
    if (stale.code === 0) throw new Error('Revoked socket remained usable')
    const fresh = await remote.environment(host, lifetime.signal)
    await invoke(fresh, ['workspaces'])
    console.log(
      JSON.stringify({
        marker: 'HVIR_REAL_SSH_AGENT_CLIENT_OK',
        target,
        sha256,
        presentation: 'headless-adapter',
        commands: ['workspaces', 'open', 'report', 'run', 'help'],
        privateMarkerMode: '0600',
        cacheReuse: true,
        interruptedUploadReconnect: interruption === 'upload',
        interruptedPreparationReconnect: interruption,
        preservedInterruptedObject: true,
        ownedSocketCleanup: true,
        revokeAndFreshForward: true,
      }),
    )
  } finally {
    lifetime.abort()
    actions.revokeInstallation('probe')
    access.dispose()
    await remote.dispose()
    admission.dispose()
    reports.dispose()
    await host.dispose()
  }
}
void main().catch((_error: unknown) => {
  console.error(
    `SSH client probe failed operation=${operation} status=${status ?? 'unknown'} category=transport-or-assertion`,
  )
  process.exitCode = 1
})
