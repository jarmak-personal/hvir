import { readFile, writeFile } from 'node:fs/promises'
import { createHash } from 'node:crypto'
import { join } from 'node:path'

export const AGENT_CLIENT_TARGETS = [
  'linux-x64',
  'linux-arm64',
  'macos-x64',
  'macos-arm64',
]
/** Build provenance stays immutable; the runtime manifest hashes the final packaged bytes. */
export async function agentClientManifest(directory, source, signed = false) {
  if (!/^[a-f0-9]{40}$/.test(source))
    throw new Error('Remote client source must be an exact commit')
  const clients = {}
  for (const target of AGENT_CLIENT_TARGETS) {
    const path = join(directory, target),
      metadata = JSON.parse(await readFile(join(path, 'metadata.json'), 'utf8')),
      bytes = await readFile(join(path, 'hvir-agent'))
    const sha256 = createHash('sha256').update(bytes).digest('hex')
    if (
      metadata.contract !== '1.0' ||
      metadata.source !== source ||
      metadata.target !== target ||
      metadata.development !== false ||
      metadata.toolchain !== '1.99.0' ||
      bytes.length < 1 ||
      bytes.length > 16 * 1024 * 1024
    )
      throw new Error(`Remote client provenance is invalid for ${target}`)
    if (
      (!signed || !target.startsWith('macos')) &&
      (sha256 !== metadata.sha256 || bytes.length !== metadata.bytes)
    )
      throw new Error(`Remote client integrity is invalid for ${target}`)
    for (const notice of [
      'hvir-LICENSE',
      'musl-1.2.5-COPYRIGHT',
      'rust-1.99.0-COPYRIGHT-library.html',
    ])
      if (!(await readFile(join(path, 'notices', notice))).length)
        throw new Error(`Remote client notice is missing for ${target}`)
    clients[target] = {
      sha256,
      bytes: bytes.length,
      buildSha256: metadata.sha256,
      signed: signed && target.startsWith('macos'),
    }
  }
  const manifest = { contract: '1.0', source, clients }
  await writeFile(
    join(directory, 'manifest.json'),
    JSON.stringify(manifest, null, 2) + '\n',
  )
  return manifest
}
