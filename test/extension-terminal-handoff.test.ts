import { afterEach, describe, expect, it, vi } from 'vitest'
vi.mock('electron', () => ({ dialog: {}, BrowserWindow: {}, webContents: {} }))
import {
  ExtensionTerminalHandoff,
  type ConfirmTerminalLaunch,
} from '../src/main/extensions/terminal-handoff'
import { ExtensionGuestAuthority } from '../src/main/extensions/guest-authority'
import {
  TerminalCommandHandoffOwner,
  type TerminalCommandRequest,
} from '../src/main/terminal/command-handoff-owner'
import type { ExtensionInvocation } from '../src/shared/extensions/contract'
import { localPath } from '../src/shared/host-path'
import { connectorFixture } from './fixtures/extension-connector'

const disposers: Array<() => void> = []
afterEach(() => {
  for (const dispose of disposers.splice(0)) dispose()
})
async function fixture(
  caller: ExtensionInvocation['caller'] = 'guest',
  authorization: ExtensionInvocation['authorization'] = 'unapproved',
) {
  const f = connectorFixture('application')
  Object.assign(f.activation.revision.manifest.connectors![0]!, { context: 'workspace' })
  await f.approve()
  const context = {
    value: {
      surface: 'viewer' as const,
      visible: true,
      workspace: { id: 'workspace', name: 'Project', host: 'local' },
    },
    root: localPath('/workspace'),
    current: () => true,
  }
  const invocation: ExtensionInvocation = {
    id: 'action-once',
    action: 'setup',
    input: {},
    context: context.value,
    caller,
    authorization,
  }
  const actions = {
    provenance: vi.fn<() => ExtensionInvocation | undefined>(() => invocation),
    authority: vi.fn(() => undefined),
  }
  const confirm = vi.fn<ConfirmTerminalLaunch>(() => Promise.resolve(true)),
    published = vi.fn()
  let request!: TerminalCommandRequest
  const owner = { id: 42, generation: 7 }
  const handoffs = new TerminalCommandHandoffOwner((_owner, value) => {
    request = value
    published(value)
  })
  const adapter = new ExtensionTerminalHandoff(f.approvals, handoffs, actions, confirm)
  disposers.push(() => {
    handoffs.dispose()
    f.dispose()
  })
  const start = (
    input: unknown = {
      connector: 'tool',
      workspace: 'workspace',
      args: ['init', '--no-git'],
    },
  ) =>
    adapter.start(
      {
        owner,
        view: 'view',
        activation: f.activation,
        authority: new ExtensionGuestAuthority(),
        context,
      },
      input,
      invocation,
      f.caller.current,
      f.controller.signal,
    )
  const consume = () =>
    handoffs.consume(request.ticket, {
      owner,
      terminalId: request.terminalId,
      workspaceId: request.workspaceId,
      root: context.root,
    })
  return { f, context, invocation, actions, confirm, published, start, consume, handoffs }
}

describe('extension terminal handoff authority', () => {
  it('asks once for the exact command and destination, then freezes the approved prefix/config', async () => {
    const f = await fixture(),
      result = f.start()
    await vi.waitFor(() => expect(f.published).toHaveBeenCalledOnce())
    expect(f.confirm).toHaveBeenCalledOnce()
    expect(f.confirm.mock.calls[0]?.[0]).toMatchObject({
      destination: 'local: /workspace',
      command: 'Run tool once in a new terminal',
    })
    const lease = f.consume()
    expect(lease.command).toEqual({
      executable: '/installed/tool',
      args: ['--json', 'init', '--no-git'],
      environment: { TOOL_HOME: '/library' },
    })
    await lease.prepareDispatch()
    lease.dispatched()
    lease.finish(true)
    expect(await result).toMatchObject({ outcome: 'handed-off' })
    await expect(f.start()).rejects.toThrow('already requested')
  })
  it.each(['standing', 'interactive'] as const)(
    'consumes admitted agent %s authority without another human modal',
    async (authorization) => {
      const f = await fixture('agent', authorization),
        result = f.start()
      await vi.waitFor(() => expect(f.published).toHaveBeenCalledOnce())
      expect(f.confirm).not.toHaveBeenCalled()
      const lease = f.consume()
      await lease.prepareDispatch()
      lease.dispatched()
      lease.finish(true)
      expect(await result).toMatchObject({ outcome: 'handed-off' })
    },
  )
  it('refuses an unapproved agent origin rather than manufacturing a human launch', async () => {
    const f = await fixture('agent')
    expect(await f.start()).toMatchObject({ outcome: 'not-started' })
    expect(f.confirm).not.toHaveBeenCalled()
    expect(f.published).not.toHaveBeenCalled()
  })
  it('revocation during the native decision cannot publish a late ticket', async () => {
    const f = await fixture()
    let release!: (accepted: boolean) => void
    let settled!: () => void
    const preparationSettled = new Promise<void>((resolve) => {
      settled = resolve
    })
    const request = f.handoffs.request.bind(f.handoffs)
    vi.spyOn(f.handoffs, 'request').mockImplementation((input) =>
      request({
        ...input,
        prepare: async (signal) => {
          try {
            return await input.prepare!(signal)
          } finally {
            settled()
          }
        },
      }),
    )
    f.confirm.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          release = resolve
        }),
    )
    const result = f.start()
    await vi.waitFor(() => expect(f.confirm).toHaveBeenCalledOnce())
    f.f.controller.abort()
    expect(await result).toMatchObject({ outcome: 'not-started' })
    release(true)
    await preparationSettled
    expect(f.published).not.toHaveBeenCalled()
    expect(f.f.host.exec).not.toHaveBeenCalled()
  })
  it('refuses executable replacement at final admission and keeps dispatch unstarted', async () => {
    const f = await fixture(),
      result = f.start()
    await vi.waitFor(() => expect(f.published).toHaveBeenCalledOnce())
    const lease = f.consume()
    f.f.host.realpath.mockImplementationOnce(() =>
      Promise.resolve(localPath('/changed/tool')),
    )
    await expect(lease.prepareDispatch()).rejects.toThrow('changed')
    lease.finish(false)
    expect(await result).toMatchObject({ outcome: 'not-started' })
    expect(f.f.host.exec).not.toHaveBeenCalled()
  })
  it('requires main provenance and the exact approved workspace connector', async () => {
    const f = await fixture()
    f.actions.provenance.mockImplementationOnce(() => undefined)
    await expect(f.start()).rejects.toThrow('current explicit action')
    await expect(
      f.start({ connector: 'tool', workspace: 'alias', args: [] }),
    ).rejects.toThrow('exact local workspace')
    expect(f.confirm).not.toHaveBeenCalled()
    expect(f.published).not.toHaveBeenCalled()
  })
})
