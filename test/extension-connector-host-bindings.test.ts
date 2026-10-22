import { afterEach, expect, it, vi } from 'vitest'
import { connectorFixture } from './fixtures/extension-connector'
import { ExtensionConnectorApprovalOwner } from '../src/main/extensions/connector-approval'
import {
  CONNECTOR_LIMITS,
  type ExtensionConnectorApproval,
} from '../src/shared/extensions/connectors'
import { asHostId, localPath } from '../src/shared/host-path'

const fixtures: ReturnType<typeof connectorFixture>[] = []
afterEach(() => fixtures.splice(0).forEach((f) => f.dispose()))
function fixture() {
  const f = connectorFixture('workspace')
  fixtures.push(f)
  const remote = f.hosts.hostById('remote')!
  const localExec = vi.fn(f.host.exec.getMockImplementation())
  const local = {
    ...remote,
    hostId: asHostId('local'),
    finiteExec: { tryExec: localExec },
  }
  const catalog = f.hosts.listHosts()
  vi.spyOn(f.hosts, 'listHosts').mockReturnValue([
    ...catalog,
    { ...catalog[0]!, hostId: asHostId('local'), kind: 'local', label: 'Local' },
  ])
  vi.spyOn(f.hosts, 'hostById').mockImplementation((id) =>
    id === 'remote' ? remote : id === 'local' ? local : undefined,
  )
  vi.spyOn(f.hosts, 'materializeHost').mockImplementation((id) => {
    const host = f.hosts.hostById(id)
    if (!host) throw new Error('Unknown host')
    return Promise.resolve(host)
  })
  const selection = (host: string, executable = '/installed/' + host) => ({
    installationId: 'installation',
    connector: 'tool',
    host,
    executable,
    configuration: { args: [host], env: {} },
  })
  const prepare = (host: string, executable?: string) =>
    f.approvals.prepare(selection(host, executable), () => undefined)
  const approve = async (host: string, executable?: string) => {
    const prepared = await prepare(host, executable)
    await f.approvals.approve(prepared.token)
    return prepared.approval
  }
  const localContext = {
    ...f.caller.context('42-workspace')!,
    root: localPath('/local-project'),
    value: {
      surface: 'viewer' as const,
      visible: true,
      workspace: { id: 'local-workspace', name: 'Local', host: 'local' },
    },
  }
  const caller = {
    ...f.caller,
    context: (id: string | undefined) =>
      id === 'local-workspace' ? localContext : f.caller.context(id),
  }
  return {
    ...f,
    selection,
    prepare,
    approveHost: approve,
    caller,
    localExec,
    localInput: { ...f.input, host: 'local', workspace: 'local-workspace' },
  }
}

it('retains and restores independent local/SSH bindings with exact dispatch and no fallback', async () => {
  const f = fixture()
  const remote = await f.approveHost('remote')
  const local = await f.approveHost('local')
  expect(f.approvals.get(f.activation, 'tool', 'remote')).toBe(remote)
  expect(f.approvals.get(f.activation, 'tool', 'local')).toBe(local)
  expect(f.approvals.status(f.activation)[0]).toMatchObject({
    availability: 'unavailable',
  })
  expect(f.approvals.status(f.activation, 'remote')[0]).toMatchObject({
    host: 'remote',
    availability: 'supported',
  })
  expect(f.approvals.settings(f.activation).connectors).toHaveLength(2)
  const restored = new ExtensionConnectorApprovalOwner(
    f.hosts,
    f.authority,
    () => undefined,
  )
  try {
    await restored.start()
    expect(restored.get(f.activation, 'tool', 'local')).toEqual(local)
    expect(restored.get(f.activation, 'tool', 'remote')).toEqual(remote)
  } finally {
    restored.dispose()
  }
  expect(await f.execution.execute(f.caller, f.input)).toMatchObject({
    outcome: 'completed',
    host: 'remote',
  })
  expect(await f.execution.execute(f.caller, f.localInput)).toMatchObject({
    outcome: 'completed',
    host: 'local',
  })
  expect(f.host.exec.mock.calls[0]?.[0]).toBe('/installed/remote')
  expect(f.localExec.mock.calls[0]?.[0]).toBe('/installed/local')
  expect(f.localExec.mock.calls[0]?.[2]?.cwd).toEqual(localPath('/local-project'))
  expect(
    await f.execution.execute(f.caller, { ...f.localInput, workspace: '42-workspace' }),
  ).toMatchObject({ outcome: 'not-started', reason: 'unavailable' })
  expect(
    await f.execution.execute(f.caller, { ...f.input, host: 'other' }),
  ).toMatchObject({ outcome: 'not-started', reason: 'unapproved', host: 'other' })
  expect(f.host.exec).toHaveBeenCalledOnce()
  expect(f.localExec).toHaveBeenCalledOnce()
})

