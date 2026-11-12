import { mkdir, readFile } from 'node:fs/promises'
import { resolve, join } from 'node:path'
import { digest, pin } from './artifacts.mts'
import { execute, extract } from './source.mts'
// Inspect a selected immutable commit. Never rewrite accepted pins or publish a candidate.
const [commit, requested] = process.argv.slice(2)
if (!commit || !/^[a-f0-9]{40}$/.test(commit) || !requested || process.argv.length !== 4)
  throw new Error('Usage: native:upgrade -- FULL_COMMIT NEW_DIRECTORY')
const directory = resolve(requested)
await mkdir(directory)
const url = `https://codeload.github.com/ghostty-org/ghostty/tar.gz/${commit}`
const archive = join(directory, 'source.tar.gz')
await execute('curl', [
  '--fail',
  '--location',
  '--proto',
  '=https',
  '--tlsv1.2',
  '--max-time',
  '120',
  '--max-filesize',
  '268435456',
  '--output',
  archive,
  url,
])
const sha256 = await digest(archive),
  source = join(directory, 'source')
await extract(archive, source)
const zon = await readFile(join(source, 'build.zig.zon'), 'utf8')
console.log(
  JSON.stringify(
    {
      commit,
      url,
      sha256,
      applicationVersion: zon.match(/\.version = "([^"]+)"/)?.[1],
      minimumZig: zon.match(/\.minimum_zig_version = "([^"]+)"/)?.[1],
      previous: pin.source.commit,
      dependencyInventorySha256: await digest(join(source, 'deps/packages.json')),
    },
    null,
    2,
  ),
)
console.log(
  'Review the full-renderer source, VT release, dependency changes, notices, and every patch. Update pin.json only through a reviewed source change, then rebuild all targets and re-run loader acceptance.',
)
