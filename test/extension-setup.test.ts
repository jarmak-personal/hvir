import { afterEach, describe, expect, it, vi } from 'vitest'
import { setupFixture } from './fixtures/extension-setup'
import { localPath } from '../src/shared/host-path'

const fixtures: Awaited<ReturnType<typeof setupFixture>>[] = []
async function fixture(remote = false) {
  const f = await setupFixture(remote)
  fixtures.push(f)
  return f
}
afterEach(async () => {
  vi.useRealTimers()
  for (const f of fixtures.splice(0)) await f.dispose()
})

describe('trusted immutable extension setup review', () => {
  it('prepares multiple real owner identities without executing tools or retaining tokens; applies one immutable snapshot', async () => {
    const f = await fixture()
    const prepare = vi.spyOn(f.program.approvals, 'prepare'),
      cancel = vi.spyOn(f.program.approvals, 'cancelPrepared')
    const review = await f.import()
    expect(review?.rows.map((row) => row.state)).toEqual(['ready', 'ready', 'ready'])
    expect(f.program.host.exec).not.toHaveBeenCalled()
    expect(f.source.host.readTextFilePrefix).not.toHaveBeenCalled()
    for (const call of prepare.mock.results) {
      const result = await (call.value as ReturnType<typeof f.program.approvals.prepare>)
      expect(cancel).toHaveBeenCalledWith(result.token)
      await expect(f.program.approvals.approve(result.token)).rejects.toThrow(/again/)
    }
    f.setData({ ...f.data(), connectors: [] })
    const result = await f.apply()
    expect(result.rows.map((row) => row.state)).toEqual(['saved', 'saved', 'saved'])
    expect(f.program.write).toHaveBeenCalledTimes(2)
    expect(f.source.authority.saveSourceGrants).toHaveBeenCalledOnce()
    expect(prepare).toHaveBeenCalledTimes(4)
    expect(f.picker.read).toHaveBeenCalledOnce()
  })
  it('reuses unchanged full bindings without writing them again', async () => {
    const f = await fixture()
    await f.import()
    await f.apply()
    const review = await f.import()
    expect(review?.rows.every((row) => row.state === 'unchanged')).toBe(true)
    await f.apply()
    expect(f.program.write).toHaveBeenCalledTimes(2)
    expect(f.source.authority.saveSourceGrants).toHaveBeenCalledOnce()
  })
  it('requires a fresh decision for changed canonical targets or concurrent exact prior writes', async () => {
    const f = await fixture()
    await f.import()
    f.program.host.realpath.mockResolvedValue(localPath('/other/tool'))
    const result = await f.apply()
    expect(result.rows[0]?.state).toBe('failed')
    expect(result.rows[0]?.explanation).toMatch(/target changed/)
    expect(f.program.write).not.toHaveBeenCalled()
    f.program.host.realpath.mockImplementation((path) => Promise.resolve(path))
    await f.import()
    await f.program.approve('/installed/tool', { args: [], env: {} })
    const changed = await f.apply()
    expect(changed.phase).toBe('ended')
    expect(changed.explanation).toMatch(/changed/)
    expect(f.program.write).toHaveBeenCalledTimes(1)
  })
  it.each(['program', 'source'] as const)(
    'fresh-checks unchanged %s metadata before any selected new setting can write',
    async (kind) => {
      const f = await fixture()
      await f.import()
      await f.apply()
      const next = { ...f.data(), requestAgentAccess: true }
      f.setData(next)
      f.program.write.mockClear()
      f.source.authority.saveSourceGrants.mockClear()
      const review = await f.import()
      expect(review?.rows.map((row) => row.state)).toEqual([
        'unchanged',
        'unchanged',
        'unchanged',
        'ready',
      ])
      if (kind === 'program')
        f.program.host.realpath.mockResolvedValue(localPath('/replacement/tool'))
      else {
        f.source.host.realpath.mockImplementation((path) =>
          Promise.resolve(
            path.path === '/library' ? localPath('/replacement/library') : path,
          ),
        )
        f.source.host.stat.mockResolvedValue({
          type: 'dir',
          size: 0,
          mode: 0o755,
          mtimeMs: 0,
        })
      }
      const result = await f.apply()
      expect(result.rows[kind === 'program' ? 0 : 2]?.state).toBe('failed')
      expect(result.rows[kind === 'program' ? 0 : 2]?.explanation).toMatch(
        kind === 'program' ? /target changed/ : /scope changed/,
      )
      expect(f.configureAgentAccess).not.toHaveBeenCalled()
      expect(f.program.write).not.toHaveBeenCalled()
      expect(f.source.authority.saveSourceGrants).not.toHaveBeenCalled()
    },
  )
  it('rejects the complete over-capacity native batch before any write, then admits only selected source access without evicting other installations', async () => {
    const f = await fixture()
    const prepared = await f.program.approvals.prepare(
      {
        installationId: 'installation',
        connector: 'tool',
        host: 'local',
        executable: '/installed/tool',
        configuration: { args: [], env: {} },
      },
      () => {},
    )
    f.program.approvals.cancelPrepared(prepared.token)
    f.program.setState(
      Array.from({ length: 256 }, (_, index) => ({
        ...prepared.approval,
        installationId: `other-${index}`,
      })),
    )
    await f.program.approvals.start()
    const review = await f.import()
    expect(review?.capacityError).toMatch(/bound/)
    await expect(f.apply()).rejects.toThrow(/bound/)
    expect(f.program.write).not.toHaveBeenCalled()
    f.owner.select(f.renderer, 'request', ['source-0'])
    const result = await f.apply()
    expect(result.rows.map((row) => row.state)).toEqual(['declined', 'declined', 'saved'])
    expect(f.program.approvals.project([]).records).toBe(256)
    expect(f.program.write).not.toHaveBeenCalled()
  })
  it('rejects overlapping canonical source bindings across unchanged and unselected rows before any write', async () => {
    const f = await fixture()
    await f.import()
    await f.apply()
    f.program.write.mockClear()
    f.source.authority.saveSourceGrants.mockClear()
    const data = f.data()
    f.setData({
      ...data,
      requestAgentAccess: true,
      sources: [...data.sources, ...data.sources],
    })
    const review = await f.import()
    expect(
      review?.rows.filter((row) => row.kind === 'source').map((row) => row.state),
    ).toEqual(['unchanged', 'unchanged'])
    expect(review?.capacityError).toMatch(/Duplicate source/)
    f.owner.select(f.renderer, 'request', ['agent'])
    await expect(f.apply()).rejects.toThrow(/Duplicate source/)
    expect(f.configureAgentAccess).not.toHaveBeenCalled()
    expect(f.program.write).not.toHaveBeenCalled()
    expect(f.source.authority.saveSourceGrants).not.toHaveBeenCalled()
    f.cancel()
    f.source.host.stat.mockResolvedValue({
      type: 'dir',
      size: 0,
      mode: 0o755,
      mtimeMs: 0,
    })
    f.setData({
      ...data,
      sources: [
        data.sources[0]!,
        { source: 'source', root: { host: f.program.host.hostId, path: '/other' } },
      ],
    })
    const fresh = await f.import()
    expect(fresh?.rows.at(-1)?.state).toBe('ready')
    expect(f.owner.select(f.renderer, 'request', []).capacityError).toMatch(
      /Duplicate source/,
    )
    await expect(f.apply()).rejects.toThrow(/Duplicate source/)
    expect(f.source.authority.saveSourceGrants).not.toHaveBeenCalled()
  })
  it.each(['program', 'agent'] as const)(
    'allows independent %s setup while an unrelated source store is unavailable',
    async (kind) => {
      const f = await fixture()
      f.source.approvals.dispose()
      if (kind === 'agent') f.program.approvals.dispose()
      f.setData({
        ...f.data(),
        sources: [],
        connectors: kind === 'program' ? f.data().connectors : [],
        ...(kind === 'agent' ? { requestAgentAccess: true } : {}),
      })
      const review = await f.import()
      expect(review?.capacityError).toBeUndefined()
      expect((await f.apply()).rows.every((row) => row.state === 'saved')).toBe(true)
      expect(f.source.authority.saveSourceGrants).not.toHaveBeenCalled()
    },
  )
  it('delegates host and source-scope rejection to the real permission owners', async () => {
    const f = await fixture(true)
    Object.assign(f.program.activation.revision.manifest.connectors![0]!, {
      context: 'application',
    })
    Object.assign(f.source.declaration, { context: 'application' })
    const data = f.data()
    f.setData({
      ...data,
      sources: [
        { source: 'source', root: { host: f.program.host.hostId, path: '/library' } },
      ],
    })
    let review = await f.import()
    expect(review?.rows[0]?.explanation).toMatch(/local/)
    expect(review?.rows[2]?.explanation).toMatch(/local/)
    f.cancel()
    Object.assign(f.source.declaration, { context: 'workspace' })
    review = await f.import()
    expect(review?.rows[2]?.explanation).toMatch(/registered project context/)
    const local = await fixture()
    Object.assign(local.source.declaration, {
      context: 'workspace',
      mode: 'managed-delivery',
    })
    local.setData({
      ...local.data(),
      sources: [
        {
          source: 'source',
          workspace: { host: local.program.host.hostId, path: '/library' },
        },
      ],
    })
    expect((await local.import())?.rows[2]?.explanation).toMatch(
      /explicitly selected SSH workspace/,
    )
  })
  it('dismisses the chooser quietly and releases the slot without reading or publishing', async () => {
    const f = await fixture()
    f.picker.choose.mockResolvedValueOnce(undefined)
    await expect(f.import()).resolves.toBeUndefined()
    expect(f.reviews).toEqual([])
    expect(f.picker.read).not.toHaveBeenCalled()
    expect(f.program.write).not.toHaveBeenCalled()
    await expect(f.import()).resolves.toBeDefined()
  })
  it('keeps completed independent saves when the next submitted save fails and stops the rest', async () => {
    const f = await fixture()
    await f.import()
    const write = f.program.write.getMockImplementation()!
    f.program.write
      .mockImplementationOnce(write)
      .mockRejectedValueOnce(new Error('write interrupted'))
    const result = await f.apply()
    expect(result.rows.map((row) => row.state)).toEqual([
      'saved',
      'interrupted-uncertain',
      'declined',
    ])
    expect(f.source.authority.saveSourceGrants).not.toHaveBeenCalled()
    expect(f.program.approvals.settings(f.program.activation).connectors).toHaveLength(1)
    expect(result.rows.map((row) => row.retainedSetting)).toEqual([true, false, false])
    const retry = await f.import()
    expect(retry?.rows[0]?.state).toBe('unchanged')
  })
  it('cancels during physical preparation without freeing the review slot or publishing a late review', async () => {
    const f = await fixture()
    let release!: () => void
    const barrier = new Promise<void>((resolve) => {
      release = resolve
    })
    f.program.host.realpath.mockImplementationOnce(async (path) => {
      await barrier
      return path
    })
    const pending = f.import(),
      rejected = expect(pending).rejects.toThrow()
    await vi.waitFor(() => expect(f.program.host.realpath).toHaveBeenCalled())
    f.cancel()
    await expect(f.import()).rejects.toThrow(/current setup/)
    release()
    await rejected
    expect(f.reviews.some((review) => review.phase === 'ready')).toBe(false)
    expect(f.program.write).not.toHaveBeenCalled()
    await expect(f.import()).resolves.toBeDefined()
  })
  it('preserves completed writes on cancellation and never starts subsequent rows', async () => {
    const f = await fixture()
    await f.import()
    const write = f.program.write.getMockImplementation()!
    f.program.write.mockImplementationOnce(async (value, current) => {
      await write(value, current)
      f.cancel()
    })
    const result = await f.apply()
    expect(f.reviews.some((review) => review.phase === 'stopping')).toBe(true)
    expect(result.phase).toBe('ended')
    expect(result.rows[0]?.state).toBe('interrupted-uncertain')
    expect(result.rows[0]?.retainedSetting).toBe(false)
    expect(result.rows.slice(1).every((row) => row.state === 'declined')).toBe(true)
    expect(f.program.write).toHaveBeenCalledOnce()
    expect(f.source.authority.saveSourceGrants).not.toHaveBeenCalled()
  })
  it('keeps an interrupted submission uncertain even when the owner retains matching saved access', async () => {
    const f = await fixture()
    await f.import()
    const approve = f.program.approvals.approve.bind(f.program.approvals)
    vi.spyOn(f.program.approvals, 'approve').mockImplementationOnce(async (token) => {
      await approve(token)
      throw new Error('Submission result lost')
    })
    const result = await f.apply()
    expect(result.rows[0]).toMatchObject({
      state: 'interrupted-uncertain',
      retainedSetting: true,
    })
    expect(f.program.write).toHaveBeenCalledOnce()
    expect(f.source.authority.saveSourceGrants).not.toHaveBeenCalled()
  })
  it('allows native picker focus loss, then waits for actual foreground before reading the file', async () => {
    const f = await fixture()
    f.picker.choose.mockImplementationOnce(() => {
      f.focus(false)
      return Promise.resolve(localPath('/setup.json'))
    })
    const importing = f.import()
    await vi.waitFor(() => expect(f.picker.choose).toHaveBeenCalled())
    expect(f.picker.read).not.toHaveBeenCalled()
    f.focus(true)
    await importing
    f.focus(false)
    f.focus(true)
    await expect(f.apply()).rejects.toThrow(/ended/)
    expect(f.program.write).not.toHaveBeenCalled()
  })
  it('retires review on renderer/activation loss and has a finite absolute lifetime', async () => {
    const f = await fixture()
    await f.import()
    await f.scopes.revokeOwner(f.renderer.id)
    await expect(f.apply()).rejects.toThrow(/revoked/)
    const second = await fixture()
    await second.import()
    second.program.active.set('installation', {
      ...second.program.activation,
      generation: 'replacement',
    })
    await expect(second.apply()).rejects.toThrow(/ended/)
    const third = await fixture()
    vi.useFakeTimers()
    await third.import()
    await vi.advanceTimersByTimeAsync(10 * 60_000)
    await expect(third.apply()).rejects.toThrow(/ended/)
  })
  it('retains exact remote metadata and rejects an SSH generation change even after reconnect', async () => {
    const f = await fixture(true)
    const review = await f.import()
    expect(review?.rows.every((row) => row.location?.hostId === 'remote')).toBe(true)
    f.program.reconnect()
    const result = await f.apply()
    expect(result.phase).toBe('ended')
    expect(f.program.write).not.toHaveBeenCalled()
  })
  it('retains the native owner checked generation across the prepare-return boundary without retaining token authority', async () => {
    const f = await fixture(true)
    const prepare = f.program.approvals.prepare.bind(f.program.approvals)
    vi.spyOn(f.program.approvals, 'prepare').mockImplementationOnce(async (...args) => {
      const result = await prepare(...args)
      f.program.reconnect()
      return result
    })
    const review = await f.import()
    expect(review?.rows[0]?.state).toBe('blocked')
    expect(review?.rows[0]?.explanation).toMatch(/host changed/)
    expect(f.program.write).not.toHaveBeenCalled()
  })
  it('blocks unknown hosts and ambiguous workspaces locally while letting selected valid rows apply', async () => {
    const f = await fixture(true)
    f.source.workspaces.push({ ...f.source.workspaces[0]!, id: 'duplicate' })
    const data = f.data()
    f.setData({
      ...data,
      connectors: data.connectors.map((row, index) =>
        index ? { ...row, host: 'unknown' } : row,
      ),
    })
    const review = await f.import()
    expect(review?.rows.map((row) => row.state)).toEqual(['ready', 'blocked', 'blocked'])
    const result = await f.apply()
    expect(result.rows[0]?.state).toBe('saved')
    expect(f.program.write).toHaveBeenCalledOnce()
    expect(f.source.authority.saveSourceGrants).not.toHaveBeenCalled()
  })
})
