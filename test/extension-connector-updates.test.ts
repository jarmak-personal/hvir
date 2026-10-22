import { afterEach, expect, it, vi } from 'vitest'
import { asHostId, localPath, hostPath } from '../src/shared/host-path'
import { ExtensionConnectorApprovalOwner } from '../src/main/extensions/connector-approval'
import { connectorFixture } from './fixtures/extension-connector'
import { ExtensionConnectorConnectionOwner } from '../src/main/extensions/connector-connection'
import { RendererResourceScopes } from '../src/main/renderer-resource-scopes'

const fixtures: ReturnType<typeof connectorFixture>[] = []
afterEach(() => {
  for (const f of fixtures.splice(0)) f.dispose()
})
async function fixture(context: 'application' | 'workspace' = 'application') {
  const f = connectorFixture(context)
  fixtures.push(f)
  let target = '/versions/A/tool'
  f.host.realpath.mockImplementation(() =>
    Promise.resolve(hostPath(f.host.hostId, target)),
  )
  const approval = await f.approve('/bin/tool')
  const trust = async () => {
    const prepared = await f.approvals.prepare(approval, () => undefined, undefined, true)
    await f.approvals.approve(prepared.token)
  }
  return {
    ...f,
    approval,
    trust,
    target: (value: string) => {
      target = value
    },
  }
}

it('reports only proven target changes, preserves private repair details and performs metadata only', async () => {
  const f = await fixture()
  f.target('/versions/B/tool')
  f.host.connect.mockClear()
  const materialize = vi.spyOn(f.hosts, 'materializeHost')
  expect(await f.approvals.inspectStatus(f.activation)).toMatchObject([
    { availability: 'unavailable', reason: 'executable-changed', host: 'local' },
  ])
  expect(
    (await f.approvals.inspectSettings(f.activation, 'tool', 'local')).connectors[0],
  ).toMatchObject({
    executable: '/versions/A/tool',
    currentExecutable: '/versions/B/tool',
    selectedExecutable: '/bin/tool',
    configuration: f.approval.configuration,
    reason: 'executable-changed',
    trustUpdates: false,
  })
  expect(await f.execution.execute(f.caller, f.input)).toMatchObject({
    outcome: 'not-started',
    reason: 'executable-changed',
  })
  expect(f.host.exec).not.toHaveBeenCalled()
  expect(f.host.connect).not.toHaveBeenCalled()
  expect(materialize).not.toHaveBeenCalled()
})

it.each(['ENOENT', 'EACCES', 'NOT_EXECUTABLE'])(
  'reports inaccessible metadata %s without asserting replacement',
  async (code) => {
    const f = await fixture()
    f.host.realpath.mockRejectedValue(
      Object.assign(new Error('Metadata unavailable'), { code }),
    )
    expect(await f.approvals.inspectStatus(f.activation)).toMatchObject([
      { availability: 'unavailable', reason: 'unavailable' },
    ])
    expect(await f.execution.execute(f.caller, f.input)).toMatchObject({
      outcome: 'not-started',
      reason: 'unavailable',
    })
    expect(f.host.exec).not.toHaveBeenCalled()
  },
)

it.each(['revoke', 'replace', 'disconnect'] as const)(
  'cannot publish readiness after %s during metadata inspection',
  async (fence) => {
    const f = await fixture('workspace')
    let finish!: () => void
    const waiting = new Promise<void>((resolve) => {
      finish = resolve
    })
    f.host.realpath.mockImplementationOnce(async () => {
      await waiting
      return hostPath(f.host.hostId, '/versions/A/tool')
    })
    const pending = f.approvals.inspectStatus(f.activation, f.host.hostId)
    if (fence === 'revoke')
      await f.approvals.revoke('installation', 'tool', f.host.hostId)
    if (fence === 'replace') {
      const prepared = await f.approvals.prepare(
        { ...f.approval, configuration: { args: [], env: {} } },
        () => undefined,
      )
      await f.approvals.approve(prepared.token)
    }
    if (fence === 'disconnect') {
      f.disconnect()
      f.reconnect()
    }
    finish()
    expect(await pending).toMatchObject([{ availability: 'unavailable' }])
    expect(f.host.exec).not.toHaveBeenCalled()
  },
)