it('rejects duplicate full saved identities, while distinct hosts remain valid', async () => {
  const f = fixture(),
    saved = await f.approveHost('remote')
  f.setState([saved, { ...saved }])
  const restored = new ExtensionConnectorApprovalOwner(
    f.hosts,
    f.authority,
    () => undefined,
  )
  try {
    await restored.start()
    expect(restored.get(f.activation, 'tool', 'remote')).toBeUndefined()
    await expect(restored.prepare(f.selection('local'), () => undefined)).rejects.toThrow(
      'cannot be read safely',
    )
  } finally {
    restored.dispose()
  }
})

it('fails closed when restored application access is bound to a remote host', async () => {
  const f = fixture(),
    saved = await f.approveHost('remote')
  const declaration = { ...saved.declaration, context: 'application' as const }
  Object.assign(f.activation.revision.manifest, { connectors: [declaration] })
  f.setState([{ ...saved, declaration }])
  const restored = new ExtensionConnectorApprovalOwner(
    f.hosts,
    f.authority,
    () => undefined,
  )
  try {
    await restored.start()
    expect(restored.get(f.activation, 'tool', 'remote')).toBeUndefined()
    await expect(restored.prepare(f.selection('local'), () => undefined)).rejects.toThrow(
      'cannot be read safely',
    )
  } finally {
    restored.dispose()
  }
})

it('denies an unauthorized requested host even when it has no saved approval', async () => {
  const f = fixture()
  const authorizeHost = vi.fn(() => {
    throw new Error('Origin cannot execute on this host')
  })
  await expect(
    f.execution.execute({ ...f.caller, authorizeHost }, f.localInput),
  ).rejects.toThrow('Origin cannot execute on this host')
  expect(authorizeHost).toHaveBeenCalledWith('local', 'local-workspace')
  expect(f.localExec).not.toHaveBeenCalled()
  expect(f.host.exec).not.toHaveBeenCalled()
  expect(await f.execution.execute(f.caller, f.localInput)).toMatchObject({
    outcome: 'not-started',
    reason: 'unapproved',
    host: 'local',
  })
})

it('replaces changed declarations on the selected host without reviving stale bindings elsewhere', async () => {
  const f = fixture()
  await f.approveHost('remote')
  await f.approveHost('local')
  Object.assign(f.activation.revision.manifest, {
    connectors: [{ ...f.activation.revision.manifest.connectors![0]!, timeoutMs: 1000 }],
  })
  expect(f.approvals.get(f.activation, 'tool', 'remote')).toBeUndefined()
  await f.approveHost('local')
  expect(f.approvals.get(f.activation, 'tool', 'local')).toBeDefined()
  expect(f.approvals.get(f.activation, 'tool', 'remote')).toBeUndefined()
})

it('keeps consent for one host current when the other host is replaced or revoked', async () => {
  const f = fixture()
  await f.approveHost('remote')
  const prepared = await f.prepare('local')
  await f.approveHost('remote', '/installed/new-remote')
  await f.approvals.revoke('installation', 'tool', 'remote')
  await f.approvals.approve(prepared.token)
  expect(f.approvals.get(f.activation, 'tool', 'local')).toBe(prepared.approval)
  expect(f.state()).toEqual([prepared.approval])
})

it.each(['local', 'remote'])(
  'does not resurrect %s authority when revocation races a local save',
  async (revokedHost) => {
    const f = fixture()
    await f.approveHost('remote')
    const prepared = await f.prepare('local')
    let resume!: () => void, entered!: () => void
    const reached = new Promise<void>((resolve) => {
      entered = resolve
    })
    const wait = new Promise<void>((resolve) => {
      resume = resolve
    })
    const write = f.write.getMockImplementation()!
    f.write.mockImplementationOnce(async (value, current) => {
      entered()
      await wait
      await write(value, current)
    })
    const saving = f.approvals.approve(prepared.token)
    const result = saving.then(
      () => 'saved',
      () => 'revoked',
    )
    await reached
    const revoke = f.approvals.revoke('installation', 'tool', revokedHost)
    expect(f.approvals.get(f.activation, 'tool', revokedHost)).toBeUndefined()
    resume()
    expect(await result).toBe(revokedHost === 'local' ? 'revoked' : 'saved')
    await revoke
    expect(f.approvals.get(f.activation, 'tool', revokedHost)).toBeUndefined()
    expect(
      (f.state() as ExtensionConnectorApproval[]).map((entry) => entry.host),
    ).toEqual([revokedHost === 'local' ? 'remote' : 'local'])
  },
)

