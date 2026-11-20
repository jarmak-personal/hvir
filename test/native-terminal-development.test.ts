import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  mkdir,
  mkdtemp,
  readFile,
  realpath,
  rm,
  symlink,
  writeFile,
} from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import {
  developmentInputIdentity,
  developmentReceipt,
  developmentRoot,
  developmentTarget,
  readDevelopmentRuntime,
  type DevelopmentRuntimeReceipt,
} from '../scripts/native-terminal/development-runtime.mts'
import { developmentLaunchArguments } from '../scripts/native-terminal/dev.mts'
import {
  digest,
  pin,
  type NativeArtifact,
} from '../scripts/native-terminal/artifacts.mts'

let root: string
const target = 'linux-x64'
const artifact = `${developmentRoot}/attempt-test/artifact`
const bindingPath = 'packages/native-terminal/build/Release/bindings.json'
const source = 'a'.repeat(40)
let receipt: DevelopmentRuntimeReceipt
const sdk = { source, pinSha256: 'b'.repeat(64) } as NativeArtifact
const verify = vi.fn(() => Promise.resolve(sdk))
async function file(path: string, bytes: string) {
  await mkdir(dirname(join(root, path)), { recursive: true })
  await writeFile(join(root, path), bytes)
}
async function json(path: string, value: unknown) {
  await file(path, JSON.stringify(value))
}
async function publishReceipt() {
  await json(developmentReceipt, receipt)
}
async function editBinding(edit: (value: { producer: { embedAbi: number } }) => void) {
  const binding = JSON.parse(await readFile(join(root, bindingPath), 'utf8')) as {
    producer: { embedAbi: number }
  }
  edit(binding)
  await json(bindingPath, binding)
  receipt.bindingsSha256 = await digest(join(root, bindingPath))
  await publishReceipt()
}
beforeEach(async () => {
  root = await realpath(await mkdtemp(join(tmpdir(), 'hvir-native-development-')))
  await file('packages/native-terminal/terminal.c', 'source')
  await json('scripts/native-terminal/bindings-pin.json', {
    electron: { version: '43.8.1' },
  })
  await json('node_modules/electron/package.json', { version: '43.8.1' })
  await mkdir(join(root, 'node_modules/@hvir'), { recursive: true })
  await symlink(
    join(root, 'packages/native-terminal'),
    join(root, 'node_modules/@hvir/native-terminal'),
  )
  await json(`${artifact}/manifest.json`, { source })
  await file(`${artifact}/ghostty-internal.so`, 'native library')
  const outputs = []
  for (const name of [
    'native_terminal_engine.node',
    'native_terminal_resource.node',
    'resource-probe',
  ]) {
    const path = `packages/native-terminal/build/Release/${name}`
    await file(path, 'binding')
    outputs.push({ file: name, bytes: 7, sha256: await digest(join(root, path)) })
  }
  await json(bindingPath, {
    schema: 1,
    source,
    target,
    development: true,
    producer: {
      source,
      target,
      pinSha256: sdk.pinSha256,
      embedAbi: pin.source.embedAbi,
      manifestSha256: await digest(join(root, artifact, 'manifest.json')),
    },
    outputs,
  })
  receipt = {
    schema: 1,
    target,
    artifact,
    inputSha256: await developmentInputIdentity(root, target),
    manifestSha256: await digest(join(root, artifact, 'manifest.json')),
    bindingsSha256: await digest(join(root, bindingPath)),
  }
  await publishReceipt()
  verify.mockClear()
})
afterEach(async () => {
  await rm(root, { recursive: true, force: true })
  vi.restoreAllMocks()
})