it.each([false, true])(
  'rejects a second target change during ordinary/session consent (session=%s)',
  async (trust) => {
    const f = await fixture()
    f.target('/versions/B/tool')
    const prepared = await f.approvals.prepare(
      f.approval,
      () => undefined,
      undefined,
      trust,
    )
    f.target('/versions/C/tool')
    await expect(f.approvals.approve(prepared.token)).rejects.toThrow(
      'Executable target changed',
    )
    expect(f.approvals.get(f.activation, 'tool', 'local')).toBe(f.approval)
    expect(f.state()).toEqual([f.approval])
  },
)

it('trusts only an explicit session choice, pins the new executable, and preserves the durable baseline', async () => {
  const f = await fixture()
  f.target('/versions/B/tool')
  const writes = f.write.mock.calls.length
  await f.trust()
  expect(f.write).toHaveBeenCalledTimes(writes)
  expect(f.approvals.get(f.activation, 'tool', 'local')).toBe(f.approval)
  expect(f.state()).toEqual([f.approval])
  expect(await f.execution.execute(f.caller, f.input)).toMatchObject({
    outcome: 'completed',
  })
  expect(f.host.exec.mock.calls[0]?.[0]).toBe('/versions/B/tool')
  f.approvals.endSession(f.approval)
  expect(await f.execution.execute(f.caller, f.input)).toMatchObject({
    reason: 'executable-changed',
    outcome: 'not-started',
  })
})

it('keeps refreshes on A and B separate while retaining the normal source throttle', async () => {
  const f = await fixture()
  await f.trust()
  let finish!: () => void
  f.host.exec.mockImplementationOnce(
    () =>
      new Promise((resolve) => {
        finish = () => resolve({ code: 0, signal: null, stdout: 'A', stderr: '' })
      }),
  )
  const first = f.execution.execute(f.caller, f.input)
  await vi.waitFor(() => expect(f.host.exec).toHaveBeenCalledOnce())
  f.target('/versions/B/tool')
  const second = await f.execution.execute({ ...f.caller, view: 'second' }, f.input)
  expect(second).toMatchObject({ outcome: 'completed' })
  expect(f.host.exec.mock.calls.map((call) => call[0])).toEqual([
    '/versions/A/tool',
    '/versions/B/tool',
  ])
  finish()
  await first
  await Promise.resolve()
  expect(await f.execution.execute(f.caller, f.input)).toMatchObject({
    outcome: 'not-started',
    reason: 'frequency',
  })
})

it.each(['off', 'disconnect', 'disable', 'forget', 'dispose'] as const)(
  'fences pending resolution at %s and cannot restore session authority',
  async (fence) => {
    const f = await fixture('workspace')
    await f.trust()
    f.target('/versions/B/tool')
    let finish!: () => void, entered!: () => void
    const waiting = new Promise<void>((resolve) => {
      finish = resolve
    })
    const reached = new Promise<void>((resolve) => {
      entered = resolve
    })
    f.host.realpath.mockImplementationOnce(async () => {
      entered()
      await waiting
      return hostPath(f.host.hostId, '/versions/B/tool')
    })
    const pending = f.execution.execute(f.caller, f.input)
    await reached
    if (fence === 'off') f.approvals.endSession(f.approval)
    if (fence === 'disconnect') {
      f.disconnect()
      f.reconnect()
    }
    if (fence === 'disable') {
      f.approvals.activationEnded('installation')
      f.execution.revoke('installation')
    }
    if (fence === 'forget') f.approvals.forget('installation')
    if (fence === 'dispose') f.approvals.dispose()
    finish()
    expect(await pending).toMatchObject({ outcome: 'not-started' })
    expect(f.host.exec).not.toHaveBeenCalled()
    expect(await f.execution.execute(f.caller, f.input)).toMatchObject({
      outcome: 'not-started',
    })
  },
)

