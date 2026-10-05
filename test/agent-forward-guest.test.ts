import { guestTestPorts } from './fixtures/extension-guest'
import { ExtensionPresentationState } from '../src/main/extensions/presentation-state'
import { validateAgentRequest } from '../src/shared/agent/contract'
import { afterEach, expect, it, vi } from 'vitest'
import { AgentWorkbenchCommandOwner } from '../src/main/agent/command-owner'
import { AgentForwardScopeOwner } from '../src/main/agent/forward-scope'
import { LocalAgentAccessOwner } from '../src/main/agent/access-owner'
import {
  ExtensionGuestOwner,
  DEFAULT_EXTENSION_PRESENTATION,
} from '../src/main/extensions/guest-owner'
import { ExtensionActionOwner } from '../src/main/extensions/action-owner'
import { ExtensionContextOwner } from '../src/main/extensions/context-owner'
import { RendererResourceScopes } from '../src/main/renderer-resource-scopes'
import { AgentReportOwner } from '../src/main/viewer/agent-report-owner'
import { hostPath, asHostId, localPath } from '../src/shared/host-path'
import type {
  ExtensionReply,
  ExtensionInvocation,
} from '../src/shared/extensions/contract'
import { connectorFixture } from './fixtures/extension-connector'
import { contextFixture } from './fixtures/extension-context'

