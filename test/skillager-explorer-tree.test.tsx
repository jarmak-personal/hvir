import { exposureActions } from '../src/renderer/src/skillager/skillager-exposure-model'
// @vitest-environment happy-dom
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { localPath } from '../src/shared/host-path'
import { SKILLAGER_SEARCH_LIMIT, type SkillagerMetadata } from '../src/shared/skillager'
import { SkillagerTree } from '../src/renderer/src/skillager/SkillagerTree'
import {
  canonicalSkillagerMetadata,
  skillagerMetadataKey,
} from '../src/renderer/src/skillager/skillager-model'
import type { SkillagerExposureController } from '../src/renderer/src/skillager/use-skillager-exposure'

let mount: HTMLDivElement, root: Root
const source: SkillagerMetadata = {
  id: 'lib/guide',
  name: 'Guide',
  description: 'Metadata',
  trust: 'reviewed',
  source: { type: 'collection', ownership: 'library', libraryId: 'library' },
  tags: [],
  matchReasons: [],
  exposure: 'hidden',
}
const rows = Array.from({ length: 5000 }, (_, i) => ({
  ...source,
  id: `lib/guide-${i}`,
  name: `Guide ${i}`,
}))
const select = vi.fn(),
  dismiss = vi.fn()
const actions = {
  actions: exposureActions,
  request: undefined,
  dismiss,
  current: () => true,
  open: vi.fn(),
} as unknown as SkillagerExposureController['menu']
function render(items: readonly SkillagerMetadata[], activeId?: string) {
  act(() =>
    root.render(
      <SkillagerTree
        rows={items}
        known={{
          rows: canonicalSkillagerMetadata(items),
          checkedAt: 1,
          freshness: 'fresh',
        }}
        label="Your library"
        actions={actions}
        onSelect={select}
        activeId={activeId}
      />,
    ),
  )
}
function key(value: string) {
  act(() => {
    document.activeElement!.dispatchEvent(
      new KeyboardEvent('keydown', { key: value, bubbles: true }),
    )
  })
}
function tree() {
  return mount.querySelector<HTMLElement>('[role="tree"]')!
}
function entry() {
  return mount.querySelector<HTMLButtonElement>('[role="treeitem"][tabindex="0"]')!
}
beforeEach(() => {
  vi.spyOn(HTMLElement.prototype, 'clientHeight', 'get').mockReturnValue(250)
  mount = document.createElement('div')
  document.body.append(mount)
  root = createRoot(mount)
  select.mockClear()
  dismiss.mockClear()
})
afterEach(() => {
  act(() => root.unmount())
  mount.remove()
  vi.restoreAllMocks()
})

it('keeps all 5000 metadata rows reachable through a bounded keyboard window without changing viewer selection', () => {
  render(rows, skillagerMetadataKey(rows[0]!))
  act(() => entry().focus())
  key('End')
  expect(document.activeElement?.textContent).toContain('Guide 4999')
  expect(mount.querySelectorAll('[role="treeitem"]').length).toBeLessThanOrEqual(16)
  expect(select).not.toHaveBeenCalled()
  act(() => (document.activeElement as HTMLButtonElement).click())
  expect(select).toHaveBeenCalledWith(rows[4999])
  key('Home')
  expect(document.activeElement?.textContent).toContain('Guide 0')
  expect(mount.querySelector('[aria-selected="true"]')?.textContent).toContain('Guide 0')
})

it('retains a mounted keyboard entry after pointer scroll unmounts the previous tab stop', () => {
  render(rows)
  const outside = document.createElement('button')
  document.body.append(outside)
  outside.focus()
  act(() => {
    tree().scrollTop = 90_000
    tree().dispatchEvent(new Event('scroll', { bubbles: true }))
  })
  expect(document.activeElement).toBe(outside)
  expect(entry()).not.toBeNull()
  act(() => entry().focus())
  const before = document.activeElement?.textContent
  key('ArrowDown')
  expect(document.activeElement?.textContent).not.toBe(before)
  expect(tree().contains(document.activeElement)).toBe(true)
  expect(mount.querySelectorAll('[role="treeitem"]').length).toBeLessThanOrEqual(16)
  outside.remove()
})

