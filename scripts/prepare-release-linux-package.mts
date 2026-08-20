import { createHash } from 'node:crypto'
import { readFile, readdir, rename } from 'node:fs/promises'
import { join } from 'node:path'

const [releaseArch, debArch] = process.argv.slice(2)

if (!['x64', 'arm64'].includes(releaseArch ?? '')) {
  throw new Error('Release architecture must be x64 or arm64')
}
if (!['amd64', 'arm64'].includes(debArch ?? '')) {
  throw new Error('Debian architecture must be amd64 or arm64')
}

const metadata = JSON.parse(await readFile('package.json', 'utf8')) as {
  version?: unknown
}
if (typeof metadata.version !== 'string' || metadata.version.length === 0) {
  throw new Error('package.json must contain a version')
}

const publicName = `hvir-${metadata.version}-linux-${releaseArch}.deb`
const sidecarName = `${publicName}.sha256`
const expectedNames = [publicName, sidecarName].sort()
const actualNames = (await readdir('dist', { withFileTypes: true }))
  .filter((entry) => entry.isFile())
  .map((entry) => entry.name)
  .sort()

if (actualNames.join('\n') !== expectedNames.join('\n')) {
  throw new Error(
    `Accepted package evidence must contain exactly ${expectedNames.join(', ')}`,
  )
}

const sidecar = await readFile(join('dist', sidecarName), 'utf8')
const match = /^([0-9a-f]{64}) {2}([^\n]+)\n?$/.exec(sidecar)
if (!match || match[2] !== publicName) {
  throw new Error(`Invalid digest sidecar for ${publicName}`)
}
const digest = createHash('sha256')
  .update(await readFile(join('dist', publicName)))
  .digest('hex')
if (digest !== match[1]) {
  throw new Error(`Digest mismatch for ${publicName}`)
}

await rename(
  join('dist', publicName),
  join('dist', `hvir_${metadata.version}_${debArch}.deb`),
)
