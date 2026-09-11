import { describe, expect, it } from 'vitest'
import { localPath } from '../src/shared/host-path'
import {
  parseExposureApplied,
  parseExposurePreview,
} from '../src/main/skillager/skillager-exposure-contract'
import { skillagerDestinationAvailable } from '../src/main/skillager/skillager-destination'
import {
  exposureResponse,
  hash,
  projectState,
  request,
  selection,
  token,
} from './fixtures/skillager-exposure-fixture'

const copy = {
  id: 'lib-demo',
  skillId: request.skillId,
  target: localPath('/other/.agents/skills/lib-demo'),
  mode: 'native',
  status: 'current',
}
const remove = { ...request, action: 'remove' as const, exposure: copy }
describe('complete bound exposure contract', () => {
  it('discloses supporting files, generated sidecar policy, exact hashes and folder permissions', () => {
    const result = parseExposurePreview(exposureResponse().value, selection, request)
    expect(result.confirmationToken).toBe(token)
    expect(result.detail).toMatchObject({
      sourceHash: hash,
      targetHash: null,
      beforeMode: null,
      afterMode: 0o755,
    })
    expect(result.detail.effects.map((item) => item.path)).toEqual([
      'SKILL.md',
      'support.md',
      'skillager.materialized.yaml',
    ])
    expect(result.detail.effects[2]!.after?.generatedFields).toHaveLength(3)
  })
  it('permits CLI-eligible unchanged pinned-source mode changes without inventing target pins', () => {
    const at = {
      ...request,
      action: 'change' as const,
      mode: 'stub' as const,
      exposure: copy,
    }
    const response = exposureResponse(at)
    response.row.preview.source.trust = 'pinned'
    expect(parseExposurePreview(response.value, selection, at).detail.request.mode).toBe(
      'stub',
    )
  })
  it('validates removal independently of canonical source trust and requires a removed folder', () => {
    const response = exposureResponse(remove)
    response.row.preview.source.trust = 'discovered'
    const snapshot = parseExposurePreview(response.value, selection, remove)
    expect(snapshot.detail.effects.every((item) => item.action === 'remove')).toBe(true)
    response.row.preview.target_directory.after_mode = 0o755
    expect(() => parseExposurePreview(response.value, selection, remove)).toThrow()
    response.row.preview.target_directory.after_mode = null
    response.row.status = 'removed'
    expect(parseExposureApplied(response.value, snapshot).status).toBe('removed')
    response.row.preview.target_directory.before_mode = 0o700
    expect(() => parseExposureApplied(response.value, snapshot)).toThrow()
  })
  it.each(['add', 'remove'] as const)(
    'refuses the older %s schema even with the same installed version',
    (action) => {
      const at = action === 'remove' ? remove : request,
        response = exposureResponse(at)
      Reflect.deleteProperty(response.row, 'preview')
      expect(() => parseExposurePreview(response.value, selection, at)).toThrow(
        'installation does not support',
      )
    },
  )
  it.each([
    'project',
    'target',
    'argv',
    'source',
    'effects',
    'duplicate',
    'parent',
    'mode',
    'generated',
    'overflow',
  ])('refuses incomplete or substituted %s', (fault) => {
    const { row, value } = exposureResponse()
    if (fault === 'project') row.preview.project = '/origin'
    if (fault === 'target') row.target = '/origin/.agents/skills/lib-demo'
    if (fault === 'argv') row.next_command_argv[1] = 'other'
    if (fault === 'source') row.preview.source.root = '/library/skills/another'
    if (fault === 'effects') row.preview.file_effects[1]!.path = '../escape'
    if (fault === 'duplicate') row.preview.file_effects[1]!.path = 'SKILL.md'
    if (fault === 'parent') row.preview.file_effects[1]!.path = 'missing/file'
    if (fault === 'mode') row.preview.target_directory.after_mode = -1
    if (fault === 'generated') {
      const after = row.preview.file_effects[2]!.after!
      if ('generated_fields' in after)
        after.generated_fields.materialized_at = 'different'
    }
    if (fault === 'overflow')
      row.preview.file_effects = Array.from(
        { length: 2049 },
        () => row.preview.file_effects[0]!,
      )
    expect(() => parseExposurePreview(value, selection, request)).toThrow()
  })
  it('reports skipped/refused items as failure despite successful JSON/process output', () => {
    const response = exposureResponse(),
      snapshot = parseExposurePreview(response.value, selection, request)
    Object.assign(response.row, { status: 'skipped', reason: 'preview is stale' })
    expect(() => parseExposureApplied(response.value, snapshot)).toThrow(
      'source or target changed',
    )
  })
  it('admits registered nonactive destinations and rejects removed, closed, remote or substituted roots', () => {
    const state = projectState()
    expect(skillagerDestinationAvailable(state, request.destination)).toBe(true)
    expect(
      skillagerDestinationAvailable(state, {
        ...request.destination,
        root: localPath('/origin'),
      }),
    ).toBe(false)
    for (const flag of ['closed', 'missing'] as const) {
      const changed = {
        ...state,
        projects: state.projects.map((project) => ({
          ...project,
          workspaces: project.workspaces.map((workspace) => ({
            ...workspace,
            [flag]: true,
          })),
        })),
      }
      expect(skillagerDestinationAvailable(changed, request.destination)).toBe(false)
    }
  })
})
