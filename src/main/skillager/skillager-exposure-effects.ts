import {
  SKILLAGER_EXPOSURE_MAX_EFFECTS,
  type SkillagerExposureEffect,
  type SkillagerExposureEntry,
} from '../../shared/skillager-exposure'
import { SkillagerError } from './skillager-port'

export const EXPOSURE_SIDECAR = 'skillager.materialized.yaml'
const GENERATED = {
  materialized_at: 'UTC installation time',
  materialized_fingerprint: 'advisory fingerprint of installed file metadata',
  materialized_sidecar_hash: 'integrity hash of the complete generated sidecar',
}
const METADATA_KEYS = new Set([
  'schema',
  'projection_kind',
  'projection_identity',
  'id',
  'source_id',
  'source_type',
  'source_package',
  'source_entrypoint',
  'source_hash',
  'materialized_hash',
  'materialized_target_hash',
  'source_trust',
  'agent',
  'scope',
  'source_library_id',
  'exposure_blocked_hashes',
])

export function exposureObject(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value))
    return malformedExposure()
  return value as Record<string, unknown>
}
export function exposureText(value: unknown, max = 16_384): string {
  if (typeof value !== 'string' || !value || value.length > max || /[\0\r\n]/.test(value))
    return malformedExposure()
  return value
}
export function exposureHash(value: unknown): string {
  const hash = exposureText(value, 64)
  if (!/^[a-f0-9]{64}$/.test(hash)) return malformedExposure()
  return hash
}
export function exposureMode(value: unknown): number {
  if (!Number.isInteger(value) || Number(value) < 0 || Number(value) > 0o7777)
    return malformedExposure()
  return Number(value)
}
function natural(value: unknown): number {
  if (!Number.isSafeInteger(value) || Number(value) < 0) return malformedExposure()
  return Number(value)
}

export function parseExposureEffects(
  value: unknown,
  removing: boolean,
): readonly SkillagerExposureEffect[] {
  if (!Array.isArray(value) || !value.length) return malformedExposure()
  if (value.length > SKILLAGER_EXPOSURE_MAX_EFFECTS)
    throw new SkillagerError(
      'output-limit',
      'This complete preview has too many file effects to review in hvir.',
    )
  const effects = value.map((raw): SkillagerExposureEffect => {
    const item = exposureObject(raw)
    const path = exposureText(item.path, 4096)
    if (
      path.includes('\\') ||
      path.split('/').some((part) => !part || part === '.' || part === '..')
    )
      return malformedExposure()
    const before = item.before === null ? null : entry(item.before, false)
    const after =
      item.after === null ? null : entry(item.after, path === EXPOSURE_SIDECAR)
    const action = before === null ? 'create' : after === null ? 'remove' : 'replace'
    if (
      (!before && !after) ||
      item.action !== action ||
      (removing && action !== 'remove')
    )
      return malformedExposure()
    return { path, action, before, after }
  })
  const byPath = new Map(effects.map((effect) => [effect.path, effect]))
  if (byPath.size !== effects.length) return malformedExposure()
  for (const effect of effects) {
    const parts = effect.path.split('/')
    for (let length = 1; length < parts.length; length++) {
      const parent = byPath.get(parts.slice(0, length).join('/'))
      for (const side of ['before', 'after'] as const)
        if (effect[side] && parent?.[side]?.type !== 'directory')
          return malformedExposure()
    }
  }
  const side = removing ? 'before' : 'after'
  if (
    byPath.get('SKILL.md')?.[side]?.type !== 'file' ||
    byPath.get(EXPOSURE_SIDECAR)?.[side]?.type !== 'file'
  )
    return malformedExposure()
  if (!removing && !byPath.get(EXPOSURE_SIDECAR)?.after?.metadata)
    return malformedExposure()
  return effects
}

function entry(value: unknown, metadataAllowed: boolean): SkillagerExposureEntry {
  const data = exposureObject(value),
    mode = exposureMode(data.mode)
  switch (data.type) {
    case 'directory':
      return { type: 'directory', mode }
    case 'symlink':
      return { type: 'symlink', mode, linkTarget: exposureText(data.link_target) }
    case 'special':
      return { type: 'special', mode, device: natural(data.device) }
    case 'file': {
      if (data.metadata !== undefined) {
        if (!metadataAllowed) return malformedExposure()
        const metadata = exposureObject(data.metadata),
          generated = exposureObject(data.generated_fields)
        if (
          Object.keys(metadata).some((key) => !METADATA_KEYS.has(key)) ||
          Object.keys(generated).length !== Object.keys(GENERATED).length ||
          Object.entries(GENERATED).some(([key, policy]) => generated[key] !== policy)
        )
          return unsupportedExposure()
        for (const [key, item] of Object.entries(metadata)) {
          if (key === 'exposure_blocked_hashes') {
            if (!Array.isArray(item) || item.length > 512) return malformedExposure()
            item.forEach(exposureHash)
          } else if (item !== null) exposureText(item)
        }
        return {
          type: 'file',
          mode,
          metadata: JSON.stringify(metadata, null, 2),
          generatedFields: Object.entries(GENERATED).map(
            ([key, policy]) => `${key}: ${policy}`,
          ),
        }
      }
      return {
        type: 'file',
        mode,
        size: natural(data.size),
        sha256: exposureHash(data.sha256),
      }
    }
    default:
      return malformedExposure()
  }
}
export function malformedExposure(): never {
  throw new SkillagerError(
    'malformed-result',
    'Skillager returned an invalid or incomplete exposure preview. No confirmation is available.',
  )
}
export function unsupportedExposure(): never {
  throw new SkillagerError(
    'unsupported',
    'This Skillager installation does not support the complete, bound preview required for this action. Update Skillager in your local terminal, then check again.',
  )
}
