import { createHash } from 'node:crypto'
import { execFile } from 'node:child_process'
import { cp, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { promisify } from 'node:util'
import { afterEach, describe, expect, it } from 'vitest'
import { applyNodePtyPatch } from '../scripts/node-pty/apply.mjs'

const execute = promisify(execFile)
const repository = process.cwd()
const patchRoot = join(repository, 'scripts/node-pty')
const fixtures: string[] = []
const sha = (bytes: Uint8Array) => createHash('sha256').update(bytes).digest('hex')
interface Pin {
  patch: string
  files: { path: string; originalSha256: string; patchedSha256: string }[]
}
async function fixture() {
  const root = await mkdtemp(join(tmpdir(), 'hvir-node-pty-patch-'))
  fixtures.push(root)
  const pin = JSON.parse(await readFile(join(patchRoot, 'pin.json'), 'utf8')) as Pin
  const packageRoot = join(root, 'node_modules/node-pty')
  await execute('git', ['init', '-q', root])
  await mkdir(packageRoot, { recursive: true })
  await Promise.all(
    ['package.json', 'package-lock.json'].map(async (file) =>
      cp(join(repository, file), join(root, file)),
    ),
  )
  await cp(
    join(repository, 'node_modules/node-pty/package.json'),
    join(packageRoot, 'package.json'),
  )
  for (const file of pin.files) {
    const target = join(packageRoot, file.path)
    await mkdir(dirname(target), { recursive: true })
    await cp(join(repository, 'node_modules/node-pty', file.path), target)
  }
  const hashes = await Promise.all(
    pin.files.map(async (file) => sha(await readFile(join(packageRoot, file.path)))),
  )
  if (hashes.every((hash, index) => hash === pin.files[index]!.patchedSha256))
    await execute(
      'git',
      [
        'apply',
        '--reverse',
        '--directory=node_modules/node-pty',
        join(patchRoot, pin.patch),
      ],
      { cwd: root },
    )
  else expect(hashes).toEqual(pin.files.map((file) => file.originalSha256))
  const hashesNow = () =>
    Promise.all(
      pin.files.map(async (file) => sha(await readFile(join(packageRoot, file.path)))),
    )
  expect(await hashesNow()).toEqual(pin.files.map((file) => file.originalSha256))
  return { root, packageRoot, pin, hashesNow }
}
afterEach(async () => {
  await Promise.all(
    fixtures.splice(0).map((root) => rm(root, { recursive: true, force: true })),
  )
})

describe('fixed node-pty install correction', () => {
  it('applies both authenticated inputs and verifies the exact result idempotently', async () => {
    const f = await fixture()
    expect(await applyNodePtyPatch(f.root)).toEqual({
      state: 'patched',
      version: '1.1.0',
    })
    expect(await f.hashesNow()).toEqual(f.pin.files.map((file) => file.patchedSha256))
    expect(await applyNodePtyPatch(f.root)).toEqual({
      state: 'verified',
      version: '1.1.0',
    })
  })
  it('fails unknown source and mixed original/patched input before writing', async () => {
    const f = await fixture()
    await applyNodePtyPatch(f.root)
    const target = join(f.packageRoot, f.pin.files[0]!.path)
    await writeFile(target, 'unknown source\n')
    const unknown = await f.hashesNow()
    await expect(applyNodePtyPatch(f.root)).rejects.toThrow(
      'unknown or mixed dependency source',
    )
    expect(await f.hashesNow()).toEqual(unknown)
    const other = await fixture()
    await cp(
      join(f.packageRoot, f.pin.files[1]!.path),
      join(other.packageRoot, f.pin.files[1]!.path),
    )
    const mixed = await other.hashesNow()
    await expect(applyNodePtyPatch(other.root)).rejects.toThrow(
      'unknown or mixed dependency source',
    )
    expect(await other.hashesNow()).toEqual(mixed)
  })
  it('rejects an unknown package version and lock identity without changing source', async () => {
    const f = await fixture(),
      original = await f.hashesNow()
    await writeFile(
      join(f.packageRoot, 'package.json'),
      JSON.stringify({ name: 'node-pty', version: '1.2.0' }),
    )
    await expect(applyNodePtyPatch(f.root)).rejects.toThrow(
      'dependency identity or lock mismatch',
    )
    expect(await f.hashesNow()).toEqual(original)
    const other = await fixture()
    const lock = JSON.parse(
      await readFile(join(other.root, 'package-lock.json'), 'utf8'),
    ) as { packages: Record<string, { integrity?: string }> }
    lock.packages['node_modules/node-pty']!.integrity = 'sha512-wrong'
    await writeFile(join(other.root, 'package-lock.json'), JSON.stringify(lock))
    await expect(applyNodePtyPatch(other.root)).rejects.toThrow(
      'dependency identity or lock mismatch',
    )
    expect(await other.hashesNow()).toEqual(original)
  })
  it('rejects a changed patch before mutation through the actual CLI', async () => {
    const f = await fixture(),
      original = await f.hashesNow()
    const tools = join(f.root, 'scripts/node-pty')
    await mkdir(tools, { recursive: true })
    for (const file of ['apply.mjs', 'pin.json', 'exit-drain.patch.txt'])
      await cp(join(patchRoot, file), join(tools, file))
    await writeFile(join(tools, 'exit-drain.patch.txt'), 'changed patch\n')
    await expect(execute(process.execPath, [join(tools, 'apply.mjs')])).rejects.toThrow(
      'patch digest mismatch',
    )
    expect(await f.hashesNow()).toEqual(original)
  })
  it('refuses a linked input instead of editing an external source tree', async () => {
    const f = await fixture()
    const target = join(f.packageRoot, f.pin.files[0]!.path),
      external = join(f.root, 'external.ts')
    const bytes = await readFile(target)
    await writeFile(external, bytes)
    await rm(target)
    await symlink(resolve(external), target)
    await expect(applyNodePtyPatch(f.root)).rejects.toThrow('linked input')
    expect(await readFile(external)).toEqual(bytes)
  })
})
