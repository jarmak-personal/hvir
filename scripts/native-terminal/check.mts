import { join, resolve } from 'node:path'
import { pin, repository, verifyArtifact } from './artifacts.mts'
import { execute } from './source.mts'
const [target, requested, development] = process.argv.slice(2)
if (
  !target ||
  !requested ||
  (development !== undefined && development !== '--development')
)
  throw new Error('Usage: native:check -- TARGET ARTIFACT [--development]')
const selected = pin.targets[target]
if (!selected || selected.platform !== process.platform || selected.arch !== process.arch)
  throw new Error('native-loader: matching target required')
const directory = resolve(requested)
const manifest = await verifyArtifact(directory, target, development === '--development')
const source = (
  await execute('git', ['rev-parse', 'HEAD'], { cwd: repository })
).stdout.trim()
if (development !== '--development' && manifest.source !== source)
  throw new Error('native-artifact: selected source mismatch')
const result = await execute(
  join(directory, 'loader-probe'),
  [join(directory, selected.library), pin.source.applicationVersion],
  { timeout: 30_000, maxBuffer: 4096 },
)
if (result.stdout.trim() !== 'HVIR_NATIVE_LOADER_OK')
  throw new Error('native-loader: unexpected result')
console.log(`HVIR_NATIVE_ARTIFACT_OK ${target}`)
