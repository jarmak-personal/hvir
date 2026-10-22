import { afterEach, expect, it, vi } from 'vitest'
import { sourceFixture } from './fixtures/extension-source'
import { ExtensionSourceReveal } from '../src/main/extensions/source-reveal'
import { localPath } from '../src/shared/host-path'

const fixtures: ReturnType<typeof sourceFixture>[] = []
afterEach(() => {
  for (const f of fixtures.splice(0)) f.dispose()
})
async function fixture(context: 'application' | 'workspace' = 'workspace') {
  const f = sourceFixture(context)
  fixtures.push(f)
  await f.grant()
  f.host.stat.mockResolvedValue({ type: 'dir', size: 0, mode: 0o755, mtimeMs: 0 })
  const publish = vi.fn(),
    reveal = new ExtensionSourceReveal(f.approvals, publish),
    owner = { id: 7, generation: 3 },
    path = localPath('/library/skill'),
    input = { source: 'source', workspaceId: 'workspace', path }
  return { ...f, publish, owner, input, reveal }
}
it('reveals one exact canonical granted directory to its renderer without reading or mutating bytes', async () => {
  const f = await fixture()
  await expect(f.reveal.reveal(f.caller, f.input, f.owner)).resolves.toBeNull()
  expect(f.publish).toHaveBeenCalledExactlyOnceWith(f.owner, {
    workspaceId: 'workspace',
    root: f.root,
    path: f.input.path,
  })
  expect(f.host.readTextFilePrefix).not.toHaveBeenCalled()
})
it.each(['agent', 'action', 'updater'])(
  'refuses %s origin without observing filesystem paths',
  async () => {
    const f = await fixture()
    f.host.realpath.mockClear()
    await expect(
      f.reveal.reveal({ ...f.caller, allowed: false }, f.input, f.owner),
    ).rejects.toThrow(/human-selected/)
    expect(f.host.realpath).not.toHaveBeenCalled()
    expect(f.publish).not.toHaveBeenCalled()
  },
)
it('refuses application grants, substituted workspace identity, lexical and symlink escape', async () => {
  const app = await fixture('application')
  await expect(app.reveal.reveal(app.caller, app.input, app.owner)).rejects.toThrow(
    /exact granted/,
  )
  const f = await fixture()
  await expect(
    f.reveal.reveal(f.caller, { ...f.input, workspaceId: 'other' }, f.owner),
  ).rejects.toThrow(/exact granted/)
  await expect(
    f.reveal.reveal(f.caller, { ...f.input, path: localPath('/elsewhere') }, f.owner),
  ).rejects.toThrow(/exact granted/)
  f.host.realpath.mockImplementation((path) =>
    Promise.resolve(path.path === f.input.path.path ? localPath('/elsewhere') : path),
  )
  await expect(f.reveal.reveal(f.caller, f.input, f.owner)).rejects.toThrow(/escapes/)
  expect(f.publish).not.toHaveBeenCalled()
})
it.each(['hide', 'revoke', 'workspace'])(
  'rejects %s while canonical observation is unresolved',
  async (change) => {
    const f = await fixture()
    let release!: () => void, entered!: () => void
    const held = new Promise<void>((resolve) => {
        release = resolve
      }),
      reached = new Promise<void>((resolve) => {
        entered = resolve
      })
    f.host.realpath.mockImplementation(async (path) => {
      entered()
      await held
      return path
    })
    const attempt = f.reveal.reveal(f.caller, f.input, f.owner)
    const rejected = expect(attempt).rejects.toThrow()
    await reached
    if (change === 'hide') f.close()
    else if (change === 'revoke') f.approvals.dispose()
    else f.workspaces.length = 0
    release()
    await rejected
    expect(f.publish).not.toHaveBeenCalled()
  },
)
