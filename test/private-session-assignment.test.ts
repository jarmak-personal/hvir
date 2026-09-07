import {
  mkdtemp,
  chmod,
  mkdir,
  readdir,
  readFile,
  rm,
  stat,
  symlink,
  writeFile,
} from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { assignSession } from '../scripts/agent-work-checkpoint-store.mts'

const roots: string[] = []
afterEach(async () => {
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true })
})
async function fixture() {
  const root = await mkdtemp(join(tmpdir(), 'hvir-assignment-test-'))
  roots.push(root)
  return {
    root: join(root, 'private'),
    repository: 'owner/repo',
    provider: 'codex',
    session: 'private-current-session',
    issue: 757,
    apply: true,
  }
}

describe('private session assignment filesystem boundary', () => {
  it('dry-run creates no state, capture binds once and later issue assignment is rejected', async () => {
    const input = await fixture()
    expect(await assignSession({ ...input, apply: false })).toBeUndefined()
    const assigned = await assignSession(input)
    expect(await assignSession(input)).toEqual(assigned)
    await expect(assignSession({ ...input, issue: 758 })).rejects.toThrow(
      'already belongs',
    )
    expect((await stat(input.root)).mode & 0o077).toBe(0)
    const paths = await readdir(input.root)
    expect(paths).toHaveLength(1)
    const stored = await readFile(join(input.root, paths[0]!), 'utf8')
    expect(stored).not.toContain(input.session)
    expect((await stat(join(input.root, paths[0]!))).mode & 0o077).toBe(0)
  })
  it('publishes complete identity once under simultaneous captures', async () => {
    const input = await fixture()
    const assignments = await Promise.all(
      Array.from({ length: 20 }, () => assignSession(input)),
    )
    expect(new Set(assignments.map((row) => row?.receipt)).size).toBe(1)
    expect(await readdir(input.root)).toHaveLength(1)
  })
  it('an interrupted unpublished temporary file cannot become a final assignment', async () => {
    const input = await fixture()
    await mkdir(input.root, { mode: 0o700 })
    await writeFile(join(input.root, '.pending-interrupted'), '{', { mode: 0o600 })
    expect(await assignSession(input)).toMatchObject({ issue: 757 })
    expect(await readFile(join(input.root, '.pending-interrupted'), 'utf8')).toBe('{')
  })
  it('rejects permissive or symlinked roots and corrupt retained identity without replacing it', async () => {
    const input = await fixture()
    await assignSession(input)
    const [name] = await readdir(input.root)
    await writeFile(join(input.root, name!), '{', { mode: 0o600 })
    await expect(assignSession(input)).rejects.toThrow('unavailable')
    await chmod(input.root, 0o755)
    await expect(assignSession(input)).rejects.toThrow('unsafe')
    const alias = join(roots.at(-1)!, 'alias')
    await symlink(input.root, alias)
    await expect(assignSession({ ...input, root: alias })).rejects.toThrow('unsafe')
  })
})
