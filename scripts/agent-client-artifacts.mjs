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
async function captureAgentClients(directory, source, signed) {
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
  return manifest
}

export async function agentClientManifest(directory, source, signed = false) {
  const manifest = await captureAgentClients(directory, source, signed)
  await writeFile(
    join(directory, 'manifest.json'),
    JSON.stringify(manifest, null, 2) + '\n',
  )
  return manifest
}

/** Inspect final installed bytes without rewriting build or signing provenance. */
export async function inspectAgentClientManifest(directory) {
  const recorded = JSON.parse(await readFile(join(directory, 'manifest.json'), 'utf8'))
  const signed = recorded.clients?.['macos-x64']?.signed === true
  const observed = await captureAgentClients(directory, recorded.source, signed)
  if (
    recorded.contract !== observed.contract ||
    Object.keys(recorded.clients ?? {})
      .sort()
      .join(',') !== [...AGENT_CLIENT_TARGETS].sort().join(',')
  )
    throw new Error('Packaged remote client manifest is incomplete')
  for (const target of AGENT_CLIENT_TARGETS) {
    const actual = observed.clients[target],
      expected = recorded.clients[target]
    if (
      !expected ||
      actual.sha256 !== expected.sha256 ||
      actual.bytes !== expected.bytes ||
      actual.buildSha256 !== expected.buildSha256 ||
      actual.signed !== expected.signed
    )
      throw new Error(`Packaged remote client integrity is invalid for ${target}`)
  }
  return observed
}
