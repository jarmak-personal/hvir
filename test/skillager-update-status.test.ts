import { expect, it } from 'vitest'
import { parseUpdateSourceHash } from '../src/main/skillager/skillager-update-status'
import { parseSkillagerExposures } from '../src/main/skillager/skillager-cli-metadata'
import { parseExposurePreview } from '../src/main/skillager/skillager-exposure-contract'
import { localPath } from '../src/shared/host-path'
import {
  exposureResponse,
  request,
  selection,
  hash,
} from './fixtures/skillager-exposure-fixture'
import {
  eligibleSkillagerUpdate,
  workspaceSkillLabel,
} from '../src/renderer/src/skillager/skillager-exposure-model'
import { skillagerWorkspaceMetadata } from '../src/renderer/src/skillager/skillager-model'
import type { SkillagerMetadata } from '../src/shared/skillager'

const old = 'c'.repeat(64)
function fixture(mode: 'native' | 'stub' = 'native') {
  const exposure = {
    id: 'lib-demo',
    skillId: request.skillId,
    target: localPath('/other/.agents/skills/lib-demo'),
    mode,
    status: 'source_update',
    expectedSourceHash: hash,
  }
  const at = { ...request, action: 'update' as const, mode, exposure }
  const snapshot = parseExposurePreview(
    exposureResponse({ ...at, action: 'change' }).value,
    selection,
    at,
  )
  const skill = {
    id: request.skillId,
    path: '/library/skills/demo',
    acceptance: 'accepted',
    working_hash: hash,
    accepted_hash: hash,
    exposures: [
      {
        path: exposure.target.path,
        agent: 'codex',
        kind: mode,
        scope: 'project',
        status: 'update_available',
        source_hash: old,
      },
    ],
  }
  const status = { schema: 'skillager.library-status.v1', skill }
  return { exposure, snapshot, skill, status }
}
it.each(['native', 'stub'] as const)(
  'gets exact %s old canonical version from paired public status',
  (mode) => {
    const f = fixture(mode)
    expect(parseUpdateSourceHash(f.status, selection, f.snapshot, [f.exposure])).toBe(old)
  },
)
it.each(['local_edit', 'source_unavailable', 'unmanaged', 'current'])(
  'never treats %s drift as eligible based on library status alone',
  (status) => {
    const f = fixture()
    expect(() =>
      parseUpdateSourceHash(f.status, selection, f.snapshot, [{ ...f.exposure, status }]),
    ).toThrow()
  },
)
it.each(['pending', 'blocked'])('rejects %s source acceptance state', (acceptance) => {
  const f = fixture()
  f.skill.acceptance = acceptance
  expect(() =>
    parseUpdateSourceHash(f.status, selection, f.snapshot, [f.exposure]),
  ).toThrow()
})
it.each(['agent', 'kind', 'path', 'scope', 'source_hash'])(
  'refuses unavailable or mismatched %s evidence',
  (field) => {
    const f = fixture()
    Object.assign(f.skill.exposures[0]!, { [field]: 'different' })
    expect(() =>
      parseUpdateSourceHash(f.status, selection, f.snapshot, [f.exposure]),
    ).toThrow()
  },
)
it('projects only validated accepted-source hashes from the exposure list', () => {
  const payload = {
    schema: 'skillager.exposures.v1',
    exposures: [
      {
        schema: 'skillager.exposure.v1',
        agent: 'codex',
        scope: 'project',
        target: '/other/copy',
        exposure_id: 'copy',
        skill_id: 'lib/demo',
        mode: 'stub',
        status: 'source_update',
        current_hash: old,
        expected_source_hash: hash,
      },
    ],
  }
  expect(
    parseSkillagerExposures(payload, localPath('/other'), 'codex')[0]?.expectedSourceHash,
  ).toBe(hash)
  payload.exposures[0]!.expected_source_hash = 'invalid'
  expect(() => parseSkillagerExposures(payload, localPath('/other'), 'codex')).toThrow()
})
const metadata: SkillagerMetadata = {
  id: request.skillId,
  name: 'Demo',
  description: '',
  source: { type: 'collection', ownership: 'library' },
  trust: 'reviewed',
  contentHash: hash,
  tags: [],
  matchReasons: [],
  exposure: 'unknown',
}
it('library search without independent exposure observation cannot infer update, absence, or current state', () => {
  const row = skillagerWorkspaceMetadata({
    rows: [metadata],
    checkedAt: 1,
    durationMs: 1,
  })[0]!
  expect(row.exposure).toBe('unknown')
  expect(row.workspace).toBeUndefined()
  expect(eligibleSkillagerUpdate(row)).toBe(false)
})
it('labels only fresh accepted source drift as behind and separates protected states', () => {
  const f = fixture()
  const row = skillagerWorkspaceMetadata({
    rows: [metadata],
    exposures: [f.exposure],
    checkedAt: 1,
    durationMs: 1,
  })[0]!
  expect(eligibleSkillagerUpdate(row)).toBe(true)
  expect(workspaceSkillLabel(row)).toBe('Workspace copy behind')
  for (const trust of ['pinned', 'blocked', 'discovered', 'lint_blocked'] as const)
    expect(eligibleSkillagerUpdate({ ...row, trust })).toBe(false)
  for (const workspaceFreshness of ['stale', 'unavailable', 'checking'] as const)
    expect(eligibleSkillagerUpdate({ ...row, workspaceFreshness })).toBe(false)
  expect(
    workspaceSkillLabel({ ...row, workspace: { ...f.exposure, status: 'local_edit' } }),
  ).toBe('Workspace copy modified')
})

it('refuses a pinned incoming source even when a renderer explicitly requests an update', () => {
  const f = fixture()
  const response = exposureResponse({ ...f.snapshot.detail.request, action: 'change' })
  response.row.preview.source.trust = 'pinned'
  expect(() =>
    parseExposurePreview(response.value, selection, f.snapshot.detail.request),
  ).toThrow('pinned')
})

it.each([undefined, 'f'.repeat(64)])(
  'labels unmatched accepted source evidence %s as unverified, preserving genuine unavailability',
  (expectedSourceHash) => {
    const { exposure } = fixture()
    const row = {
      ...metadata,
      workspaceFreshness: 'fresh' as const,
      workspace: { ...exposure, expectedSourceHash },
    }
    expect(eligibleSkillagerUpdate(row)).toBe(false)
    expect(workspaceSkillLabel(row)).toBe('Update unverified')
    expect(
      workspaceSkillLabel({
        ...row,
        workspace: { ...row.workspace, status: 'source_unavailable' },
      }),
    ).toBe('Source unavailable for update')
  },
)