const cleanups: (() => Promise<void>)[] = []
afterEach(async () => {
  for (const cleanup of cleanups.splice(0)) await cleanup()
})
async function fixture() {
  const connector = connectorFixture(),
    contexts = contextFixture(),
    resourceScopes = new RendererResourceScopes(),
    renderer = resourceScopes.activateOwner(1)
  const root = hostPath(asHostId('remote'), '/' + 'nested-project/'.repeat(16)),
    workspace = `workspace:remote:${root.path}`
  const state = contexts.sources.projectState(),
    project = state.projects[0]!
  const context = new ExtensionContextOwner({
    ...contexts.sources,
    projectState: () => ({
      ...state,
      root,
      activeWorkspaceId: workspace,
      projects: [
        {
          ...project,
          registeredRoot: root,
          activeWorkspaceId: workspace,
          workspaces: [
            { ...project.workspaces[0]!, id: workspace, root },
            {
              ...project.workspaces[0]!,
              id: workspace + 'second',
              root: hostPath(asHostId('remote'), root.path + '/second'),
            },
          ],
        },
        ...['local', 'other'].map((host) => ({
          ...project,
          id: host,
          registeredRoot:
            host === 'local' ? localPath('/local') : hostPath(asHostId(host), '/other'),
          activeWorkspaceId: `workspace:${host}:/${host}`,
          workspaces: [
            {
              ...project.workspaces[0]!,
              id: `workspace:${host}:/${host}`,
              root:
                host === 'local'
                  ? localPath('/local')
                  : hostPath(asHostId(host), '/other'),
            },
          ],
        })),
      ],
    }),
  })
  const activation = {
    ...connector.activation,
    revision: {
      ...connector.activation.revision,
      manifest: {
        ...connector.activation.revision.manifest,
        requiredCapabilities: [
          'connector.execute',
          'actions.invoke',
          'viewer.open-own',
          'context.read',
        ],
        actions: [
          {
            id: 'allowed',
            title: 'Allowed',
            view: 'main',
            agents: true,
            effects: { delete: false, replace: false },
          },
          {
            id: 'delete',
            title: 'Delete',
            view: 'main',
            agents: true,
            effects: { delete: true, replace: false },
          },
        ],
      },
    },
  }
  connector.active.set('installation', activation)
  await connector.approve()
  const sent: ExtensionReply[] = [],
    installation = new AbortController(),
    lifetime = new AbortController(),
    cli = new AbortController(),
    scopes = new AgentForwardScopeOwner(() => undefined)
  const access = new LocalAgentAccessOwner(
    () => undefined,
    () => Promise.resolve(),
    {
      allowed: () => ['installation'],
      writable: () => true,
      signal: () => installation.signal,
    },
  )
  await access.configure({ enabled: true, confirmDestructive: false })
  scopes.register('remote', 'object:1:forward')
  const open = (
    owner: typeof renderer,
    id: string,
    view: string,
    options: Parameters<
      import('../src/main/extensions/action-owner').ExtensionActionGuestPort['open']
    >[3],
    admit: () => void,
  ) => guests.open(owner, id, view, admit, options)
  const actions: ExtensionActionOwner = new ExtensionActionOwner({
    open,
    dispatch: (view, invocation) => guests.dispatch(view, invocation),
    runnable: (view, action, admitted) => guests.runnable(view, action, admitted),
    cancelAction: (view, action) => guests.cancelAction(view, action),
    assertView: (view) => guests.assertView(view),
  })
  const presentation = new ExtensionPresentationState(
    { read: () => Promise.resolve({}), save: () => Promise.resolve() },
    () => guests.publishValues(),
  )
  const guests: ExtensionGuestOwner = new ExtensionGuestOwner(
    connector.authority,
    resourceScopes,
    {
      prepare: () => Promise.resolve(),
      destroy: () => Promise.resolve(),
      send: (_id, message) => sent.push(message),
      visibility: () => undefined,
      foreground: () => true,
    },
    () => undefined,
    context,
    guestTestPorts(actions, presentation, { connectors: connector.execution }),
  )
  const reports = new AgentReportOwner(() => undefined)
  const commands = new AgentWorkbenchCommandOwner({
    contexts: () => context,
    activeInstallations: () => [activation],
    activeInstallation: () => activation,
    openView: open,
    invokeAction: (...args) => actions.invoke(...args),
    access,
    reports,
    presentationOwner: () => renderer,
    assertOwner: () => resourceScopes.assertCurrent(renderer),
    host: () => undefined,
    openDocument: () => undefined,
    forwardScopes: scopes,
  })
  const connection = {
    origin: 'ssh-forward' as const,
    id: 'cli',
    host: asHostId('remote'),
    generation: 'object:1:forward',
    signal: cli.signal,
    lifetime: lifetime.signal,
    current: () => lifetime.signal.throwIfAborted(),
  }
  const run = (argv: string[]) =>
    commands.run(
      { contract: '1.0', argv, stdin: '', defaults: { workspace } },
      connection,
    )
  const view = async () => {
    const result = await run(['view', '--extension', 'installation', '--view', 'main'])
    expect(result.exitStatus).toBe(0)
    const opened = guests.snapshot(renderer)[0]!
    if (!sent.some((message) => message.kind === 'hello')) {
      guests.claim(renderer, opened.partition, opened.url, opened.id)
      guests.bind(renderer, opened.partition, 10)
      guests.presentation(renderer, opened.id, DEFAULT_EXTENSION_PRESENTATION, true, true)
      guests.receive(10, { kind: 'hello', contract: '1.0' })
    }
    return opened
  }
  const request = async (
    id: string,
    capability: string,
    input: unknown,
    actionId?: string,
  ) => {
    guests.receive(10, {
      kind: 'request',
      id,
      capability,
      input,
      ...(actionId ? { actionId } : {}),
    })
    await vi.waitFor(() =>
      expect(sent.some((message) => message.kind === 'result' && message.id === id)).toBe(
        true,
      ),
    )
    return sent.find((message) => message.kind === 'result' && message.id === id)!
  }
  const grant = {
    host: 'remote',
    generation: connection.generation,
    installation: 'installation',
    revision: activation.revision.hash,
    action: 'allowed',
    capability: 'connector.execute' as const,
    executionHost: 'local',
    workspace,
  }
  cleanups.push(async () => {
    lifetime.abort()
    access.dispose()
    actions.revokeInstallation('installation')
    await guests.dispose()
    reports.dispose()
    connector.dispose()
  })
  return {
    connector,
    workspace,
    guests,
    renderer,
    commands,
    connection,
    run,
    view,
    request,
    sent,
    scopes,
    grant,
    cli,
    lifetime,
    access,
  }
}
it('remote-opened guests retain their origin after same-origin reuse, CLI EOF and refused local reuse, denying connector laundering without an action ID', async () => {
  const f = await fixture(),
    view = await f.view()
  expect(f.workspace.length).toBeGreaterThan(128)
  expect(
    (await f.run(['view', '--extension', 'installation', '--view', 'main'])).exitStatus,
  ).toBe(0)
  f.cli.abort()
  expect(await f.request('context', 'context.read', null)).toMatchObject({
    ok: true,
    value: { workspace: { id: f.workspace, host: 'remote' } },
  })
  await expect(
    f.guests.open(f.renderer, 'installation', 'main', undefined, {
      context: { surface: 'viewer', workspaceId: f.workspace },
    }),
  ).rejects.toThrow('different origin')
  expect(await f.request('local', 'connector.execute', f.connector.input)).toMatchObject({
    ok: false,
  })
  expect(
    await f.request('forged', 'connector.execute', {
      ...f.connector.input,
      host: 'other',
      origin: 'application-local',
      generation: 'forged',
    }),
  ).toMatchObject({ ok: false })
  expect(f.connector.host.exec).not.toHaveBeenCalled()
  f.lifetime.abort()
  expect(() => f.guests.assertView(view.id)).toThrow()
})
it('a specifically granted nested action can run a local connector for its admitted remote destination and revocation fences it', async () => {
  const f = await fixture()
  f.scopes.configure(f.grant, true)
  await f.view()
  f.cli.abort()
  f.guests.receive(10, {
    kind: 'request',
    id: 'nested',
    capability: 'actions.invoke',
    input: { action: 'allowed', input: { destination: f.workspace } },
  })
  await vi.waitFor(() =>
    expect(f.sent.some((message) => message.kind === 'action')).toBe(true),
  )
  const action = f.sent.find((message) => message.kind === 'action') as {
    invocation: ExtensionInvocation
  }
  expect(action.invocation).toMatchObject({
    caller: 'agent',
    authorization: 'standing',
    context: { workspace: { id: f.workspace } },
  })
  expect(
    await f.request(
      'execute',
      'connector.execute',
      f.connector.input,
      action.invocation.id,
    ),
  ).toMatchObject({ ok: true, value: { outcome: 'completed', host: 'local' } })
  expect(f.connector.host.exec).toHaveBeenCalledOnce()
  f.scopes.configure(f.grant, false)
  f.guests.receive(10, {
    kind: 'request',
    id: 'late',
    capability: 'connector.execute',
    input: f.connector.input,
    actionId: action.invocation.id,
  })
  await Promise.resolve()
  expect(f.connector.host.exec).toHaveBeenCalledOnce()
  expect(f.guests.snapshot(f.renderer)).toHaveLength(1)
})
it('nested destructive actions without invocation IDs still require the main confirmation and Off revokes queued work', async () => {
  const f = await fixture()
  await f.access.configure({ enabled: true, confirmDestructive: true })
  await f.view()
  f.cli.abort()
  f.guests.receive(10, {
    kind: 'request',
    id: 'delete',
    capability: 'actions.invoke',
    input: { action: 'delete', input: null },
  })
  await vi.waitFor(() => expect(f.access.snapshot().confirmations).toHaveLength(1))
  expect(f.sent.some((message) => message.kind === 'action')).toBe(false)
  await f.access.configure({ enabled: false, confirmDestructive: true })
  expect(f.access.snapshot().confirmations).toEqual([])
  expect(f.guests.snapshot(f.renderer)).toEqual([])
  expect(f.connector.host.exec).not.toHaveBeenCalled()
})

