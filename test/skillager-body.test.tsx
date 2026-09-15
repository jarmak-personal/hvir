// @vitest-environment happy-dom
import { act } from 'react'
import { createRoot } from 'react-dom/client'
import { expect, it, vi } from 'vitest'
import {
  useSkillagerWorkspace,
  type SkillagerController,
} from '../src/renderer/src/skillager/use-skillager-workspace'
import { SkillagerDetails } from '../src/renderer/src/skillager/SkillagerDetails'
import { projectState } from './fixtures/skillager-exposure-fixture'
import {
  syncSelection as selection,
  syncContext as workspace,
} from './fixtures/skillager-sync-fixture'
import type { SkillagerMetadata } from '../src/shared/skillager'
import type { SkillagerContentRequest } from '../src/shared/skillager-content'
import { joinHostPath } from '../src/shared/host-path'
vi.mock('../src/renderer/src/viewer/markdown-client', () => ({
  renderMarkdown: () => Promise.resolve('<h1>Pending body</h1>'),
  useMarkdownRendererGeneration: () => 0,
}))
const row: SkillagerMetadata = {
  id: 'lib/example',
  name: 'Example',
  description: '',
  trust: 'reviewed',
  source: { type: 'library', ownership: 'library', libraryId: selection.library.id },
  contentHash: 'a'.repeat(64),
  tags: [],
  matchReasons: [],
  exposure: 'unknown',
}
async function fixture() {
  const focus = vi.spyOn(document, 'hasFocus').mockReturnValue(true)
  const node = document.createElement('div'),
    root = createRoot(node)
  document.body.append(node)
  let current!: SkillagerController
  const invoke = vi.fn<(channel: string, request: unknown) => Promise<unknown>>(
    (channel) =>
      Promise.resolve(
        channel === 'skillager:probe'
          ? { ok: true, value: { ...selection, probeId: 'probe' } }
          : channel === 'skillager:connect'
            ? { ok: true, value: { ...selection, connectionId: 'connection' } }
            : ['skillager:inventory', 'skillager:project-metadata'].includes(channel)
              ? {
                  ok: true,
                  value: {
                    rows: [],
                    checkedAt: 1,
                    durationMs: 1,
                    exposures: [],
                    requiresLibraryMetadata: false,
                  },
                }
              : undefined,
      ),
  )
  Object.defineProperty(window, 'hvir', { configurable: true, value: { invoke } })
  function Harness() {
    current = useSkillagerWorkspace({
      enabled: true,
      projectState: projectState(workspace),
      sidebarVisible: true,
      viewerVisible: true,
      onActivate: () => {},
      onDisabled: () => {},
    })
    return (
      <>
        <button className="terminal-focus">Terminal</button>
        {current.active ? (
          <SkillagerDetails
            metadata={current.active.metadata}
            tab={current.active}
            content={current.content}
            reviews={current.reviews}
            exposures={current.exposures}
            reviewRequested={current.reviewRequested}
          />
        ) : null}
      </>
    )
  }
  await act(() => Promise.resolve(root.render(<Harness />)))
  await act(() => current.connect())
  return {
    node,
    invoke,
    get current() {
      return current
    },
    dispose: async () => {
      await act(() => Promise.resolve(root.unmount()))
      node.remove()
      focus.mockRestore()
    },
  }
}
it('opens the current file explicitly after stale search, keeping unaccepted-byte provenance visible and actions reachable above the body', async () => {
  const f = await fixture()
  try {
    const normal = f.invoke.getMockImplementation()!
    f.invoke.mockImplementation((channel, request) => {
      if (channel !== 'skillager:open-document') return normal(channel, request)
      const selected = request as SkillagerContentRequest
      return Promise.resolve(
        selected.selection.expectedHash
          ? {
              ok: false,
              reason: 'stale-review',
              message: 'Selected search source changed',
            }
          : {
              ok: true,
              value: {
                contentId: 'current',
                selection: selected.selection,
                content: {
                  entry: 'SKILL.md',
                  path: selected.selection.path,
                  size: 14,
                  text: '# Pending body',
                },
              },
            },
      )
    })
    const path = joinHostPath(selection.library.skillsRoot, 'example')
    const occurrence = {
      id: 'source',
      kind: 'library' as const,
      path,
      entrypoint: joinHostPath(path, 'SKILL.md'),
    }
    const searched = {
      ...row,
      search: {
        groupId: 'group',
        groupOccurrences: 1,
        installed: false,
        occurrence,
        match: {
          occurrence,
          skillId: row.id,
          contentHash: 'b'.repeat(64),
          score: 1,
          reasons: ['body'],
        },
      },
    }
    await act(() => Promise.resolve(f.current.select(searched)))
    expect(f.node.querySelector('.skillager-secondary')?.hasAttribute('open')).toBe(false)
    const open = [...f.node.querySelectorAll('button')].find(
      (button) => button.textContent === 'Open current file',
    )!
    expect(open).toBeDefined()
    await act(() => Promise.resolve(open.click()))
    expect(f.node.querySelector('.skillager-body h1')?.textContent).toBe('Pending body')
    expect(f.node.querySelector('.skillager-body')?.textContent).toContain(
      'may have unaccepted changes',
    )
    expect(f.node.textContent).toContain('Search review state (submitted observation)')
    expect(f.node.textContent).toContain(
      'Selected search version (submitted observation)',
    )
    expect(
      f.node.querySelectorAll('.skillager-details .skillager-actions-trigger'),
    ).toHaveLength(1)
    expect(
      f.node.querySelector('.skillager-details header .skillager-actions-trigger'),
    ).not.toBeNull()
    expect(f.node.querySelector('.skillager-review-content')).toBeNull()
    expect(
      f.invoke.mock.calls.some(
        ([channel]) =>
          channel === 'skillager:review' || channel === 'skillager:accept-review',
      ),
    ).toBe(false)
  } finally {
    await f.dispose()
  }
})
it('reveals/focuses explicit top-menu update review once without opening an ordinary body or stealing focus on completion', async () => {
  const f = await fixture()
  try {
    const normal = f.invoke.getMockImplementation()!
    let finish!: (value: unknown) => void
    f.invoke.mockImplementation((channel, request) =>
      channel === 'skillager:review'
        ? new Promise((resolve) => {
            finish = resolve
          })
        : ['skillager:inventory', 'skillager:project-metadata'].includes(channel)
          ? Promise.resolve({
              ok: true,
              value: {
                rows: [row],
                exposures: [update.workspace],
                checkedAt: 1,
                durationMs: 1,
                requiresLibraryMetadata: true,
                setupRunning: false,
              },
            })
          : normal(channel, request),
    )
    const update: SkillagerMetadata = {
      ...row,
      workspaceFreshness: 'fresh',
      workspace: {
        id: 'copy',
        skillId: row.id,
        sourceLibraryId: selection.library.id,
        target: joinHostPath(workspace, '.agents/skills/example'),
        agent: 'codex',
        mode: 'native',
        status: 'source_update',
        expectedSourceHash: row.contentHash,
      },
    }
    await act(() => f.current.refreshProjectMetadata())
    await act(() => Promise.resolve(f.current.exposures.start(update, 'review-update')))
    expect(f.node.querySelector<HTMLDetailsElement>('.skillager-secondary')?.open).toBe(
      true,
    )
    expect(document.activeElement).toBe(f.node.querySelector('.skillager-review'))
    expect(
      f.invoke.mock.calls.filter(([channel]) => channel === 'skillager:review'),
    ).toHaveLength(1)
    expect(
      f.invoke.mock.calls.filter(([channel]) => channel === 'skillager:open-document'),
    ).toHaveLength(0)
    const terminal = f.node.querySelector<HTMLButtonElement>('.terminal-focus')!
    act(() => terminal.focus())
    await act(() =>
      Promise.resolve(
        finish({
          ok: false,
          reason: 'unavailable',
          message: 'Fixture update unavailable',
        }),
      ),
    )
    expect(document.activeElement).toBe(terminal)
    await act(() => Promise.resolve(f.current.select({ ...row, id: 'lib/other' })))
    expect(f.node.querySelector<HTMLDetailsElement>('.skillager-secondary')?.open).toBe(
      false,
    )
  } finally {
    await f.dispose()
  }
})