it('Off ends running work and receipts without claiming rollback or reviving late output', async () => {
  const f = await fixture()
  await f.trust()
  f.target('/versions/B/tool')
  const complete = await f.execution.execute({ ...f.caller, action: 'one' }, f.input)
  let finish!: () => void
  f.host.exec.mockImplementationOnce(
    () =>
      new Promise((resolve) => {
        finish = () => resolve({ code: 0, signal: null, stdout: 'late', stderr: '' })
      }),
  )
  const running = f.execution.execute({ ...f.caller, action: 'two' }, f.input)
  await vi.waitFor(() => expect(f.host.exec).toHaveBeenCalledTimes(2))
  f.approvals.endSession(f.approval)
  expect(await running).toMatchObject({ outcome: 'interrupted-uncertain' })
  expect(() =>
    f.execution.output(
      { ...f.caller, action: 'one' },
      { receipt: complete.receipt, stream: 'stdout', offset: 0 },
    ),
  ).toThrow('stale')
  finish()
  await Promise.resolve()
  expect(await f.execution.execute(f.caller, f.input)).toMatchObject({
    reason: 'executable-changed',
  })
})

it('does not persist session trust across a fresh approval owner', async () => {
  const f = await fixture()
  await f.trust()
  f.target('/versions/B/tool')
  const successor = new ExtensionConnectorApprovalOwner(
    f.hosts,
    f.authority,
    () => undefined,
  )
  try {
    await successor.start()
    expect(await successor.inspectStatus(f.activation)).toMatchObject([
      { reason: 'executable-changed' },
    ])
    expect(successor.settings(f.activation).connectors[0]?.trustUpdates).toBe(false)
  } finally {
    successor.dispose()
  }
})

it('checks only the requested saved binding in Settings', async () => {
  const f = await fixture()
  Object.assign(f.activation.revision.manifest, {
    connectors: [
      ...f.activation.revision.manifest.connectors!,
      { ...f.approval.declaration, id: 'other' },
    ],
  })
  const other = await f.approvals.prepare(
    { ...f.approval, connector: 'other' },
    () => undefined,
  )
  await f.approvals.approve(other.token)
  f.host.realpath.mockClear()
  await f.approvals.inspectSettings(f.activation, 'tool', 'local')
  expect(f.host.realpath).toHaveBeenCalledOnce()
  expect(f.host.realpath.mock.calls[0]?.[0]).toEqual(localPath('/bin/tool'))
})

it('retains passive metadata capacity through session revocation until each host request settles', async () => {
  const f = await fixture()
  await f.trust()
  const finishes: (() => void)[] = []
  f.host.realpath.mockImplementation(
    () =>
      new Promise((resolve) => {
        finishes.push(() => resolve(localPath('/versions/A/tool')))
      }),
  )
  const pending = Array.from({ length: 4 }, () => f.approvals.inspectStatus(f.activation))
  expect(finishes).toHaveLength(4)
  expect(await f.approvals.inspectStatus(f.activation)).toMatchObject([
    { availability: 'unavailable' },
  ])
  f.approvals.endSession(f.approval)
  expect(await f.approvals.inspectStatus(f.activation)).toMatchObject([
    { reason: 'unavailable' },
  ])
  expect(finishes).toHaveLength(4)
  finishes.forEach((finish) => finish())
  await Promise.all(pending)
  f.host.realpath.mockResolvedValue(localPath('/versions/A/tool'))
  expect(await f.approvals.inspectStatus(f.activation)).toMatchObject([
    { availability: 'supported' },
  ])
})

it.each(['path', 'configuration', 'connector'] as const)(
  'never transfers session trust to another %s binding',
  async (change) => {
    const f = await fixture()
    await f.trust()
    const selection = {
      ...f.approval,
      ...(change === 'path' ? { executable: '/other/tool' } : {}),
      ...(change === 'configuration'
        ? { configuration: { args: ['different'], env: {} } }
        : {}),
      ...(change === 'connector' ? { connector: 'other' } : {}),
    }
    if (change === 'connector')
      Object.assign(f.activation.revision.manifest, {
        connectors: [
          ...f.activation.revision.manifest.connectors!,
          { ...f.approval.declaration, id: 'other' },
        ],
      })
    const prepared = await f.approvals.prepare(selection, () => undefined)
    await f.approvals.approve(prepared.token)
    f.target('/versions/B/tool')
    expect(
      await f.execution.execute(f.caller, { ...f.input, connector: selection.connector }),
    ).toMatchObject({ reason: 'executable-changed' })
    if (change === 'connector')
      expect(await f.execution.execute(f.caller, f.input)).toMatchObject({
        outcome: 'completed',
      })
  },
)