it('the command owner filters multi-host discovery and rejects origin spoofing, cross-host defaults and stale cursors', async () => {
  const f = await fixture()
  const first = JSON.parse((await f.run(['workspaces', '--limit', '1'])).stdout) as {
    items: { host: string }[]
    nextCursor: string
  }
  expect(first.items).toHaveLength(1)
  expect(first.items[0]?.host).toBe('remote')
  expect(first.nextCursor).toBeTypeOf('string')
  for (const workspace of ['workspace:local:/local', 'workspace:other:/other']) {
    const request = validateAgentRequest({
      contract: '1.0',
      argv: ['report', '--stdin'],
      stdin: 'forged',
      defaults: { workspace },
      origin: 'application-local',
      host: 'local',
      generation: 'replacement',
    })
    expect((await f.commands.run(request, f.connection)).exitStatus).toBe(69)
  }
  expect(
    (await f.run(['report', '--workspace', 'workspace:local:/local', '--stdin']))
      .exitStatus,
  ).toBe(69)
  expect((await f.run(['workspaces', '--cursor', first.nextCursor])).exitStatus).toBe(0)
  f.scopes.register('remote', 'new-object:1:new-forward')
  const fresh = { ...f.connection, generation: 'new-object:1:new-forward' }
  expect(
    (
      await f.commands.run(
        {
          contract: '1.0',
          argv: ['workspaces', '--cursor', first.nextCursor],
          stdin: '',
          defaults: {},
        },
        fresh,
      )
    ).exitStatus,
  ).toBe(69)
  expect(() => f.scopes.configure(f.grant, true)).toThrow('stale')
})

