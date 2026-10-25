import { describe, expect, it, vi } from 'vitest'

import { terminalNamingFixture } from './terminal-session-naming-fixture'
import {
  localPath,
  terminalTitle,
  terminalTitleTooltip,
  isTerminalTitleText,
} from '../src/shared'

it('shares automatic/custom title precedence and existing plain-text bounds', () => {
  expect(terminalTitle('Automatic')).toBe('Automatic')
  expect(terminalTitle('Automatic', 'My session')).toBe('My session')
  expect(terminalTitle('Latest', '')).toBe('Latest')
  expect(terminalTitleTooltip('Latest', 'My session')).toBe('Latest')
  expect(terminalTitleTooltip('Latest')).toBeUndefined()
  expect(isTerminalTitleText('')).toBe(false)
  expect(isTerminalTitleText('', true)).toBe(true)
  for (const name of ['a\ncommand', 'a\u001b]0;title', 'x'.repeat(513), 42]) {
    expect(isTerminalTitleText(name, true)).toBe(false)
  }
  expect(isTerminalTitleText('<b>Literal text</b>')).toBe(true)
})

describe.each([false, true])('retained session naming (SSH: %s)', (remote) => {
  it('persists a name, preserves exact recovery identity, keeps automatic updates, and clears to the latest title', async () => {
    const f = await terminalNamingFixture(remote)
    const original = f.registry.get(f.spawn.id)!
    const observer = vi.fn()
    f.registry.observe(observer)
    const renamed = await f.registry.rename(
      f.spawn.id,
      f.root,
      0,
      '  Review work  ',
      () => undefined,
    )
    expect(renamed).toMatchObject({ customName: 'Review work', nameRevision: 1 })
    expect(observer).toHaveBeenCalledOnce()
    const restored = await f.reload()
    expect(restored.get(f.spawn.id)).toEqual(renamed)
    await restored.recordSpawn({ ...f.spawn, title: 'New program title' })
    expect(restored.get(f.spawn.id)).toMatchObject({
      customName: 'Review work',
      nameRevision: 1,
    })
    await restored.updateLayout(f.root, [
      { id: f.spawn.id, title: 'Latest automatic', position: 0, active: false },
    ])
    expect(
      terminalTitle(
        restored.get(f.spawn.id)!.title,
        restored.get(f.spawn.id)!.customName,
      ),
    ).toBe('Review work')
    await restored.rename(f.spawn.id, f.root, 1, '   ', () => undefined)
    const cleared = (await f.reload()).get(f.spawn.id)!
    expect(cleared.customName).toBeUndefined()
    expect(cleared.nameRevision).toBe(2)
    expect(terminalTitle(cleared.title, cleared.customName)).toBe('Latest automatic')
    expect(cleared).toMatchObject({
      providerId: original.providerId,
      profileId: original.profileId,
      launchRevision: original.launchRevision,
      harnessSessionId: original.harnessSessionId,
      cwd: original.cwd,
    })
  })

  it('reads legacy records without naming metadata and rejects stale, wrong-root, missing, and unsafe targets', async () => {
    const f = await terminalNamingFixture(remote)
    expect((await f.reload()).get(f.spawn.id)?.customName).toBeUndefined()
    await expect(
      f.registry.rename('missing', f.root, 0, 'Name', () => undefined),
    ).rejects.toThrow('changed')
    await expect(
      f.registry.rename(f.spawn.id, localPath('/elsewhere'), 0, 'Name', () => undefined),
    ).rejects.toThrow('changed')
    await expect(
      f.registry.rename(f.spawn.id, f.root, 0, 'Bad\u0007name', () => undefined),
    ).rejects.toThrow('Invalid')
    await f.registry.rename(f.spawn.id, f.root, 0, 'Newer decision', () => undefined)
    await expect(
      f.registry.rename(f.spawn.id, f.root, 0, 'Stale decision', () => undefined),
    ).rejects.toThrow('changed')
    expect((await f.reload()).get(f.spawn.id)?.customName).toBe('Newer decision')
  })
})

