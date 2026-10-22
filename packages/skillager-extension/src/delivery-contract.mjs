/* global TextEncoder */
import {
  absoluteLocalPath,
  boundedManagementJson,
  digest,
} from './management-contract.mjs'
import { metadataObject as object, metadataText as text } from './public-metadata.mjs'

export function deliveryDestination(workspace, id, agent) {
  if (
    !workspace?.root ||
    workspace.host === 'local' ||
    workspace.root.hostId !== workspace.host ||
    typeof workspace.id !== 'string'
  )
    throw new Error('Select the exact registered SSH workspace for Full delivery')
  if (
    !/^lib\/[a-z0-9][a-z0-9._-]{0,200}$/iu.test(id) ||
    !['codex', 'claude'].includes(agent)
  )
    throw new Error('Choose one canonical library skill and Codex or Claude')
  const root = absoluteLocalPath(workspace.root.path).path
  return {
    hostId: workspace.host,
    path: `${root === '/' ? '' : root}/${agent === 'codex' ? '.agents' : '.claude'}/skills/${id.slice(4)}`,
  }
}
export function exportedPayload(value, selected, library, agent, destination) {
  const data = object(boundedManagementJson(value))
  if (
    data.schema !== 'skillager.export.v1' ||
    data.status !== 'exported' ||
    data.id !== selected.id ||
    data.library_id !== library.id ||
    data.agent !== agent ||
    data.scope !== 'export' ||
    data.content_hash !== selected.hash ||
    data.destination !== destination.path ||
    !Array.isArray(data.files) ||
    !data.files.length ||
    data.files.length > 511
  )
    throw new Error(
      'Complete approved Full export differs from the selected library, version, agent or local export directory',
    )
  const paths = new Set()
  for (const entry of data.files) {
    const path = text(entry.path, 4096)
    if (
      path.startsWith('/') ||
      path.includes('\\') ||
      path.split('/').some((part) => !part || part === '.' || part === '..') ||
      paths.has(path) ||
      !Number.isSafeInteger(entry.mode) ||
      entry.mode < 0 ||
      entry.mode > 0o777 ||
      !Number.isSafeInteger(entry.size) ||
      entry.size < 0 ||
      entry.size > 2 * 1024 * 1024
    )
      throw new Error('Export file identity or ordinary permission mode is invalid')
    digest(entry.sha256)
    paths.add(path)
  }
  if (
    data.files.reduce((sum, entry) => sum + entry.size, 0) > 32 * 1024 * 1024 ||
    !paths.has('SKILL.md')
  )
    throw new Error('Complete Full export exceeds the delivery bound or lacks SKILL.md')
  return data.files
    .map(({ path, mode, size, sha256 }) => ({ path, mode, size, sha256 }))
    .sort((a, b) => a.path.localeCompare(b.path))
}
export function bindExportManifest(files, entries) {
  if (
    !Array.isArray(entries) ||
    !entries.some((entry) => entry.path === '' && entry.type === 'dir')
  )
    throw new Error('Complete captured tree is unavailable')
  const captured = entries
    .filter((entry) => entry.type === 'file')
    .map(({ path, mode, size, sha256 }) => ({ path, mode, size, sha256 }))
    .sort((a, b) => a.path.localeCompare(b.path))
  if (JSON.stringify(captured) !== JSON.stringify(files))
    throw new Error(
      'Captured bytes and modes differ from the complete approved public export',
    )
}
export function deliveryDomain(value) {
  if (value === null) return { schema: 'skillager.delivery-domain.v1', deliveries: [] }
  const domain = object(value)
  if (
    domain.schema !== 'skillager.delivery-domain.v1' ||
    !Array.isArray(domain.deliveries) ||
    domain.deliveries.length > 32
  )
    throw new Error(
      'Delivery domain records are unverifiable; retain remote files and inspect Settings recovery',
    )
  for (const entry of domain.deliveries) {
    text(entry.workspace, 256)
    text(entry.operation, 80)
    text(entry.libraryId, 80)
    text(entry.skillId, 256)
    digest(entry.version)
    if (
      !['codex', 'claude'].includes(entry.agent) ||
      !['managed', 'pinned'].includes(entry.policy) ||
      !['pending', 'settled'].includes(entry.state) ||
      typeof entry.target?.hostId !== 'string' ||
      typeof entry.target.path !== 'string'
    )
      throw new Error('Delivery domain identity is unverifiable')
  }
  return domain
}
export function deliveryMetadata(value, selected) {
  const skill = object(object(boundedManagementJson(value)).skill)
  if (
    skill.id !== selected.id ||
    skill.content_hash !== selected.hash ||
    !['trusted', 'reviewed', 'pinned'].includes(skill.trust)
  )
    throw new Error(
      'Known runtime metadata no longer describes the selected approved source',
    )
  const result = {
    compatibility: skill.compatibility ?? {},
    targets: skill.targets ?? {},
    activation: skill.activation ?? 'unknown',
    agentHint: skill.agent_hint ?? null,
  }
  if (new TextEncoder().encode(JSON.stringify(result)).length > 1024)
    throw new Error(
      'Known runtime requirements exceed the complete delivery disclosure bound',
    )
  return result
}
