import { mkdtemp, mkdir, readFile, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { relocateNativePackageInputs } from '../scripts/native-terminal/relocate-package-inputs.mts'

const owned: string[] = []
afterEach(async () => {
  await Promise.all(
    owned.splice(0).map((path) => rm(path, { recursive: true, force: true })),
  )
})
async function fixture() {
  const parent = await mkdtemp(join(tmpdir(), 'hvir-native-input-relocation-'))
  owned.push(parent)
  const root = join(parent, 'checkout'),
    destination = join(parent, 'relocated')
  await mkdir(root)
  for (const path of [
    'src/main/index.ts',
    'src/renderer/app.ts',
    'src/agent-cli/index.ts',
    'src/agent-transport/transport.ts',
    'out/main/index.js',
    'out/preload/index.js',
    'out/renderer/index.html',
    'out/native-download/sdk.tar.gz',
    'dist/linux-unpacked/hvir',
    'dist/linux-arm64-unpacked/hvir',
    'packages/native-terminal/engine.js',
    'src/shared/native-terminal-package.ts',
    'scripts/installed-startup-probe.mts',
  ]) {
    const file = join(root, path)
    await mkdir(dirname(file), { recursive: true })
    await writeFile(file, path)
  }
  return { root, destination }
}
describe('installed native candidate developer input relocation', () => {
  it('makes fixed application roots unavailable at original paths while retaining shared/tool support', async () => {
    const f = await fixture()
    const receipt = await relocateNativePackageInputs(f.root, f.destination)
    expect(receipt.nativeDeveloperInputs).toBe('unavailable-at-original-paths')
    for (const { path, disposition } of receipt.roots) {
      await expect(stat(join(f.root, path))).rejects.toMatchObject({ code: 'ENOENT' })
      if (disposition === 'moved')
        expect((await stat(join(f.destination, path))).isDirectory()).toBe(true)
    }
    expect(await readFile(join(f.destination, 'out/main/index.js'), 'utf8')).toBe(
      'out/main/index.js',
    )
    for (const directory of ['linux-unpacked', 'linux-arm64-unpacked'])
      expect(await readFile(join(f.destination, 'dist', directory, 'hvir'), 'utf8')).toBe(
        `dist/${directory}/hvir`,
      )
    expect(
      await readFile(join(f.root, 'src/shared/native-terminal-package.ts'), 'utf8'),
    ).toBe('src/shared/native-terminal-package.ts')
    expect(
      await readFile(join(f.root, 'scripts/installed-startup-probe.mts'), 'utf8'),
    ).toBe('scripts/installed-startup-probe.mts')
  })
  it('refuses an internal destination before moving any application input', async () => {
    const f = await fixture()
    await expect(
      relocateNativePackageInputs(f.root, join(f.root, 'relocated')),
    ).rejects.toThrow('outside the checkout')
    expect(await readFile(join(f.root, 'src/main/index.ts'), 'utf8')).toBe(
      'src/main/index.ts',
    )
  })
})