it('refuses remote reuse without narrowing or closing a local view, including an opening view', async () => {
  const f = await fixture()
  const local = await f.guests.open(f.renderer, 'installation', 'main', undefined, {
    context: { surface: 'viewer', workspaceId: f.workspace },
  })
  const refusedOpening = await f.run([
    'view',
    '--extension',
    'installation',
    '--view',
    'main',
  ])
  expect(refusedOpening.exitStatus).toBe(69)
  f.guests.claim(f.renderer, local.partition, local.url, local.id)
  f.guests.bind(f.renderer, local.partition, 10)
  f.guests.presentation(f.renderer, local.id, DEFAULT_EXTENSION_PRESENTATION, true, true)
  f.guests.receive(10, { kind: 'hello', contract: '1.0' })
  const refusedReady = await f.run([
    'view',
    '--extension',
    'installation',
    '--view',
    'main',
  ])
  expect(refusedReady.exitStatus).toBe(69)
  f.lifetime.abort()
  await f.access.configure({ enabled: false, confirmDestructive: false })
  f.guests.assertView(local.id)
  expect(
    await f.request('local-survives', 'connector.execute', f.connector.input),
  ).toMatchObject({ ok: true })
  expect(f.connector.host.exec).toHaveBeenCalledOnce()
})

it('relevant grant removal cancels the real connector admission and queued action while additions and unrelated removal preserve the view', async () => {
  const f = await fixture()
  f.scopes.configure(f.grant, true)
  const view = await f.view()
  f.guests.receive(10, {
    kind: 'request',
    id: 'nested-flight',
    capability: 'actions.invoke',
    input: { action: 'allowed', input: null },
  })
  await vi.waitFor(() =>
    expect(f.sent.some((message) => message.kind === 'action')).toBe(true),
  )
  const action = f.sent.find((message) => message.kind === 'action') as {
    invocation: ExtensionInvocation
  }
  f.scopes.configure(f.grant, true)
  f.scopes.configure({ ...f.grant, action: 'delete' }, true)
  f.scopes.configure({ ...f.grant, action: 'delete' }, false)
  f.guests.assertView(view.id)
  expect(f.sent.some((message) => message.kind === 'action-cancelled')).toBe(false)
  let resolve!: (value: {
    code: number
    signal: null
    stdout: string
    stderr: string
  }) => void
  const pending = new Promise<{
    code: number
    signal: null
    stdout: string
    stderr: string
  }>((done) => {
    resolve = done
  })
  let nativeSignal: AbortSignal | undefined
  f.connector.host.exec.mockImplementationOnce((_command, _args, options) => {
    nativeSignal = options?.signal
    return pending
  })
  f.guests.receive(10, {
    kind: 'request',
    id: 'execute-flight',
    capability: 'connector.execute',
    input: f.connector.input,
    actionId: action.invocation.id,
  })
  await vi.waitFor(() => expect(f.connector.host.exec).toHaveBeenCalledOnce())
  expect(nativeSignal?.aborted).toBe(false)
  f.scopes.configure(f.grant, false)
  expect(nativeSignal?.aborted).toBe(true)
  expect(
    f.sent.some(
      (message) =>
        message.kind === 'action-cancelled' && message.id === action.invocation.id,
    ),
  ).toBe(true)
  f.guests.assertView(view.id)
  f.scopes.configure(f.grant, true)
  expect(nativeSignal?.aborted).toBe(true)
  expect(
    await f.request(
      'revoked-action',
      'connector.execute',
      f.connector.input,
      action.invocation.id,
    ),
  ).toMatchObject({ ok: false })
  expect(f.connector.host.exec).toHaveBeenCalledOnce()
  resolve({ code: 0, signal: null, stdout: '', stderr: '' })
})
