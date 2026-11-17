import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  mkdtemp,
  mkdir,
  readFile,
  realpath,
  rename,
  rm,
  symlink,
  writeFile,
} from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createHash } from 'node:crypto'
import { createRequire } from 'node:module'
import { verifyPackagedNativeTerminal } from '../src/main/terminal/native-terminal-package'
import pin from '../scripts/native-terminal/pin.json'
import {
  NATIVE_TERMINAL_PACKAGE_ABI,
  NATIVE_TERMINAL_PACKAGE_VERSION,
  NATIVE_TERMINAL_PACKAGE_VT_VERSION,
} from '../src/shared/native-terminal-package'
import {
  captureNativeTerminalPackage,
  inspectNativeTerminalPackage,
} from '../scripts/native-terminal/package-artifacts.mts'

let resources: string, root: string, bindings: string
const source = 'a'.repeat(40)
const digest = (value: string) => createHash('sha256').update(value).digest('hex')
async function json(path: string, value: unknown) {
  await writeFile(path, JSON.stringify(value))
}
beforeEach(async () => {
  resources = await realpath(await mkdtemp(join(tmpdir(), 'hvir-native-package-')))
  root = join(resources, 'native-terminal')
  bindings = join(
    resources,
    'app.asar.unpacked/node_modules/@hvir/native-terminal/build/Release',
  )
  await mkdir(root)
  await mkdir(bindings, { recursive: true })
  await mkdir(join(root, 'notices'))
  await writeFile(join(root, 'ghostty-internal.so'), 'library')
  await writeFile(join(root, 'notices/LICENSE'), 'notice')
  await writeFile(join(bindings, 'native_terminal_engine.node'), 'engine')
  await writeFile(join(bindings, 'native_terminal_resource.node'), 'resource')
  const sdk = {
    schema: 1,
    source,
    target: 'linux-x64',
    pinSha256: 'b'.repeat(64),
    embedAbi: 11,
    applicationVersion: '1.4.1-dev',
    vtVersion: '1.0.1',
    build: {
      development: false,
      dependencyIsolation: { policy: 'linux-local-bundled-definitions' },
    },
    files: [
      { path: 'ghostty-internal.so', sha256: digest('library'), bytes: 7 },
      { path: 'notices/LICENSE', sha256: digest('notice'), bytes: 6 },
    ],
  }
  await json(join(root, 'sdk-manifest.json'), sdk)
  await json(join(root, 'bindings.json'), {
    schema: 1,
    source,
    target: 'linux-x64',
    development: false,
    producer: {
      source,
      target: 'linux-x64',
      pinSha256: sdk.pinSha256,
      embedAbi: 11,
      manifestSha256: digest(JSON.stringify(sdk)),
    },
    outputs: ['engine', 'resource'].map((name) => ({
      file: `native_terminal_${name}.node`,
      sha256: digest(name),
      bytes: name.length,
    })),
  })
  await captureNativeTerminalPackage(root, bindings, source, 'linux-x64')
})
afterEach(async () => {
  vi.unstubAllEnvs()
  await rm(resources, { recursive: true, force: true })
})