it('never shares a session with another host and leaves that host independent on disconnect', async () => {
  const f = await fixture('workspace')
  await f.trust()
  const original = f.hosts.hostById(f.host.hostId)!
  const local = {
    ...original,
    realpath: vi.fn((value: Parameters<typeof original.realpath>[0]) =>
      Promise.resolve(value),
    ),
    hostId: asHostId('local'),
    streamLocal: undefined,
    connectionState: 'connected' as const,
  }
  vi.spyOn(f.hosts, 'hostById').mockImplementation((id) =>
    id === 'local' ? local : original,
  )
  vi.spyOn(f.hosts, 'materializeHost').mockImplementation((id) =>
    Promise.resolve(id === 'local' ? local : original),
  )
  const listed = f.hosts.listHosts()
  vi.spyOn(f.hosts, 'listHosts').mockReturnValue([
    ...listed,
    {
      hostId: local.hostId,
      kind: 'local',
      label: 'Local',
      connectionState: 'connected',
      watchTier: 'polling',
    },
  ])
  const path = vi
    .spyOn(local, 'realpath')
    .mockImplementation((value) => Promise.resolve(value))
  const prepared = await f.approvals.prepare(
    { ...f.approval, host: 'local' },
    () => undefined,
  )
  await f.approvals.approve(prepared.token)
  path.mockResolvedValue(localPath('/versions/B/tool'))
  expect(await f.approvals.resolve(f.activation, prepared.approval)).toMatchObject({
    reason: 'executable-changed',
  })
  const localTrust = await f.approvals.prepare(
    prepared.approval,
    () => undefined,
    undefined,
    true,
  )
  await f.approvals.approve(localTrust.token)
  f.disconnect()
  expect(await f.approvals.resolve(f.activation, prepared.approval)).toMatchObject({
    executable: '/versions/B/tool',
  })
  f.reconnect()
  f.target('/versions/B/tool')
  expect(await f.approvals.resolve(f.activation, f.approval)).toMatchObject({
    reason: 'executable-changed',
  })
})

it('does not let a replaced Settings inspection claim readiness for the newer binding', async () => {
  const f = await fixture()
  let finish!: () => void
  const waiting = new Promise<void>((resolve) => {
    finish = resolve
  })
  f.host.realpath.mockImplementationOnce(async () => {
    await waiting
    return localPath('/versions/A/tool')
  })
  const pending = f.approvals.inspectSettings(f.activation, 'tool', 'local')
  const replacement = await f.approvals.prepare(
    { ...f.approval, executable: '/other/tool' },
    () => undefined,
  )
  await f.approvals.approve(replacement.token)
  finish()
  expect((await pending).connectors[0]).toMatchObject({
    availability: 'unavailable',
    selectedExecutable: '/other/tool',
  })
})

it('revalidates an earlier status row when session trust ends while another row is inspected', async () => {
  const f = await fixture()
  await f.trust()
  Object.assign(f.activation.revision.manifest, {
    connectors: [
      ...f.activation.revision.manifest.connectors!,
      { ...f.approval.declaration, id: 'other' },
    ],
  })
  const other = await f.approvals.prepare(
    { ...f.approval, connector: 'other' },
    () => undefined,
  )
  await f.approvals.approve(other.token)
  f.target('/versions/B/tool')
  let finish!: () => void, entered!: () => void
  const waiting = new Promise<void>((resolve) => {
    finish = resolve
  })
  const reached = new Promise<void>((resolve) => {
    entered = resolve
  })
  f.host.realpath
    .mockResolvedValueOnce(localPath('/versions/B/tool'))
    .mockImplementationOnce(async () => {
      entered()
      await waiting
      return localPath('/versions/B/tool')
    })
  const pending = f.approvals.inspectStatus(f.activation)
  await reached
  f.approvals.endSession(f.approval)
  finish()
  expect((await pending)[0]).toMatchObject({ availability: 'unavailable' })
})

