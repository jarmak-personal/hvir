import { metadataObject as object, metadataText as text } from './public-metadata.mjs'
import { SkillagerSetupError } from './library-first-use.mjs'

const requirement = 'Update Skillager to browse your library by source.'
const kinds = [
  'project',
  'collection',
  'package',
  'directory',
  'personal',
  'unknown',
  'multiple',
]
const count = (value) => Number.isSafeInteger(value) && value >= 0
const cursor = (value) =>
  value === null || (typeof value === 'string' && value.length <= 4096)
export function sourceGroup(value) {
  const group = object(value)
  if (!/^source:[0-9a-f]{64}$/u.test(group.id) || !kinds.includes(group.kind))
    throw new Error('Skillager returned an invalid library source')
  const label = text(group.label, 256),
    detail = group.detail === null ? null : text(group.detail)
  if (!label) throw new Error('Skillager returned an invalid library source label')
  return { id: group.id, label, kind: group.kind, detail }
}
/** Optional labels never determine admission to flat skill or member pages. */
export function sourcePresentation(value) {
  if (value === undefined || value === null) return {}
  try {
    return { sourceGroup: sourceGroup(value) }
  } catch {
    return {}
  }
}
export function libraryGroups(value) {
  const data = object(value)
  if (
    data.schema !== 'skillager.library-groups.v1' ||
    data.scope !== 'library' ||
    !Array.isArray(data.groups) ||
    data.groups.length > 100 ||
    !cursor(data.next_cursor) ||
    !count(data.total_skills) ||
    !count(data.total_groups) ||
    !count(data.discovery_error_count)
  )
    throw new SkillagerSetupError('update-required', requirement)
  const ids = new Set()
  const groups = data.groups.map((item) => {
    const group = sourceGroup(item)
    if (ids.has(group.id) || !count(item.count) || item.count < 1)
      throw new Error('Skillager returned an invalid library source count')
    ids.add(group.id)
    return { ...group, count: item.count }
  })
  if (
    groups.length > data.total_groups ||
    groups.reduce((sum, group) => sum + group.count, 0) > data.total_skills
  )
    throw new Error('Skillager returned inconsistent library source totals')
  return {
    groups,
    total: data.total_skills,
    totalGroups: data.total_groups,
    next: data.next_cursor,
    errors: data.discovery_error_count,
  }
}
export function libraryGroupingFailure(error) {
  return error?.cli?.outcome === 'completed' &&
    error.cli.code === 2 &&
    /unrecognized arguments:.*--(?:group-by|source-group)/u.test(error.cli.stderr)
    ? new SkillagerSetupError('update-required', requirement)
    : error
}
export function sourcePage(value, page, id) {
  if (
    !count(value.total_skills) ||
    page.rows.length > value.total_skills ||
    page.rows.some((row) => row.sourceGroup?.id !== id)
  )
    throw new Error('Skillager returned a different library source page')
  return { ...page, total: value.total_skills }
}
