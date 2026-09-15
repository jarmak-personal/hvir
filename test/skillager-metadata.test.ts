import { describe, expect, it } from 'vitest'
import { localPath } from '../src/shared/host-path'
import {
  parseSkillagerExposures,
  parseSkillagerInventory,
  parseSkillagerLibrary,
  parseSkillagerSearch,
} from '../src/main/skillager/skillager-cli-metadata'

const library = {
  id: '4f0467b4-bf3e-4c85-a11e-aac0f6071398',
  root: localPath('/library'),
  skillsRoot: localPath('/library/skills'),
}
function row(id = 'draft', trust = 'discovered') {
  return {
    id: `lib/${id}`,
    name: id,
    summary: 'Short metadata',
    root: `/library/skills/${id}`,
    content_hash: 'a'.repeat(64),
    trust,
    source: {
      type: 'collection',
      collection: 'lib',
      ownership: 'library',
      library_id: library.id,
    },
    scan: { risk: 'low', findings: [{ message: 'PRIVATE INSTRUCTION EXCERPT' }] },
    body: 'PRIVATE BODY',
    approval_key: 'PRIVATE APPROVAL KEY',
    reasons: ['title:term', 'body:term', 'body:PRIVATE INSTRUCTION'],
    exposure: 'unknown',
  }
}
function inventory(skills: unknown[] = [row()]) {
  return {
    schema: 'skillager.collection-index.v1',
    name: 'lib',
    kind: 'library',
    path: library.skillsRoot.path,
    library_id: library.id,
    errors: [],
    skills,
  }
}

describe('Skillager metadata boundary', () => {
  it('reads library registration without interpreting canonical files or approval storage', () => {
    expect(
      parseSkillagerLibrary({
        collections: {
          lib: {
            kind: 'library',
            library_id: library.id,
            library_root: '/library',
            path: '/library/skills',
          },
        },
      }),
    ).toEqual(library)
    expect(parseSkillagerLibrary({ collections: {} })).toBeUndefined()
    expect(() =>
      parseSkillagerLibrary({
        collections: { lib: { kind: 'local', path: '/outside' } },
      }),
    ).toThrow()
  })
  it('retains all review states and strips scanner excerpts, bodies, roots and approval keys', () => {
    const rows = parseSkillagerInventory(
      inventory(
        ['reviewed', 'discovered', 'blocked', 'lint_blocked'].map((trust, index) =>
          row(`item-${index}`, trust),
        ),
      ),
      library,
    )
    expect(rows.map((item) => item.trust)).toEqual([
      'reviewed',
      'discovered',
      'blocked',
      'lint_blocked',
    ])
    expect(rows[0]?.matchReasons).toEqual(['title:term', 'body:term'])
    expect(JSON.stringify(rows)).not.toMatch(
      /PRIVATE|approval_key|findings|\/library\/skills/,
    )
  })
  it('rejects wrong library identity, traversal, external inventory and partial errors', () => {
    for (const bad of [
      { ...inventory(), library_id: 'wrong' },
      { ...inventory(), errors: ['unreadable skill'] },
      inventory([{ ...row(), root: '/elsewhere/draft' }]),
      inventory([row('../draft')]),
      inventory([{ ...row(), source: { type: 'collection', ownership: 'external' } }]),
      inventory([row(), row()]),
    ])
      expect(() => parseSkillagerInventory(bad, library)).toThrow()
  })
  it('preserves ranking and provenance, validates scope and rejects silent truncation', () => {
    const external = {
      ...row('external', 'trusted'),
      id: 'work/external',
      source: { type: 'collection', collection: 'work', ownership: 'external' },
      exposure: 'hidden',
    }
    const owned = row('owned', 'reviewed')
    expect(
      parseSkillagerSearch([external, owned], library, false).map((item) => item.id),
    ).toEqual(['work/external', 'lib/owned'])
    expect(() => parseSkillagerSearch([external], library, true)).toThrow()
    expect(() => parseSkillagerSearch([row()], library, true)).toThrow()
    expect(() =>
      parseSkillagerSearch(
        Array.from({ length: 51 }, (_, n) => row(`item-${n}`, 'reviewed')),
        library,
        true,
      ),
    ).toThrow()
    expect(parseSkillagerSearch([], library, true)).toEqual([])
  })
  it('admits 5,000 complete owned rows and explicitly rejects oversized inventories', () => {
    expect(
      parseSkillagerInventory(
        inventory(Array.from({ length: 5000 }, (_, n) => row(`item-${n}`))),
        library,
      ),
    ).toHaveLength(5000)
    expect(() =>
      parseSkillagerInventory(inventory(Array(10001).fill(row())), library),
    ).toThrow()
  })
  it('requires real local project exposure targets and exact requested agent', () => {
    const payload = {
      schema: 'skillager.exposures.v1',
      exposures: [
        {
          schema: 'skillager.exposure.v1',
          agent: 'codex',
          scope: 'project',
          exposure_id: 'copy',
          skill_id: 'lib/draft',
          target: '/project/.agents/skills/copy',
          mode: 'native',
          status: 'current',
        },
      ],
    }
    expect(
      parseSkillagerExposures(payload, localPath('/project'), 'codex')[0]?.target,
    ).toEqual(localPath('/project/.agents/skills/copy'))
    expect(() => parseSkillagerExposures(payload, localPath('/other'), 'codex')).toThrow()
    expect(() =>
      parseSkillagerExposures(payload, localPath('/project'), 'claude'),
    ).toThrow()
  })
})