it.each([
  ['changed', true],
  ['unknown', true],
  ['unknown', false],
] as const)(
  'repairs %s saved metadata with preserved configuration and consent=%s',
  async (metadata, accepted) => {
    const f = connectionFixture()
    const prior = await f.approve('/saved/launcher')
    f.host.realpath.mockImplementation((path) => {
      if (path.path !== prior.executable) return Promise.resolve(path)
      return metadata === 'changed'
        ? Promise.resolve(localPath('/versions/B/tool'))
        : Promise.reject(
            Object.assign(new Error('Unreadable target'), { code: 'EACCES' }),
          )
    })
    const choose = vi.fn(() => Promise.resolve('/picked/tool'))
    const confirmed = vi.fn()
    const owner = { id: 1, generation: 1 }
    const connection = new ExtensionConnectorConnectionOwner(
      new RendererResourceScopes(),
      () => true,
      f.authority,
      f.approvals,
      { folders: ['/discovered'], choose },
      (renderer, proposals) => {
        const proposal = proposals[0]
        if (!proposal) return
        confirmed(proposal.programs)
        expect(f.write).toHaveBeenCalledTimes(1)
        connection.decide(renderer, proposal.id, accepted)
      },
    )
    try {
      if (metadata === 'unknown') {
        const automatic = await connection.request(
          f.activation,
          owner,
          () => undefined,
          f.controller.signal,
          () => true,
          undefined,
          true,
        )
        expect(automatic.connections[0]).toMatchObject({ outcome: 'unavailable' })
        expect(choose).not.toHaveBeenCalled()
        expect(confirmed).not.toHaveBeenCalled()
      }
      const result = await connection.request(
        f.activation,
        owner,
        () => undefined,
        f.controller.signal,
        () => true,
      )
      const executable = metadata === 'changed' ? '/versions/B/tool' : '/picked/tool'
      expect(result.connections[0]?.outcome).toBe(accepted ? 'connected' : 'declined')
      expect(confirmed).toHaveBeenCalledWith([
        expect.objectContaining({
          canonicalExecutable: executable,
          configuration: prior.configuration,
        }),
      ])
      if (metadata === 'unknown')
        expect(choose).toHaveBeenCalledWith(owner, 'tool', ['/discovered/tool'])
      else {
        expect(choose).not.toHaveBeenCalled()
        expect(f.host.realpath).not.toHaveBeenCalledWith(localPath('/discovered/tool'))
      }
      const current = f.approvals.get(f.activation, 'tool', 'local')!
      expect(current.configuration).toEqual(prior.configuration)
      expect(current.executable).toBe(
        accepted && metadata === 'unknown' ? '/picked/tool' : prior.executable,
      )
      expect(current.canonicalExecutable).toBe(
        accepted ? executable : prior.canonicalExecutable,
      )
      expect(f.write).toHaveBeenCalledTimes(accepted ? 2 : 1)
      expect(f.host.exec).not.toHaveBeenCalled()
    } finally {
      connection.dispose()
    }
  },
)

function connectionFixture() {
  const base = connectorFixture()
  base.dispose()
  const revision = base.activation.revision
  const f = connectorFixture('application', undefined, undefined, {
    ...revision,
    manifest: {
      ...revision.manifest,
      connectors: revision.manifest.connectors!.map((entry) => ({
        ...entry,
        setup: { executable: 'tool' },
      })),
    },
  })
  fixtures.push(f)
  return f
}

it('admits execution while passive metadata is saturated', async () => {
  const f = await fixture()
  const finishes: (() => void)[] = []
  f.host.realpath.mockImplementation(() =>
    finishes.length < 4
      ? new Promise((resolve) =>
          finishes.push(() => resolve(localPath('/versions/A/tool'))),
        )
      : Promise.resolve(localPath('/versions/A/tool')),
  )
  const pending = Array.from({ length: 4 }, () => f.approvals.inspectStatus(f.activation))
  try {
    expect(finishes).toHaveLength(4)
    expect(await f.approvals.inspectStatus(f.activation)).toMatchObject([
      { reason: 'unavailable' },
    ])
    expect(await f.execution.execute(f.caller, f.input)).toMatchObject({
      outcome: 'completed',
    })
    expect(f.finiteExec.tryExec).toHaveBeenCalledWith(
      '/versions/A/tool',
      expect.anything(),
      expect.anything(),
    )
  } finally {
    finishes.forEach((finish) => finish())
    await Promise.all(pending)
  }
})

