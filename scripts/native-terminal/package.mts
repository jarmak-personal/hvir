import { chmod, cp, mkdir } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { digest, pin, repository, verifyArtifact } from './artifacts.mts'
import { execute } from './source.mts'
import {
  captureNativeTerminalPackage,
  readPackageJson,
  type BindingManifest,
} from './package-artifacts.mts'
import { NATIVE_TERMINAL_BINDING_FILES } from '../../src/shared/native-terminal-package.ts'

const [target, input, output, ...extra] = process.argv.slice(2)
if (!target || !pin.targets[target] || !input || !output || extra.length)
  throw new Error('Usage: package.mts TARGET EXACT_SDK_ARTIFACT NEW_OUTPUT')
const selected = pin.targets[target]
if (process.platform !== selected.platform || process.arch !== selected.arch)
  throw new Error('native-package: matching native host required')
const sdk = resolve(input),
  root = resolve(output)
const manifest = await verifyArtifact(sdk, target)
const source = (
  await execute('git', ['rev-parse', 'HEAD'], { cwd: repository })
).stdout.trim()
if (
  manifest.source !== source ||
  (
    await execute('git', ['status', '--porcelain', '--untracked-files=normal'], {
      cwd: repository,
    })
  ).stdout.trim()
)
  throw new Error('native-package: exact clean source required')
const bindings = join(repository, 'packages/native-terminal/build/Release')
const binding = (await readPackageJson(
  join(bindings, 'bindings.json'),
)) as BindingManifest
if (binding.producer?.manifestSha256 !== (await digest(join(sdk, 'manifest.json'))))
  throw new Error('native-package: exact SDK binding required')
await mkdir(root) // A fresh output retains failed attempts and refuses stale payloads.
await cp(join(sdk, selected.library), join(root, selected.library))
await chmod(join(root, selected.library), 0o755)
await cp(join(sdk, 'notices'), join(root, 'notices'), { recursive: true })
await cp(join(sdk, 'manifest.json'), join(root, 'sdk-manifest.json'))
await cp(join(bindings, 'bindings.json'), join(root, 'bindings.json'))
for (const file of Object.values(NATIVE_TERMINAL_BINDING_FILES))
  await chmod(join(bindings, file), 0o755)
await captureNativeTerminalPackage(root, bindings, source, target)
console.log(
  JSON.stringify({
    nativePackagePrepared: true,
    source,
    target,
    embedAbi: manifest.embedAbi,
  }),
)