describe('prepared native development runtime', () => {
  it('reuses matching prepared bytes across unrelated source changes without changing producer provenance', async () => {
    await file('README.md', 'unrelated application/documentation change')
    const ready = await readDevelopmentRuntime(root, target, verify)
    expect(ready.library).toBe(join(root, artifact, 'ghostty-internal.so'))
    expect(verify).toHaveBeenCalledWith(join(root, artifact), target, true)
    expect(
      (
        JSON.parse(await readFile(join(root, bindingPath), 'utf8')) as {
          producer: { source: string }
        }
      ).producer.source,
    ).toBe(source)
  })
  it.each([
    'packages/native-terminal/terminal.c',
    'scripts/native-terminal/patches/changed.patch.txt',
    'scripts/native-terminal/pin.json',
  ])('requires preparation after native input changes: %s', async (path) => {
    await file(path, 'changed native source')
    await expect(readDevelopmentRuntime(root, target, verify)).rejects.toThrow(
      'Run npm ci',
    )
  })
  it('ignores disposable build output when identifying source inputs', async () => {
    await file('packages/native-terminal/build/unrelated-output', 'output')
    expect((await readDevelopmentRuntime(root, target, verify)).receipt.inputSha256).toBe(
      receipt.inputSha256,
    )
  })
  it('refuses missing setup with a repair instruction', async () => {
    await rm(join(root, developmentReceipt))
    await expect(readDevelopmentRuntime(root, target, verify)).rejects.toThrow(
      'npm run native:prepare',
    )
  })
  it('refuses an installed Electron version that differs from the header pin', async () => {
    await json('node_modules/electron/package.json', { version: '44.0.0' })
    await expect(readDevelopmentRuntime(root, target, verify)).rejects.toThrow(
      'incompatible',
    )
  })
  it('refuses a different target', async () => {
    await expect(readDevelopmentRuntime(root, 'linux-arm64', verify)).rejects.toThrow(
      'incompatible',
    )
  })
  it('refuses changed SDK bytes and delegates SDK ABI/pin validation to its existing verifier', async () => {
    await file(`${artifact}/manifest.json`, 'changed SDK')
    await expect(readDevelopmentRuntime(root, target, verify)).rejects.toThrow(
      'incompatible',
    )
    expect(verify).not.toHaveBeenCalled()
    await json(`${artifact}/manifest.json`, { source })
    const rejectingVerifier = vi.fn(() =>
      Promise.reject(new Error('native-artifact: identity mismatch')),
    )
    await expect(readDevelopmentRuntime(root, target, rejectingVerifier)).rejects.toThrow(
      'incompatible',
    )
  })
  it.each(['native_terminal_engine.node', 'native_terminal_resource.node'])(
    'refuses corrupt or missing %s before launch',
    async (name) => {
      await file(`packages/native-terminal/build/Release/${name}`, 'corrupt')
      await expect(readDevelopmentRuntime(root, target, verify)).rejects.toThrow(
        'incompatible',
      )
      await rm(join(root, 'packages/native-terminal/build/Release', name))
      await expect(readDevelopmentRuntime(root, target, verify)).rejects.toThrow(
        'incompatible',
      )
    },
  )
  it('refuses bindings built for a different producer ABI', async () => {
    await editBinding((binding) => {
      binding.producer.embedAbi--
    })
    await expect(readDevelopmentRuntime(root, target, verify)).rejects.toThrow(
      'incompatible',
    )
  })
  it('refuses a receipt escaping the development output directory', async () => {
    receipt.artifact = `${developmentRoot}/attempt-test/../../../../../../artifact`
    await publishReceipt()
    await expect(readDevelopmentRuntime(root, target, verify)).rejects.toThrow(
      'incompatible',
    )
  })
  it('refuses symlinked library bytes', async () => {
    await rm(join(root, artifact, 'ghostty-internal.so'))
    await symlink(
      join(root, 'packages/native-terminal/terminal.c'),
      join(root, artifact, 'ghostty-internal.so'),
    )
    await expect(readDevelopmentRuntime(root, target, verify)).rejects.toThrow(
      'incompatible',
    )
  })
  it('only supports the pinned build targets', () => {
    expect(developmentTarget('darwin', 'arm64')).toBe('macos-arm64')
    expect(developmentTarget('linux', 'x64')).toBe('linux-x64')
    expect(() => developmentTarget('win32', 'x64')).toThrow('dev:legacy')
  })
})

describe('native development desktop launch', () => {
  it('preserves Electron argument forwarding', () => {
    const env = { XDG_SESSION_TYPE: 'wayland' }
    const args = developmentLaunchArguments(
      ['--', '--user-data-dir=/tmp/profile'],
      env,
      'linux',
    )
    expect(args).toEqual([
      'dev',
      '--',
      '--user-data-dir=/tmp/profile',
      '--ozone-platform=wayland',
    ])
    expect(env).toHaveProperty('HVIR_NATIVE_TERMINAL_OZONE', 'wayland')
  })
  it('does not override an explicit Electron backend selection', () => {
    const env = { HVIR_NATIVE_TERMINAL_OZONE: 'x11', XDG_SESSION_TYPE: 'wayland' }
    expect(
      developmentLaunchArguments(['--', '--ozone-platform=x11'], env, 'linux'),
    ).toEqual(['dev', '--', '--ozone-platform=x11'])
  })
  it('does not invent a backend for macOS or unknown Linux sessions', () => {
    expect(developmentLaunchArguments([], {}, 'linux')).toEqual(['dev'])
    expect(developmentLaunchArguments([], { XDG_SESSION_TYPE: 'x11' }, 'darwin')).toEqual(
      ['dev'],
    )
  })
})
