import { cp, mkdir, readFile } from 'node:fs/promises'
import { resolve, join } from 'node:path'
import { digest, pin } from './artifacts.mts'
import { downloadArchive, extract, patchSource } from './source.mts'
// Inspect a selected immutable commit. Never rewrite accepted pins or publish a candidate.
const [commit, requested] = process.argv.slice(2)
if (!commit || !/^[a-f0-9]{40}$/.test(commit) || !requested || process.argv.length !== 4)
  throw new Error('Usage: native:upgrade -- FULL_COMMIT NEW_DIRECTORY')
const directory = resolve(requested)
await mkdir(directory)
const url = `https://codeload.github.com/ghostty-org/ghostty/tar.gz/${commit}`
const archive = join(directory, 'source.tar.gz')
const sha256 = await downloadArchive(url, archive),
  source = join(directory, 'source')
await extract(archive, source)
const zon = await readFile(join(source, 'build.zig.zon'), 'utf8')
const libraryVersion = await readFile(join(source, 'LIB_VERSION'), 'utf8').then(
  (s) => s.trim(),
  () => undefined,
)
const vtVersion =
  commit === pin.source.commit && sha256 === pin.source.sha256
    ? { state: 'known', value: pin.source.vtVersion, basis: 'accepted source pin' }
    : libraryVersion && /^\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?$/.test(libraryVersion)
      ? { state: 'known', value: libraryVersion, basis: 'source LIB_VERSION' }
      : {
          state: 'requires-selection',
          value: null,
          basis: 'No source-backed VT release identity; select explicitly during review',
        }
const dependencyInventories: Record<string, string> = {}
for (const file of Object.keys(pin.dependencies))
  dependencyInventories[file] = await digest(join(source, 'deps', file))
// Apply each successful patch only to this owned trial, so later patches see their prerequisites.
const trial = join(directory, 'patch-trial')
await cp(source, trial, { recursive: true })
const patches = await patchSource(trial, true)
console.log(
  JSON.stringify(
    {
      commit,
      url,
      sha256,
      applicationVersion: zon.match(/\.version = "([^"]+)"/)?.[1] ?? null,
      minimumZig: zon.match(/\.minimum_zig_version = "([^"]+)"/)?.[1] ?? null,
      vtVersion,
      previous: pin.source.commit,
      dependencyInventories,
      patches,
    },
    null,
    2,
  ),
)
console.log(
  'Review the full-renderer source, explicit VT release, dependency changes, notices, and ordered patch results. Update pin.json only through a reviewed source change, then rebuild all targets and re-run loader acceptance.',
)
if (patches.some((p) => p.result !== 'applied')) process.exitCode = 1
