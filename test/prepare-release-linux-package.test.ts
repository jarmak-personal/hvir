import { createHash } from 'node:crypto'
import { mkdtemp, mkdir, readdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { spawnSync } from 'node:child_process'

import { afterEach, describe, expect, it } from 'vitest'

const roots: string[] = []
const script = fileURLToPath(
  new URL('../scripts/prepare-release-linux-package.mts', import.meta.url),
)

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true })))
})

describe('release Linux package preparation', () => {
  it('verifies the exact digest-bound artifact set and restores the Debian name', async () => {
    const root = await fixture()

    const result = run(root)

    expect(result.status).toBe(0)
    expect(await readdir(join(root, 'dist'))).toEqual([
      'hvir-1.2.3-linux-x64.deb.sha256',
      'hvir_1.2.3_amd64.deb',
    ])
  })

  it('fails closed for unexpected artifacts, digest changes, or an unbound name', async () => {
    const unexpected = await fixture()
    await writeFile(join(unexpected, 'dist', 'partial.deb'), 'partial')
    expect(run(unexpected)).toMatchObject({ status: 1 })

    const changed = await fixture()
    await writeFile(join(changed, 'dist', 'hvir-1.2.3-linux-x64.deb'), 'changed')
    expect(run(changed)).toMatchObject({ status: 1 })

    const unbound = await fixture({ sidecarName: 'other.deb' })
    expect(run(unbound)).toMatchObject({ status: 1 })
  })
})

async function fixture(options: { sidecarName?: string } = {}): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'hvir-release-linux-'))
  roots.push(root)
  const dist = join(root, 'dist')
  await mkdir(dist)
  await writeFile(join(root, 'package.json'), JSON.stringify({ version: '1.2.3' }))
  const name = 'hvir-1.2.3-linux-x64.deb'
  const contents = 'accepted-package'
  const digest = createHash('sha256').update(contents).digest('hex')
  await writeFile(join(dist, name), contents)
  await writeFile(
    join(dist, `${name}.sha256`),
    `${digest}  ${options.sidecarName ?? name}\n`,
  )
  return root
}

function run(root: string) {
  return spawnSync(process.execPath, [script, 'x64', 'amd64'], {
    cwd: root,
    encoding: 'utf8',
  })
}
