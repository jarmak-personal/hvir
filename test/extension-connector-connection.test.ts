import type { ExtensionConnectionProposal } from '../src/shared/extensions/connectors'
import { localPath } from '../src/shared/host-path'
import { describe, expect, it, vi } from 'vitest'
import { promises as fs } from 'node:fs'
import { join } from 'node:path'
import {
  ExtensionConnectorConnectionOwner,
  type ExtensionConnectionDialog,
} from '../src/main/extensions/connector-connection'
import {
  ExtensionConnectorApprovalOwner,
  type ConnectorHostCatalog,
} from '../src/main/extensions/connector-approval'
import { discoverConnectorExecutables } from '../src/main/extensions/connector-discovery'
import { validateConnectorDeclarations } from '../src/shared/extensions/connectors'
import { connectorFixture } from './fixtures/extension-connector'
import { extensionInstallationFixture } from './fixtures/extension-installation'

const declaration = {
  id: 'tool',
  description: 'Read the personal library',
  context: 'application' as const,
  timeoutMs: 1000,
  outputBytes: 1000,
  environment: [],
  setup: { executable: 'tool' },
}
function held<T>() {
  let resolve!: (value: T) => void
  const promise = new Promise<T>((done) => {
    resolve = done
  })
  return { promise, resolve }
}
type FixtureDialog = ExtensionConnectionDialog & {
  confirm(
    this: void,
    owner: { id: number; generation: number },
    name: string,
    programs: ExtensionConnectionProposal['programs'],
  ): Promise<boolean>
}
function fixture(dialogOverride: Partial<FixtureDialog> = {}) {
  const base = connectorFixture()
  base.dispose()
  const data = connectorFixture('application', undefined, undefined, {
    ...base.activation.revision,
    manifest: { ...base.activation.revision.manifest, connectors: [declaration] },
  })
  const dialog: FixtureDialog = {
    folders: ['/installed'],
    choose: vi.fn(() => Promise.resolve(undefined)),
    confirm: vi.fn(() => Promise.resolve(true)),
    ...dialogOverride,
  }
  const connection = new ExtensionConnectorConnectionOwner(
    data.authority,
    data.approvals,
    dialog,
    (owner, proposals) => {
      const proposal = proposals[0]
      if (proposal)
        void dialog.confirm(owner, proposal.name, proposal.programs).then((accepted) => {
          try {
            connection.decide(owner, proposal.id, accepted)
          } catch {
            /* Withdrawn late test response has no authority. */
          }
        })
    },
  )
  const request = (foreground: () => boolean = () => true) =>
    connection.request(
      data.activation,
      { id: 1, generation: 1 },
      () => data.controller.signal.throwIfAborted(),
      data.controller.signal,
      foreground,
    )
  return {
    ...data,
    dialog,
    connection,
    request,
    stop: () => {
      connection.dispose()
      data.dispose()
    },
  }
}

