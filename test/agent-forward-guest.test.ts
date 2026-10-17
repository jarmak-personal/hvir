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
async function fixture(origin: 'ssh-forward' | 'application-local' = 'ssh-forward') {
  const connector = connectorFixture(),
    contexts = contextFixture(),
    resourceScopes = new RendererResourceScopes(),
    renderer = resourceScopes.activateOwner(1)
  const root =
      origin === 'application-local'
        ? contexts.root
        : hostPath(asHostId('remote'), '/' + 'nested-project/'.repeat(16)),
    workspace =
      origin === 'application-local' ? 'workspace' : `workspace:remote:${root.path}`
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
              root: hostPath(root.hostId, root.path + '/second'),
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
          {
            id: 'human-only',
            title: 'Human only',
            view: 'main',
            agents: false,
            effects: { delete: true, replace: false },
          },
          {
            id: 'replace-exact',
            title: 'Replace exact',
            view: 'main',
            agents: true,
            effects: { delete: false, replace: true },
            inputSchema: {
              type: 'object' as const,
              properties: { target: { type: 'string' as const } },
              required: ['target'],
            },
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
      windowVisible: () => true,
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
    ...(origin === 'ssh-forward' ? { forwardScopes: scopes } : {}),
  })
  const connection =
    origin === 'application-local'
      ? {
          origin,
          id: 'cli',
          signal: cli.signal,
        }
      : {
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
  const attached = new Set<string>()
  const attach = (opened: ReturnType<typeof guests.snapshot>[number], guest = 10) => {
    if (!attached.has(opened.id)) {
      guests.claim(renderer, opened.partition, opened.url, opened.id)
      guests.bind(renderer, opened.partition, guest)
      guests.presentation(renderer, opened.id, DEFAULT_EXTENSION_PRESENTATION, true, true)
      guests.receive(guest, { kind: 'hello', contract: '1.0' })
      attached.add(opened.id)
    }
  }
  const view = async () => {
    const result = await run(['view', '--extension', 'installation', '--view', 'main'])
    expect(result.exitStatus).toBe(0)
    const { view: selected } = JSON.parse(result.stdout) as { view: { id: string } }
    const opened = guests.snapshot(renderer).find((entry) => entry.id === selected.id)!
    attach(opened)
    return opened
  }
  const request = async (
    id: string,
    capability: string,
    input: unknown,
    actionId?: string,
    guest = 10,
  ) => {
    guests.receive(guest, {
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
    generation: 'object:1:forward',
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
    activation,
    connector,
    workspace,
    session: context.sessions(renderer)[0]?.id,
    guests,
    actions,
    renderer,
    commands,
    connection,
    run,
    view,
    attach,
    request,
    sent,
    scopes,
    grant,
    cli,
    lifetime,
    installation,
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

it('refuses SSH agent reuse without narrowing or closing a human view, including an opening view', async () => {
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

async function invocation(f: Awaited<ReturnType<typeof fixture>>, index = 0) {
  const delivered = () => f.sent.filter((message) => message.kind === 'action')
  await vi.waitFor(() => expect(delivered().length).toBeGreaterThan(index))
  return delivered()[index]!.invocation
}

it('refuses forbidden destructive actions and invalid child input before offering confirmation', async () => {
  const f = await fixture('application-local')
  await f.access.configure({ enabled: true, confirmDestructive: true })
  await f.view()
  for (const [id, action, input] of [
    ['forbidden', 'human-only', null],
    ['invalid', 'replace-exact', {}],
  ] as const) {
    expect(await f.request(id, 'actions.invoke', { action, input })).toMatchObject({
      ok: false,
    })
    expect(f.access.snapshot().confirmations).toEqual([])
    expect(f.sent.some((message) => message.kind === 'action')).toBe(false)
  }
})

it('CLI disconnect cancels its active local command while its retained view keeps standing agent access', async () => {
  const f = await fixture('application-local')
  const pending = f.run(['run', '--extension', 'installation', '--action', 'allowed'])
  await vi.waitFor(() => expect(f.guests.snapshot(f.renderer)).toHaveLength(1))
  const view = f.guests.snapshot(f.renderer)[0]!
  f.attach(view)
  const action = await invocation(f)
  f.cli.abort()
  expect((await pending).exitStatus).toBe(75)
  expect(f.actions.provenance(view.id, action.id)).toBeUndefined()
  f.guests.assertView(view.id)
  expect(await f.request('retained', 'context.read', null)).toMatchObject({ ok: true })
  expect(
    await f.request('human', 'actions.invoke', { action: 'human-only' }),
  ).toMatchObject({ ok: false })
})

it('a local standing parent cannot authorize its destructive child: confirmation binds the exact child input, effects, workspace and session', async () => {
  const f = await fixture('application-local')
  await f.access.configure({ enabled: true, confirmDestructive: true })
  const pending = f.run([
    'run',
    '--extension',
    'installation',
    '--action',
    'allowed',
    '--input',
    '{"parent":true}',
    '--session',
    f.session!,
  ])
  await vi.waitFor(() => expect(f.guests.snapshot(f.renderer)).toHaveLength(1))
  f.attach(f.guests.snapshot(f.renderer)[0]!)
  const parent = await invocation(f)
  expect(parent).toMatchObject({ caller: 'agent', authorization: 'standing' })
  expect(f.access.snapshot().confirmations).toEqual([])
  f.guests.receive(10, {
    kind: 'request',
    id: 'child',
    capability: 'actions.invoke',
    actionId: parent.id,
    input: { action: 'delete', input: { exact: 'child' } },
  })
  await vi.waitFor(() => expect(f.access.snapshot().confirmations).toHaveLength(1))
  const decision = f.access.snapshot().confirmations[0]!
  expect(decision).toMatchObject({
    title: 'Delete',
    input: '{"exact":"child"}',
    effects: ['delete'],
    workspace: f.workspace,
    session: f.session,
  })
  expect(f.sent.filter((message) => message.kind === 'action')).toHaveLength(1)
  f.access.decide(decision.id, true)
  const child = await invocation(f, 1)
  expect(child).toMatchObject({
    action: 'delete',
    input: { exact: 'child' },
    caller: 'agent',
    authorization: 'interactive',
    context: { workspace: { id: f.workspace }, session: { id: f.session } },
  })
  f.guests.receive(10, { kind: 'action-result', id: child.id, value: 'child completed' })
  await vi.waitFor(() =>
    expect(f.sent).toContainEqual(
      expect.objectContaining({
        kind: 'result',
        id: 'child',
        ok: true,
        value: 'child completed',
      }),
    ),
  )
  f.guests.receive(10, {
    kind: 'action-result',
    id: parent.id,
    value: 'parent completed',
  })
  const result = await pending
  expect(result.exitStatus).toBe(0)
  expect(JSON.parse(result.stdout)).toMatchObject({ ok: true, value: 'parent completed' })
})

it('local retained views and own-view descendants stay agent-origin after CLI EOF and cannot omit action IDs to invoke human-only actions', async () => {
  const f = await fixture('application-local'),
    view = await f.view()
  expect(
    (await f.run(['view', '--extension', 'installation', '--view', 'main'])).exitStatus,
  ).toBe(0)
  f.cli.abort()
  f.guests.assertView(view.id)
  expect(await f.request('context', 'context.read', null)).toMatchObject({
    ok: true,
    value: { workspace: { id: f.workspace, host: 'local' } },
  })
  const human = await f.guests.open(f.renderer, 'installation', 'main', undefined, {
    context: { surface: 'viewer', workspaceId: f.workspace },
  })
  expect(human.id).not.toBe(view.id)
  f.attach(human, 12)
  expect(
    await f.request('human', 'actions.invoke', { action: 'human-only' }),
  ).toMatchObject({ ok: false })
  expect(
    await f.request('own', 'viewer.open-own', {
      contributionId: 'main',
      context: 'application',
    }),
  ).toMatchObject({ ok: true })
  const descendant = f.guests
    .snapshot(f.renderer)
    .find((entry) => !entry.context?.workspace)!
  f.attach(descendant, 11)
  expect(
    await f.request(
      'descendant-human',
      'actions.invoke',
      { action: 'human-only' },
      undefined,
      11,
    ),
  ).toMatchObject({ ok: false })
  f.guests.receive(11, {
    kind: 'request',
    id: 'standing',
    capability: 'actions.invoke',
    input: { action: 'delete', input: null },
  })
  const action = await invocation(f)
  expect(action).toMatchObject({
    caller: 'agent',
    authorization: 'standing',
    action: 'delete',
  })
  expect(action.context.workspace).toBeUndefined()
  expect(f.access.snapshot().confirmations).toEqual([])
  f.guests.receive(11, { kind: 'action-result', id: action.id, value: 'completed' })
  await vi.waitFor(() =>
    expect(f.sent).toContainEqual(
      expect.objectContaining({
        kind: 'result',
        id: 'standing',
        ok: true,
        value: 'completed',
      }),
    ),
  )
  await f.access.configure({ enabled: false, confirmDestructive: false })
  expect(f.guests.snapshot(f.renderer).map((entry) => entry.id)).toEqual([human.id])
  expect(
    await f.request('human-survives', 'context.read', null, undefined, 12),
  ).toMatchObject({ ok: true })
})

it('opens a separate local agent view beside an opening human view and reuses each only within its origin', async () => {
  const f = await fixture('application-local')
  const context = { surface: 'viewer' as const, workspaceId: f.workspace }
  const human = await f.guests.open(f.renderer, 'installation', 'main', undefined, {
    context,
  })
  const agent = await f.view()
  expect(agent.id).not.toBe(human.id)
  expect((await f.view()).id).toBe(agent.id)
  f.attach(human, 11)
  expect(
    (await f.guests.open(f.renderer, 'installation', 'main', undefined, { context })).id,
  ).toBe(human.id)
  f.cli.abort()
  f.installation.abort()
  expect(f.guests.snapshot(f.renderer).map((entry) => entry.id)).toEqual([human.id])
  expect(
    await f.request(
      'human-survives',
      'connector.execute',
      f.connector.input,
      undefined,
      11,
    ),
  ).toMatchObject({ ok: true })
})

it.each(['ssh-first', 'local-first'] as const)(
  'refuses mixing forwarded and local agent view authority (%s)',
  async (order) => {
    const f = await fixture()
    const local = {
      origin: 'application-local' as const,
      id: 'local-cli',
      signal: new AbortController().signal,
    }
    const open = (connection: typeof local | typeof f.connection) =>
      f.commands.run(
        {
          contract: '1.0',
          argv: ['view', '--extension', 'installation', '--view', 'main'],
          stdin: '',
          defaults: { workspace: f.workspace },
        },
        connection,
      )
    expect((await open(order === 'ssh-first' ? f.connection : local)).exitStatus).toBe(0)
    expect((await open(order === 'ssh-first' ? local : f.connection)).exitStatus).toBe(69)
    const original = f.guests.snapshot(f.renderer)[0]!
    f.attach(original)
    expect((await open(order === 'ssh-first' ? local : f.connection)).exitStatus).toBe(69)
    expect(f.guests.snapshot(f.renderer).map((view) => view.id)).toEqual([original.id])
    expect(await f.request('original', 'context.read', null)).toMatchObject({ ok: true })
  },
)

it.each(['human-first', 'agent-first'] as const)(
  'keeps human and local agent action records independent (%s)',
  async (order) => {
    const f = await fixture('application-local')
    const human = () =>
      f.actions.invoke(
        f.renderer,
        f.activation,
        'human-only',
        null,
        { surface: 'viewer', workspaceId: f.workspace },
        'human',
        'interactive',
        () => undefined,
      )
    const agent = () =>
      f.run(['run', '--extension', 'installation', '--action', 'allowed'])
    const first = order === 'human-first' ? human() : agent()
    await vi.waitFor(() => expect(f.guests.snapshot(f.renderer)).toHaveLength(1))
    const firstView = f.guests.snapshot(f.renderer)[0]!
    // Start the second caller while the first record is still opening.
    const second = order === 'human-first' ? agent() : human()
    await vi.waitFor(() => expect(f.guests.snapshot(f.renderer)).toHaveLength(2))
    const secondView = f.guests
      .snapshot(f.renderer)
      .find((view) => view.id !== firstView.id)!
    const humanView = order === 'human-first' ? firstView : secondView
    const agentView = order === 'human-first' ? secondView : firstView
    f.attach(humanView, 11)
    f.attach(agentView, 10)
    await invocation(f, 1)
    const actions = f.sent.filter((message) => message.kind === 'action')
    const humanAction = actions.find(
      (message) => message.invocation.caller === 'human',
    )!.invocation
    const agentAction = actions.find(
      (message) => message.invocation.caller === 'agent',
    )!.invocation
    await f.access.configure({ enabled: false, confirmDestructive: false })
    expect(f.actions.provenance(agentView.id, agentAction.id)).toBeUndefined()
    expect(f.actions.provenance(humanView.id, humanAction.id)).toMatchObject({
      caller: 'human',
    })
    expect(f.guests.snapshot(f.renderer).map((view) => view.id)).toEqual([humanView.id])
    f.guests.receive(11, {
      kind: 'action-result',
      id: humanAction.id,
      value: 'human completed',
    })
    expect(await (order === 'human-first' ? first : second)).toBe('human completed')
    expect(await (order === 'human-first' ? second : first)).toMatchObject({
      exitStatus: 69,
    })
  },
)

it('a local descendant confirmation uses its application target rather than the initial workspace and is cancelled by extension revocation', async () => {
  const f = await fixture('application-local')
  await f.access.configure({ enabled: true, confirmDestructive: true })
  const view = await f.view()
  expect(
    await f.request('own', 'viewer.open-own', {
      contributionId: 'main',
      context: 'application',
    }),
  ).toMatchObject({ ok: true })
  const descendant = f.guests.snapshot(f.renderer).find((entry) => entry.id !== view.id)!
  f.attach(descendant, 11)
  f.cli.abort()
  f.guests.receive(11, {
    kind: 'request',
    id: 'delete',
    capability: 'actions.invoke',
    input: { action: 'delete', input: null },
  })
  await vi.waitFor(() => expect(f.access.snapshot().confirmations).toHaveLength(1))
  const decision = f.access.snapshot().confirmations[0]!
  expect(decision.effects).toEqual(['delete'])
  expect(decision.workspace).toBeUndefined()
  expect(decision.session).toBeUndefined()
  f.installation.abort()
  expect(f.access.snapshot().confirmations).toEqual([])
  expect(() => f.access.decide(decision.id, true)).toThrow('stale')
  expect(f.guests.snapshot(f.renderer)).toEqual([])
  expect(f.sent.some((message) => message.kind === 'action')).toBe(false)
})

it.each(['global-off', 'stricter', 'extension'] as const)(
  'local %s revocation cancels pending agent work and rejects late completion after CLI EOF',
  async (revocation) => {
    const f = await fixture('application-local')
    const view = await f.view()
    f.cli.abort()
    f.guests.receive(10, {
      kind: 'request',
      id: 'nested',
      capability: 'actions.invoke',
      input: { action: 'allowed', input: null },
    })
    const action = await invocation(f)
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
      id: 'execute',
      capability: 'connector.execute',
      input: f.connector.input,
      actionId: action.id,
    })
    await vi.waitFor(() => expect(f.connector.host.exec).toHaveBeenCalledOnce())
    expect(nativeSignal?.aborted).toBe(false)
    if (revocation === 'extension') f.installation.abort()
    else
      await f.access.configure({
        enabled: revocation !== 'global-off',
        confirmDestructive: revocation === 'stricter',
      })
    expect(nativeSignal?.aborted).toBe(true)
    expect(f.guests.snapshot(f.renderer)).toEqual([])
    expect(f.sent).toContainEqual({ kind: 'revoked' })
    expect(f.actions.provenance(view.id, action.id)).toBeUndefined()
    await f.access.configure({ enabled: true, confirmDestructive: false })
    resolve({ code: 0, signal: null, stdout: 'completed after revocation', stderr: '' })
    await pending
    f.guests.receive(10, { kind: 'action-result', id: action.id, value: 'late' })
    await Promise.resolve()
    expect(
      f.sent.some(
        (message) =>
          message.kind === 'result' &&
          ['execute', 'nested'].includes(message.id) &&
          message.ok,
      ),
    ).toBe(false)
    expect(f.guests.snapshot(f.renderer)).toEqual([])
  },
)
