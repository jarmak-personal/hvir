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
// Re-execute the maintained selection oracle on every matching-host check.
const selection = await execute(
  join(directory, 'selection-probe'),
  [join(directory, selected.library)],
  { timeout: 60_000, maxBuffer: 4096 },
)
const proof = JSON.parse(selection.stdout) as {
  kind?: unknown
  passed?: unknown
  mutationCases?: unknown
  sourceCases?: unknown
  linkCandidateCases?: unknown
  autoscrollCases?: unknown
  largeCopyBytes?: unknown
  largeCopyChunks?: unknown
  cleanupChecked?: unknown
}
if (
  proof.kind !== 'native-selection' ||
  proof.passed !== true ||
  typeof proof.mutationCases !== 'number' ||
  proof.mutationCases < 18 ||
  typeof proof.sourceCases !== 'number' ||
  proof.sourceCases < 5 ||
  typeof proof.linkCandidateCases !== 'number' ||
  proof.linkCandidateCases < 6 ||
  typeof proof.autoscrollCases !== 'number' ||
  proof.autoscrollCases < 2 ||
  typeof proof.largeCopyBytes !== 'number' ||
  !Number.isSafeInteger(proof.largeCopyBytes) ||
  proof.largeCopyBytes <= 1024 * 1024 ||
  typeof proof.largeCopyChunks !== 'number' ||
  !Number.isSafeInteger(proof.largeCopyChunks) ||
  proof.largeCopyChunks < 2 ||
  proof.cleanupChecked !== true
)
  throw new Error('native-selection: incomplete check')
console.log(selection.stdout.trim())
console.log(`HVIR_NATIVE_ARTIFACT_OK ${target}`)