describe('passive program connection', () => {
  it('validates only bounded app-local basename hints', () => {
    expect(validateConnectorDeclarations([declaration], vi.fn())).toEqual([declaration])
    for (const value of [
      { ...declaration, context: 'workspace' },
      { ...declaration, setup: { executable: '/bin/tool' } },
      { ...declaration, setup: { executable: 'tool; command' } },
    ])
      expect(() => validateConnectorDeclarations([value], vi.fn())).toThrow()
    expect(() =>
      validateConnectorDeclarations(
        Array.from({ length: 5 }, (_, i) => ({ ...declaration, id: `tool-${i}` })),
        vi.fn(),
      ),
    ).toThrow('Too many program setup hints')
  })
  it('deduplicates canonical aliases without executing a probe, and preserves ambiguity', async () => {
    const data = connectorFixture()
    try {
      data.host.realpath.mockImplementation((path) =>
        Promise.resolve({
          ...path,
          path: path.path.startsWith('/other') ? '/other/tool' : '/canonical/tool',
        }),
      )
      const candidates = await discoverConnectorExecutables(
        data.hosts.hostById('local')!,
        'tool',
        ['/bin', '/usr/bin', '/other', 'relative'],
        () => undefined,
      )
      expect(candidates).toEqual(['/canonical/tool', '/other/tool'])
      expect(data.host.realpath).toHaveBeenCalledTimes(3)
      expect(data.finiteExec.tryExec).not.toHaveBeenCalled()
      expect(data.host.exec).not.toHaveBeenCalled()
    } finally {
      data.dispose()
    }
  })
  it('prepares exact default config before one decision and persists only after consent', async () => {
    const data = fixture({
      confirm: vi.fn((_owner, _name, approvals) => {
        expect(data.state()).toEqual([])
        expect(approvals).toMatchObject([
          {
            canonicalExecutable: '/installed/tool',
            configuration: { args: [], env: {} },
            description: declaration.description,
          },
        ])
        return Promise.resolve(true)
      }),
    })
    try {
      expect(await data.request()).toEqual({
        connections: [{ connector: 'tool', outcome: 'connected' }],
      })
      expect(data.write).toHaveBeenCalledTimes(1)
      expect(data.approvals.get(data.activation, 'tool')).toBeDefined()
      expect(data.dialog.choose).not.toHaveBeenCalled()
      expect(data.finiteExec.tryExec).not.toHaveBeenCalled()
    } finally {
      data.stop()
    }
  })
  it('automatic Add with no detected program does not open a picker; explicit Connect remains achievable', async () => {
    const data = fixture()
    data.host.stat.mockRejectedValue(
      Object.assign(new Error('Not installed'), { code: 'ENOENT' }),
    )
    try {
      expect(
        (
          await data.connection.request(
            data.activation,
            { id: 1, generation: 1 },
            () => undefined,
            data.controller.signal,
            () => true,
            undefined,
            true,
          )
        ).connections[0]?.outcome,
      ).toBe('unavailable')
      expect(data.dialog.choose).not.toHaveBeenCalled()
      expect(data.dialog.confirm).not.toHaveBeenCalled()
      expect(data.write).not.toHaveBeenCalled()
      expect(data.finiteExec.tryExec).not.toHaveBeenCalled()
      await data.request()
      expect(data.dialog.choose).toHaveBeenCalledOnce()
      expect(data.dialog.confirm).not.toHaveBeenCalled()
    } finally {
      data.stop()
    }
  })
  it('decline cancels only this prepared token and does not discard another decision', async () => {
    const data = fixture({ confirm: vi.fn(() => Promise.resolve(false)) })
    try {
      const other = await data.approvals.prepare(
        {
          installationId: 'installation',
          connector: 'tool',
          host: 'local',
          executable: '/other/tool',
          configuration: { args: [], env: {} },
        },
        () => undefined,
      )
      const result = await data.request()
      expect(result.connections[0]?.outcome).toBe('declined')
      expect(data.write).not.toHaveBeenCalled()
      expect(data.approvals.preparedSignal(other.token).aborted).toBe(false)
      await data.approvals.approve(other.token)
      expect(data.approvals.get(data.activation, 'tool')?.canonicalExecutable).toBe(
        '/other/tool',
      )
    } finally {
      data.stop()
    }
  })
  it.each(['caller', 'activation', 'dispose'] as const)(
    'settles a held decision on %s withdrawal, ignores its late consent',
    async (withdrawal) => {
      const decision = held<boolean>(),
        entered = held<void>()
      const data = fixture({
        confirm: vi.fn(() => {
          entered.resolve()
          return decision.promise
        }),
      })
      try {
        const operation = data.request()
        await entered.promise
        if (withdrawal === 'caller') data.controller.abort()
        else if (withdrawal === 'activation') {
          data.active.clear()
          data.connection.revoke('installation')
        } else data.connection.dispose()
        expect((await operation).connections[0]?.outcome).toBe('unavailable')
        expect(data.write).not.toHaveBeenCalled()
        decision.resolve(true)
        await Promise.resolve()
        expect(data.write).not.toHaveBeenCalled()
      } finally {
        decision.resolve(false)
        data.stop()
      }
    },
  )
  it('publishes display-only bindings to the exact renderer generation and rejects foreign or retired decisions', async () => {
    const entered = held<void>(),
      answer = held<boolean>()
    const data = fixture({
      confirm: vi.fn(() => {
        entered.resolve()
        return answer.promise
      }),
    })
    const owner = { id: 1, generation: 1 }
    try {
      const operation = data.request()
      await entered.promise
      const proposal = data.connection.snapshot(owner)[0]!
      expect(proposal.programs[0]).toEqual({
        connector: 'tool',
        description: declaration.description,
        host: 'local',
        canonicalExecutable: '/installed/tool',
        configuration: { args: [], env: {} },
      })
      expect(Object.keys(proposal)).toEqual(['id', 'installationId', 'name', 'programs'])
      for (const foreign of [
        { id: 2, generation: 1 },
        { id: 1, generation: 2 },
      ]) {
        expect(data.connection.snapshot(foreign)).toEqual([])
        expect(() => data.connection.decide(foreign, proposal.id, true)).toThrow('ended')
      }
      expect(data.write).not.toHaveBeenCalled()
      data.connection.decide(owner, proposal.id, false)
      expect((await operation).connections[0]?.outcome).toBe('declined')
      expect(() => data.connection.decide(owner, proposal.id, true)).toThrow('ended')
      expect(data.connection.snapshot(owner)).toEqual([])
      expect(data.write).not.toHaveBeenCalled()
    } finally {
      answer.resolve(false)
      data.stop()
    }
  })
  it('retires an explicit native picker while it is held and ignores late selection without a proposal', async () => {
    const entered = held<void>(),
      selection = held<string | undefined>()
    const data = fixture({
      choose: vi.fn(() => {
        entered.resolve()
        return selection.promise
      }),
    })
    data.host.stat.mockRejectedValue(
      Object.assign(new Error('Absent'), { code: 'ENOENT' }),
    )
    try {
      const operation = data.request()
      await entered.promise
      data.controller.abort()
      expect((await operation).connections[0]?.outcome).toBe('unavailable')
      selection.resolve('/chosen/tool')
      await Promise.resolve()
      expect(data.dialog.confirm).not.toHaveBeenCalled()
      expect(data.write).not.toHaveBeenCalled()
      expect(data.connection.snapshot({ id: 1, generation: 1 })).toEqual([])
    } finally {
      selection.resolve(undefined)
      data.stop()
    }
  })
  it('keeps passive picker intent during its non-key parent phase, but requires foreground again before preparing consent', async () => {
    const entered = held<void>(),
      selected = held<string | undefined>()
    const data = fixture({
      choose: vi.fn(() => {
        entered.resolve()
        return selected.promise
      }),
    })
    data.host.stat.mockImplementation((path) => {
      if (path.path.startsWith('/installed'))
        return Promise.reject(Object.assign(new Error('Absent'), { code: 'ENOENT' }))
      return Promise.resolve({ type: 'file', mode: 0o755, size: 3, mtimeMs: 0 })
    })
    let foreground = true
    try {
      const operation = data.request(() => foreground)
      await entered.promise
      foreground = false
      data.connection.revalidate()
      expect(data.dialog.confirm).not.toHaveBeenCalled()
      expect(data.write).not.toHaveBeenCalled()
      expect(data.connection.snapshot({ id: 1, generation: 1 })).toEqual([])
      foreground = true
      selected.resolve('/chosen/tool')
      expect((await operation).connections[0]?.outcome).toBe('connected')
      expect(data.approvals.get(data.activation, 'tool')?.canonicalExecutable).toBe(
        '/chosen/tool',
      )
    } finally {
      selected.resolve(undefined)
      data.stop()
    }
  })
  it('refuses a picker return that still lacks foreground without issuing a proposal or grant', async () => {
    const entered = held<void>(),
      selected = held<string | undefined>()
    const data = fixture({
      choose: vi.fn(() => {
        entered.resolve()
        return selected.promise
      }),
    })
    data.host.stat.mockRejectedValue(
      Object.assign(new Error('Absent'), { code: 'ENOENT' }),
    )
    let foreground = true
    try {
      const operation = data.request(() => foreground)
      await entered.promise
      foreground = false
      selected.resolve('/chosen/tool')
      expect((await operation).connections[0]?.outcome).toBe('unavailable')
      expect(data.dialog.confirm).not.toHaveBeenCalled()
      expect(data.write).not.toHaveBeenCalled()
    } finally {
      selected.resolve(undefined)
      data.stop()
    }
  })
  it('refuses background admission before opening any picker', async () => {
    const data = fixture()
    try {
      expect((await data.request(() => false)).connections[0]?.outcome).toBe(
        'unavailable',
      )
      expect(data.host.realpath).not.toHaveBeenCalled()
      expect(data.dialog.choose).not.toHaveBeenCalled()
      expect(data.write).not.toHaveBeenCalled()
    } finally {
      data.stop()
    }
  })
  it('expires held consent under the existing 60-second decision bound', async () => {
    vi.useFakeTimers()
    const entered = held<void>(),
      decision = held<boolean>()
    const data = fixture({
      confirm: vi.fn(() => {
        entered.resolve()
        return decision.promise
      }),
    })
    try {
      const operation = data.request()
      await entered.promise
      await vi.advanceTimersByTimeAsync(60_000)
      expect((await operation).connections[0]?.outcome).toBe('unavailable')
      decision.resolve(true)
      await Promise.resolve()
      expect(data.write).not.toHaveBeenCalled()
      expect(vi.getTimerCount()).toBe(0)
    } finally {
      decision.resolve(false)
      data.stop()
      vi.useRealTimers()
    }
  })
  it('settles cancellation during metadata without a late picker or consent', async () => {
    const metadata =
      held<ReturnType<typeof import('../src/shared/host-path').localPath>>()
    const data = fixture()
    data.host.realpath.mockReturnValueOnce(metadata.promise)
    try {
      const operation = data.request()
      await vi.waitFor(() => expect(data.host.realpath).toHaveBeenCalledOnce())
      data.controller.abort()
      expect((await operation).connections[0]?.outcome).toBe('unavailable')
      metadata.resolve(localPath('/installed/tool'))
      await Promise.resolve()
      expect(data.dialog.choose).not.toHaveBeenCalled()
      expect(data.dialog.confirm).not.toHaveBeenCalled()
      expect(data.write).not.toHaveBeenCalled()
    } finally {
      metadata.resolve(localPath('/installed/tool'))
      data.stop()
    }
  })
  it('retains a committed first binding when another consent write fails', async () => {
    const data = fixture()
    const activation = {
      ...data.activation,
      revision: {
        ...data.activation.revision,
        manifest: {
          ...data.activation.revision.manifest,
          connectors: [declaration, { ...declaration, id: 'second' }],
        },
      },
    }
    data.active.set('installation', activation)
    data.write.mockImplementation((value, current) => {
      current()
      if (data.write.mock.calls.length === 2) throw new Error('Write unavailable')
      data.setState(value)
      return Promise.resolve()
    })
    try {
      const result = await data.connection.request(
        activation,
        { id: 1, generation: 1 },
        () => undefined,
        data.controller.signal,
        () => true,
      )
      expect(result.connections.map((entry) => [entry.connector, entry.outcome])).toEqual(
        [
          ['tool', 'connected'],
          ['second', 'interrupted-uncertain'],
        ],
      )
      expect(data.approvals.get(activation, 'tool')).toBeDefined()
      expect(data.approvals.get(activation, 'second')).toBeUndefined()
    } finally {
      data.stop()
    }
  })
  it('reports uncertainty after an actual atomic save succeeds and its caller is revoked', async () => {
    const data = await extensionInstallationFixture(),
      activations = data.make(),
      controller = new AbortController()
    let approvals: ExtensionConnectorApprovalOwner | undefined,
      connection: ExtensionConnectorConnectionOwner | undefined
    try {
      await data.packageAt('example', {
        connectors: [{ ...declaration, setup: { executable: 'true' } }],
      })
      await activations.start(data.lock)
      const entry = activations.snapshot().installations[0]!
      await activations.enable(entry.source, entry.revision!)
      const activation = [...activations.active.values()][0]!
      const hosts: ConnectorHostCatalog = {
        local: data.host,
        listHosts: () => [
          {
            hostId: data.host.hostId,
            label: 'Local',
            kind: 'local',
            connectionState: 'connected',
            watchTier: 'native',
          },
        ],
        hostById: () => data.host,
        materializeHost: () => Promise.resolve(data.host),
        onHostStateChange: () => () => undefined,
      }
      approvals = new ExtensionConnectorApprovalOwner(hosts, activations, () => undefined)
      await approvals.start()
      const write = data.host.writeFile.bind(data.host)
      vi.spyOn(data.host, 'writeFile').mockImplementation(
        async (path, bytes, options) => {
          await write(path, bytes, options)
          if (path.path.endsWith('/connectors.json'))
            controller.abort(new Error('Caller ended after save'))
        },
      )
      connection = new ExtensionConnectorConnectionOwner(
        activations,
        approvals,
        {
          folders: ['/usr/bin'],
          choose: () => Promise.resolve(undefined),
        },
        (owner, proposals) => {
          const proposal = proposals[0]
          if (proposal) connection!.decide(owner, proposal.id, true)
        },
      )
      const result = await connection.request(
        activation,
        { id: 1, generation: 1 },
        () => controller.signal.throwIfAborted(),
        controller.signal,
        () => true,
      )
      expect(result.connections[0]?.outcome).toBe('interrupted-uncertain')
      expect(
        JSON.parse(await fs.readFile(join(data.root, 'connectors.json'), 'utf8')),
      ).toMatchObject([{ connector: 'tool', configuration: { args: [], env: {} } }])
      expect(approvals.get(activation, 'tool')).toBeUndefined()
    } finally {
      connection?.dispose()
      approvals?.dispose()
      await activations.dispose()
      await data.dispose()
    }
  })
})