it('moves focus to a mounted survivor after deep removal and to the parent after child collapse', () => {
  const copies = Array.from({ length: 5000 }, (_, i) => ({
    id: `copy-${i}`,
    agent: 'codex' as const,
    skillId: source.id,
    sourceLibraryId: 'library',
    target: localPath(`/project/copies/${i}`),
    mode: 'native',
    status: 'current',
  }))
  const expanded = { ...source, workspaceCopies: copies }
  render([expanded])
  act(() => entry().focus())
  key('ArrowRight')
  key('End')
  expect(document.activeElement?.getAttribute('aria-level')).toBe('2')
  expect(tree().scrollTop).toBeGreaterThan(100_000)
  render([{ ...expanded, workspaceCopies: copies.slice(0, -1) }])
  expect(tree().contains(document.activeElement)).toBe(true)
  expect(entry()).not.toBeNull()
  key('ArrowLeft')
  expect(document.activeElement?.getAttribute('aria-level')).toBe('1')
  key('ArrowLeft')
  expect(mount.querySelectorAll('[role="treeitem"]')).toHaveLength(1)
  expect(document.activeElement?.getAttribute('aria-expanded')).toBe('false')
  expect(select).not.toHaveBeenCalled()
})

it('admits whole groups up to the height limit, explains refresh collapses, and refuses further expansion without losing focus or selection', () => {
  const members = Array.from({ length: 10_000 }, (_, i) => `lib/member-${i}`)
  const router = (index: number, size: number): SkillagerMetadata => ({
    ...source,
    id: `router-${index}`,
    name: `Router ${index}`,
    source: { type: 'workspace', ownership: 'unknown' },
    workspace: {
      id: `router-${index}`,
      agent: 'codex',
      mode: 'router',
      status: 'current',
      target: localPath(`/project/router-${index}`),
      router: {
        slug: `router-${index}`,
        kind: 'group',
        skillIds: members.slice(0, size),
      },
    },
  })
  const initial = [
    router(0, 10_000),
    router(1, 10_000),
    router(2, 10_000),
    router(3, 9996),
  ]
  render(initial)
  for (let index = 0; index < initial.length; index++) {
    const disclosure = [
      ...mount.querySelectorAll<HTMLButtonElement>('.skillager-disclosure'),
    ].find(
      (item) => item.getAttribute('aria-label') === `Related entries for Router ${index}`,
    )
    if (disclosure) act(() => disclosure.click())
    else {
      key('End')
      key('ArrowRight')
    }
    key('End')
  }
  expect(mount.querySelector<HTMLElement>('.skillager-tree-space')!.style.height).toBe(
    '1000000px',
  )
  expect(document.activeElement?.textContent).toContain('lib/member-9995')
  act(() => (document.activeElement as HTMLButtonElement).click())
  const selected = skillagerMetadataKey(select.mock.calls[0]![0] as SkillagerMetadata)
  render([...initial, router(4, 1)], selected)
  expect(mount.querySelector('[role="status"]')?.textContent).toContain(
    'Later groups were collapsed',
  )
  expect(
    Number.parseInt(
      mount.querySelector<HTMLElement>('.skillager-tree-space')!.style.height,
    ),
  ).toBeLessThan(1_000_000)
  key('End')
  key('ArrowUp')
  expect(document.activeElement?.textContent).toContain('Router 3')
  key('ArrowRight')
  expect(document.activeElement?.getAttribute('aria-expanded')).toBe('false')
  expect(mount.querySelector('[role="status"]')?.textContent).toContain(
    'Collapse another skill',
  )
  expect(select).toHaveBeenCalledOnce()
})