it('retains active resolution slots after Connect cancellation until metadata settles', async () => {
  const f = connectionFixture()
  const approval = await f.approve()
  const finishes: (() => void)[] = []
  f.host.realpath.mockImplementation(
    () =>
      new Promise((resolve) => {
        finishes.push(() => resolve(localPath(approval.canonicalExecutable)))
      }),
  )
  const choose = vi.fn(() => Promise.resolve(undefined)),
    publish = vi.fn()
  const connection = new ExtensionConnectorConnectionOwner(
    new RendererResourceScopes(),
    () => true,
    f.authority,
    f.approvals,
    { folders: ['/installed'], choose },
    publish,
  )
  const request = (signal: AbortSignal) =>
    connection.request(
      f.activation,
      { id: 1, generation: 1 },
      () => undefined,
      signal,
      () => true,
    )
  try {
    for (let index = 0; index < 4; index++) {
      const controller = new AbortController()
      const pending = request(controller.signal)
      await vi.waitFor(() => expect(finishes).toHaveLength(index + 1))
      controller.abort()
      expect((await pending).connections[0]?.outcome).toBe('unavailable')
    }
    expect((await request(f.controller.signal)).connections[0]?.outcome).toBe(
      'unavailable',
    )
    expect(finishes).toHaveLength(4)
    expect(choose).not.toHaveBeenCalled()
    expect(publish).not.toHaveBeenCalled()
    f.host.realpath.mockResolvedValue(localPath(approval.canonicalExecutable))
    expect(await f.approvals.inspectStatus(f.activation)).toMatchObject([
      { availability: 'supported' },
    ])
    finishes.forEach((finish) => finish())
    await vi.waitFor(async () =>
      expect((await request(f.controller.signal)).connections[0]?.outcome).toBe(
        'connected',
      ),
    )
    expect(f.write).toHaveBeenCalledTimes(1)
  } finally {
    finishes.forEach((finish) => finish())
    connection.dispose()
  }
})

it('distinguishes missing permission from unknown context, state and metadata', async () => {
  const f = connectorFixture('workspace')
  fixtures.push(f)
  expect(await f.approvals.inspectStatus(f.activation, 'remote')).toMatchObject([
    { reason: 'unapproved' },
  ])
  expect(await f.approvals.inspectStatus(f.activation)).toMatchObject([
    { reason: 'unavailable' },
  ])
  const approval = await f.approve()
  f.host.realpath.mockRejectedValue(new Error('Metadata inaccessible'))
  expect(await f.approvals.inspectStatus(f.activation, 'remote')).toMatchObject([
    { reason: 'unavailable' },
  ])
  f.disconnect()
  expect(await f.approvals.inspectStatus(f.activation, 'remote')).toMatchObject([
    { reason: 'disconnected' },
  ])
  f.active.clear()
  expect(await f.approvals.inspectStatus(f.activation, 'remote')).toMatchObject([
    { reason: 'unavailable' },
  ])
  expect(f.approvals.get(f.activation, approval.connector, approval.host)).toBeUndefined()
  const broken = connectorFixture()
  fixtures.push(broken)
  broken.setState('unreadable')
  await broken.approvals.start()
  expect(await broken.approvals.inspectStatus(broken.activation)).toMatchObject([
    { reason: 'unavailable' },
  ])
})

it('does not publish a later row revoked before its metadata turn', async () => {
  const f = await fixture()
  Object.assign(f.activation.revision.manifest, {
    connectors: [
      ...f.activation.revision.manifest.connectors!,
      { ...f.approval.declaration, id: 'other' },
    ],
  })
  const other = await f.approvals.prepare(
    { ...f.approval, connector: 'other' },
    () => undefined,
  )
  await f.approvals.approve(other.token)
  f.host.realpath.mockClear()
  let finish!: () => void
  f.host.realpath.mockImplementationOnce(
    () =>
      new Promise((resolve) => {
        finish = () => resolve(localPath('/versions/A/tool'))
      }),
  )
  const pending = f.approvals.inspectStatus(f.activation)
  await f.approvals.revoke(f.activation.installationId, 'other', 'local')
  finish()
  expect((await pending)[1]).toMatchObject({
    connector: 'other',
    availability: 'unavailable',
  })
  expect(f.host.realpath).toHaveBeenCalledOnce()
  expect((await f.approvals.inspectStatus(f.activation))[1]).toMatchObject({
    reason: 'unapproved',
  })
})