describe('trusted installed native code', () => {
  it('keeps the runtime ABI and native versions tied to the authoritative SDK pin', () => {
    expect(NATIVE_TERMINAL_PACKAGE_ABI).toBe(pin.source.embedAbi)
    expect(NATIVE_TERMINAL_PACKAGE_VERSION).toBe(pin.source.applicationVersion)
    expect(NATIVE_TERMINAL_PACKAGE_VT_VERSION).toBe(pin.source.vtVersion)
  })
  it.each(['packages/native-terminal', 'node_modules/@hvir/native-terminal'])(
    'refuses unmanifested bindings from a non-opt-in %s package',
    async (directory) => {
      vi.stubEnv('HVIR_PACKAGE_NATIVE_TERMINAL', '')
      const project = join(resources, 'contributor')
      const output = join(project, directory, 'build/Release')
      await mkdir(output, { recursive: true })
      const require = createRequire(import.meta.url)
      const prepare =
        require('../build/native/prepare-native-terminal.cjs') as (context: {
          packager: { projectDir: string }
        }) => Promise<void>
      await expect(
        prepare({ packager: { projectDir: project } }),
      ).resolves.toBeUndefined()
      await writeFile(join(output, 'native_terminal_engine.node'), 'unmanifested')
      await expect(prepare({ packager: { projectDir: project } })).rejects.toThrow(
        'Native package bindings require explicit candidate selection',
      )
    },
  )
  it('verifies relocated bundled native code without the developer source or SDK', async () => {
    expect(await verifyPackagedNativeTerminal(resources, 'linux', 'x64')).toBe(
      join(root, 'ghostty-internal.so'),
    )
    expect(await inspectNativeTerminalPackage(root, bindings, 'linux-x64')).toMatchObject(
      { source, embedAbi: 11, signed: false },
    )
  })
  it.each(['ghostty-internal.so', 'engine', 'resource'])(
    'rejects changed %s before any native loading',
    async (file) => {
      const path = file.endsWith('.so')
        ? join(root, file)
        : join(bindings, `native_terminal_${file}.node`)
      await writeFile(path, 'changed')
      await expect(
        verifyPackagedNativeTerminal(resources, 'linux', 'x64'),
      ).rejects.toThrow(/native-package-(integrity|file)/)
    },
  )
  it('rejects a library symlink even when its bytes match', async () => {
    const path = join(root, 'ghostty-internal.so')
    await rm(path)
    await writeFile(join(resources, 'outside.so'), 'library')
    await symlink('../outside.so', path)
    await expect(verifyPackagedNativeTerminal(resources, 'linux', 'x64')).rejects.toThrow(
      'native-package-file',
    )
  })
  it.each([
    ['embedAbi', 10],
    ['target', 'linux-arm64'],
    ['applicationVersion', 'wrong'],
  ])('rejects wrong %s', async (key, value) => {
    const path = join(root, 'runtime.json')
    const manifest = JSON.parse(await readFile(path, 'utf8')) as Record<string, unknown>
    manifest[key] = value
    await json(path, manifest)
    await expect(verifyPackagedNativeTerminal(resources, 'linux', 'x64')).rejects.toThrow(
      'native-package-identity',
    )
  })
  it('refuses missing and oversized manifests with bounded stages', async () => {
    await writeFile(join(root, 'runtime.json'), ' '.repeat(16 * 1024 + 1))
    await expect(verifyPackagedNativeTerminal(resources, 'linux', 'x64')).rejects.toThrow(
      'native-package-manifest',
    )
    await rm(join(root, 'runtime.json'))
    await expect(verifyPackagedNativeTerminal(resources, 'linux', 'x64')).rejects.toThrow(
      'native-package-unavailable',
    )
  })
  it('keeps immutable receipts authoritative for build identity and notices', async () => {
    await writeFile(join(root, 'notices/LICENSE'), 'modified')
    await expect(
      inspectNativeTerminalPackage(root, bindings, 'linux-x64'),
    ).rejects.toThrow('native-package: notice integrity')
  })
  it('does not accept a changed unsigned binary by rewriting only its runtime receipt', async () => {
    await writeFile(join(bindings, 'native_terminal_engine.node'), 'changed')
    await expect(
      captureNativeTerminalPackage(root, bindings, source, 'linux-x64'),
    ).rejects.toThrow('native-package: native build bytes mismatch')
  })
  it('refuses signed-byte provenance on Linux', async () => {
    await expect(
      captureNativeTerminalPackage(root, bindings, source, 'linux-x64', true),
    ).rejects.toThrow('native-package: runtime identity mismatch')
  })
  it('signs macOS code first, retains original build receipts and binds final bytes', async () => {
    const sdkPath = join(root, 'sdk-manifest.json'),
      bindingPath = join(root, 'bindings.json')
    const sdk = JSON.parse(await readFile(sdkPath, 'utf8')) as {
      target: string
      files: { path: string }[]
    }
    sdk.target = 'macos-arm64'
    sdk.files[0]!.path = 'libghostty.dylib'
    await writeFile(join(root, 'libghostty.dylib'), 'library')
    await rm(join(root, 'ghostty-internal.so'))
    await json(sdkPath, sdk)
    const binding = JSON.parse(await readFile(bindingPath, 'utf8')) as {
      target: string
      producer: { target: string; manifestSha256: string }
    }
    binding.target = binding.producer.target = 'macos-arm64'
    binding.producer.manifestSha256 = digest(JSON.stringify(sdk))
    await json(bindingPath, binding)
    await captureNativeTerminalPackage(root, bindings, source, 'macos-arm64')
    const originalSdk = await readFile(sdkPath),
      originalBinding = await readFile(bindingPath)
    const signedApp = join(resources, 'signed.app')
    await mkdir(join(signedApp, 'Contents'), { recursive: true })
    const signedResources = join(signedApp, 'Contents/Resources')
    await mkdir(signedResources)
    await rename(root, join(signedResources, 'native-terminal'))
    await rename(
      join(resources, 'app.asar.unpacked'),
      join(signedResources, 'app.asar.unpacked'),
    )
    root = join(signedResources, 'native-terminal')
    bindings = join(
      signedResources,
      'app.asar.unpacked/node_modules/@hvir/native-terminal/build/Release',
    )
    const require = createRequire(import.meta.url)
    const { signNativeTerminal } =
      require('../build/native/sign-native-terminal.cjs') as {
        signNativeTerminal(
          this: void,
          options: { app: string; identity: string },
          execute: (command: string, args: string[]) => Promise<void>,
        ): Promise<Set<string>>
      }
    const signed = await signNativeTerminal(
      { app: signedApp, identity: 'test-identity' },
      async (_command, args) => {
        if (args.includes('--force')) {
          const path = args.at(-1)!
          await writeFile(
            path,
            Buffer.concat([await readFile(path), Buffer.from('-signed')]),
          )
        }
      },
    )
    expect(signed.size).toBe(3)
    const final = await inspectNativeTerminalPackage(root, bindings, 'macos-arm64')
    expect(final.signed).toBe(true)
    expect(final.files.library.buildSha256).toBe(digest('library'))
    expect(final.files.library.sha256).toBe(digest('library-signed'))
    expect(await readFile(join(root, 'sdk-manifest.json'))).toEqual(originalSdk)
    expect(await readFile(join(root, 'bindings.json'))).toEqual(originalBinding)
    await writeFile(join(root, 'libghostty.dylib'), 'later-resigned')
    await expect(
      inspectNativeTerminalPackage(root, bindings, 'macos-arm64'),
    ).rejects.toThrow('native-package: final bytes mismatch')
  })
})