it('uses the search occurrence height for range and End navigation while keeping selection and legacy browse height intact', () => {
  const matches: SkillagerMetadata[] = rows
    .slice(0, SKILLAGER_SEARCH_LIMIT)
    .map((row, index) => {
      const occurrence = {
        id: `canonical-${index}`,
        kind: 'library' as const,
        path: localPath(`/library/skills/guide-${index}`),
        entrypoint: localPath(`/library/skills/guide-${index}/SKILL.md`),
      }
      return {
        ...row,
        search: {
          groupId: `group-${index}`,
          canonical: { libraryId: 'library', skillId: row.id },
          occurrence,
          groupOccurrences: 2,
          installed: true,
          match: {
            occurrence:
              index === SKILLAGER_SEARCH_LIMIT - 1
                ? occurrence
                : {
                    id: `original-${index}`,
                    kind: 'project-original',
                    path: localPath(`/project/.claude/skills/guide-${index}`),
                    entrypoint: localPath(
                      `/project/.claude/skills/guide-${index}/SKILL.md`,
                    ),
                    agent: 'claude',
                  },
            skillId:
              index === SKILLAGER_SEARCH_LIMIT - 1 ? row.id : `project/guide-${index}`,
            contentHash: 'a'.repeat(64),
            score: 1,
            reasons: ['body'],
          },
        },
      }
    })
  render(matches, skillagerMetadataKey(matches[0]!))
  const first = entry()
  expect(first.querySelector('.skillager-search-context')?.textContent).toBe(
    'Your library',
  )
  expect(first.querySelector('.skillager-search-match')?.textContent).toBe(
    'Matched in Project · Claude Code',
  )
  expect(first.querySelector('.skillager-search-match')?.getAttribute('title')).toContain(
    'Project original · Claude Code · local:/project/.claude/skills/guide-0',
  )
  expect(mount.querySelector<HTMLElement>('.skillager-tree-space')!.style.height).toBe(
    '2800px',
  )
  expect(mount.querySelector<HTMLElement>('.skillager-tree-line')!.style.height).toBe(
    '56px',
  )
  act(() => first.focus())
  key('End')
  expect(document.activeElement?.getAttribute('data-skill-key')).toBe(
    skillagerMetadataKey(matches[49]!),
  )
  expect(document.activeElement?.querySelector('.skillager-search-match')).toBeNull()
  expect(tree().scrollTop).toBe(2550)
  expect(mount.querySelectorAll('[role="treeitem"]').length).toBeLessThanOrEqual(12)
  expect(select).not.toHaveBeenCalled()
  act(() => (document.activeElement as HTMLButtonElement).click())
  expect(select).toHaveBeenCalledWith(matches[49])
  key('Home')
  expect(document.activeElement).toBe(entry())
  expect(document.activeElement?.getAttribute('aria-selected')).toBe('true')
  key('End')
  render(matches.map((row) => ({ ...row, search: undefined })))
  expect(mount.querySelector<HTMLElement>('.skillager-tree-space')!.style.height).toBe(
    '1250px',
  )
  expect(mount.querySelector<HTMLElement>('.skillager-tree-line')!.style.height).toBe(
    '25px',
  )
  expect(tree().scrollTop).toBe(1000)
  expect(tree().contains(document.activeElement)).toBe(true)
  expect(mount.querySelector('.skillager-search-context')).toBeNull()
})

it('keeps normal occurrences quiet and gives context glyphs accessible names without hiding exceptions', () => {
  const original: SkillagerMetadata = {
    ...source,
    id: 'project/original',
    source: { type: 'project', ownership: 'external' },
    projectSkill: {
      path: localPath('/project/.claude/skills/original'),
      agent: 'claude',
      managed: false,
    },
  }
  const copy: SkillagerMetadata = {
    ...source,
    workspace: {
      id: 'copy',
      agent: 'codex',
      skillId: source.id,
      sourceLibraryId: 'library',
      target: localPath('/project/.agents/skills/guide'),
      mode: 'native',
      status: 'current',
    },
  }
  render([source, original, copy])
  const items = [...mount.querySelectorAll('[role="treeitem"]')]
  expect(items[0]!.querySelector('.skillager-badges')?.textContent).toBe('')
  expect(items[0]!.querySelector('[aria-label="Your library"]')).toBeNull()
  expect(
    items[1]!
      .querySelector('[role="img"][aria-label="Claude Code"]')
      ?.getAttribute('title'),
  ).toBe('Claude Code')
  expect(
    items[1]!
      .querySelector('[role="img"][aria-label="Project original"]')
      ?.getAttribute('title'),
  ).toBe('Project original')
  expect(
    items[2]!
      .querySelector('[role="img"][aria-label="Installed Full"]')
      ?.getAttribute('title'),
  ).toBe('Installed Full')
  expect(items[2]!.querySelector('.skillager-status-badge')).toBeNull()
  expect(
    mount.querySelectorAll(
      '.skillager-icon[tabindex], .skillager-icon svg:not([focusable="false"])',
    ),
  ).toHaveLength(0)
  render([{ ...copy, workspace: { ...copy.workspace!, status: 'local_edit' } }])
  expect(entry().querySelector('.skillager-status-badge')?.textContent).toBe(
    'Workspace copy modified',
  )
  render([{ ...copy, trust: 'pinned' }])
  expect(entry().querySelector('.skillager-status-badge')?.textContent).toBe(
    'Pinned source · update unavailable',
  )
  render([{ ...source, trust: 'discovered' }])
  expect(entry().querySelector('.skillager-status-badge')?.textContent).toBe(
    'Pending review',
  )
})