it('keeps pending names invisible and rolls back disk failures without losing newer automatic titles', async () => {
  const f = await terminalNamingFixture()
  let rejectWrite!: (reason: Error) => void
  const pending = new Promise<void>((_resolve, reject) => {
    rejectWrite = reject
  })
  f.writeFile.mockImplementationOnce(() => pending)
  const rename = f.registry.rename(f.spawn.id, f.root, 0, 'Unsaved', () => undefined)
  const rejected = expect(rename).rejects.toThrow('Disk full')
  expect(f.registry.get(f.spawn.id)?.customName).toBeUndefined()
  expect(f.registry.list(f.root)[0]?.customName).toBeUndefined()
  expect(f.registry.observationSnapshot()[0]?.customName).toBeUndefined()
  await expect(
    f.registry.rename(f.spawn.id, f.root, 1, 'Concurrent', () => undefined),
  ).rejects.toThrow('already')
  const layout = f.registry.updateLayout(f.root, [
    { id: f.spawn.id, title: 'Latest automatic', position: 2, active: false },
  ])
  rejectWrite(new Error('Disk full'))
  await rejected
  await layout
  const restored = (await f.reload()).get(f.spawn.id)!
  expect(restored.customName).toBeUndefined()
  expect(restored.title).toBe('Latest automatic')
  expect(restored.position).toBe(2)
})

it('keeps a write committed after dispatch and never resurrects a forgotten target', async () => {
  const f = await terminalNamingFixture()
  const write = f.writeFile.getMockImplementation()!
  let current = true
  f.writeFile.mockImplementationOnce((file, data) => {
    current = false
    return write(file, data)
  })
  await f.registry.rename(f.spawn.id, f.root, 0, 'Committed', () => {
    if (!current) throw new Error('Revoked')
  })
  expect((await f.reload()).get(f.spawn.id)?.customName).toBe('Committed')
  const renameAgain = f.registry.rename(
    f.spawn.id,
    f.root,
    1,
    'Forgotten',
    () => undefined,
  )
  const forgotten = f.registry.forget(f.root, f.spawn.id)
  await expect(renameAgain).rejects.toThrow('changed')
  await forgotten
  expect((await f.reload()).get(f.spawn.id)).toBeUndefined()
})

it('surfaces both storage failures instead of claiming that a failed rollback succeeded', async () => {
  const f = await terminalNamingFixture()
  f.writeFile
    .mockRejectedValueOnce(new Error('Initial write failed'))
    .mockRejectedValueOnce(new Error('Rollback failed'))
  await expect(
    f.registry.rename(f.spawn.id, f.root, 0, 'Unsaved', () => undefined),
  ).rejects.toThrow('could not be saved or restored')
  expect(f.registry.get(f.spawn.id)?.customName).toBeUndefined()
})

it.each(['fork', 'fresh'])(
  'new %s records start unnamed and accept a first rename at revision zero',
  async (kind) => {
    const f = await terminalNamingFixture()
    await f.registry.rename(f.spawn.id, f.root, 0, 'Source name', () => undefined)
    const spawn = { ...f.spawn, id: 'new-terminal' }
    if (kind === 'fresh')
      await f.registry.recordReplacement({ replacedId: f.spawn.id, spawn })
    else await f.registry.recordSpawn(spawn)
    expect(f.registry.get(spawn.id)?.customName).toBeUndefined()
    expect(f.registry.get(spawn.id)?.nameRevision).toBeUndefined()
    await f.registry.rename(spawn.id, f.root, 0, 'New name', () => undefined)
    expect((await f.reload()).get(spawn.id)?.customName).toBe('New name')
  },
)

it('does not return an uncommitted name through a concurrent move response', async () => {
  const f = await terminalNamingFixture()
  let rejectWrite!: (reason: Error) => void
  f.writeFile.mockImplementationOnce(
    () =>
      new Promise<void>((_resolve, reject) => {
        rejectWrite = reject
      }),
  )
  const renaming = f.registry.rename(
    f.spawn.id,
    f.root,
    0,
    'Unsaved name',
    () => undefined,
  )
  const rejected = expect(renaming).rejects.toThrow('Disk full')
  await vi.waitFor(() => expect(f.writeFile).toHaveBeenCalledTimes(2))
  const targetRoot = localPath('/project/branch')
  const moving = f.registry.move({ id: f.spawn.id, sourceRoot: f.root, targetRoot })
  rejectWrite(new Error('Disk full'))
  await rejected
  expect((await moving).customName).toBeUndefined()
  const restored = (await f.reload()).get(f.spawn.id)!
  expect(restored.workspaceRoot).toEqual(targetRoot)
  expect(restored.customName).toBeUndefined()
})