it('revokes only the exact host receipts and running execution; installation revocation covers both', async () => {
  const f = fixture()
  await f.approveHost('remote')
  await f.approveHost('local')
  const remoteReceipt = await f.execution.execute(f.caller, f.input)
  const localReceipt = await f.execution.execute(f.caller, f.localInput)
  let finishRemote!: () => void, finishLocal!: () => void
  const success = { code: 0, signal: null, stdout: 'done', stderr: '' }
  f.host.exec.mockImplementationOnce(
    () =>
      new Promise((resolve) => {
        finishRemote = () => resolve(success)
      }),
  )
  f.localExec.mockImplementationOnce(
    () =>
      new Promise((resolve) => {
        finishLocal = () => resolve(success)
      }),
  )
  const remote = f.execution.execute({ ...f.caller, action: 'remote' }, f.input)
  const localCaller = { ...f.caller, action: 'local' }
  const local = f.execution.execute(localCaller, f.localInput)
  await vi.waitFor(() => expect(finishLocal).toBeDefined())
  await f.approvals.revoke('installation', 'tool', 'remote')
  expect(await remote).toMatchObject({ outcome: 'interrupted-uncertain' })
  expect(() =>
    f.execution.output(f.caller, {
      receipt: remoteReceipt.receipt,
      stream: 'stdout',
      offset: 0,
    }),
  ).toThrow('stale')
  expect(
    f.execution.output(f.caller, {
      receipt: localReceipt.receipt,
      stream: 'stdout',
      offset: 0,
    })?.data,
  ).toBe('result')
  expect(f.localExec.mock.calls[1]?.[2]?.signal?.aborted).toBe(false)
  finishLocal()
  finishRemote()
  const completed = await local
  expect(completed.outcome).toBe('completed')
  await f.approvals.revoke('installation')
  expect(() =>
    f.execution.output(localCaller, {
      receipt: completed.receipt,
      stream: 'stdout',
      offset: 0,
    }),
  ).toThrow('stale')
  expect(f.state()).toEqual([])
})

it.each(['records', 'bytes'] as const)(
  'refuses the complete next state at the %s bound before removing an existing binding',
  async (bound) => {
    const f = fixture(),
      saved = await f.approveHost('remote')
    const entries: ExtensionConnectorApproval[] = [saved]
    for (let i = 1; ; i++) {
      const candidate = {
        ...saved,
        installationId: 'other-' + i,
        configuration:
          bound === 'bytes'
            ? { args: [], env: { TOOL_HOME: 'x'.repeat(7000) } }
            : saved.configuration,
      }
      if (
        bound === 'records'
          ? entries.length >= CONNECTOR_LIMITS.approvals
          : Buffer.byteLength(JSON.stringify([...entries, candidate])) >
            CONNECTOR_LIMITS.stateBytes - 1024
      )
        break
      entries.push(candidate)
    }
    f.setState(entries)
    await f.approvals.start()
    const prior = f.approvals.get(f.activation, 'tool', 'remote')
    const prepared = await f.approvals.prepare(
      {
        ...f.selection(bound === 'records' ? 'local' : 'remote'),
        ...(bound === 'bytes'
          ? { configuration: { args: [], env: { TOOL_HOME: 'x'.repeat(8000) } } }
          : {}),
      },
      () => undefined,
    )
    const writes = f.write.mock.calls.length
    await expect(f.approvals.approve(prepared.token)).rejects.toThrow('exceeds its bound')
    expect(f.approvals.get(f.activation, 'tool', 'remote')).toBe(prior)
    expect(f.write).toHaveBeenCalledTimes(writes)
    expect(f.state()).toEqual(entries)
    if (bound === 'records') {
      await f.approveHost('remote', '/installed/new')
      expect(f.state()).toHaveLength(CONNECTOR_LIMITS.approvals)
    }
  },
)

it('releases abandoned preparation slots without cancelling another host decision or saved access', async () => {
  const f = fixture()
  const saved = await f.approveHost('remote')
  const remote = await f.prepare('remote', '/remote/replacement')
  for (let i = 0; i < 8; i++) {
    const local = await f.prepare('local')
    f.approvals.cancelPrepared(local.token)
    await expect(f.approvals.approve(local.token)).rejects.toThrow(
      'Inspect native access again',
    )
  }
  expect(f.approvals.get(f.activation, 'tool', 'remote')).toBe(saved)
  await f.approvals.approve(remote.token)
  expect(f.approvals.get(f.activation, 'tool', 'remote')).toBe(remote.approval)
  expect(f.approvals.get(f.activation, 'tool', 'local')).toBeUndefined()
})
