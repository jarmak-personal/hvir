// @vitest-environment happy-dom
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { projectState } from './fixtures/skillager-exposure-fixture'
import type { ProjectState } from '../src/shared/workspace-types'
import { asHostId, hostPath, localPath } from '../src/shared/host-path'
import {
  useSkillagerReview,
  type SkillagerReviewController,
} from '../src/renderer/src/skillager/use-skillager-review'
import type { SkillagerDetailTab } from '../src/renderer/src/skillager/skillager-model'
import type { SkillagerReview } from '../src/shared/skillager-review'

const root = localPath('/workspace')
const connection = {
  connectionId: 'connected',
  executable: localPath('/skillager'),
  version: 'skillager 0.9.0',
  library: {
    id: 'library',
    root: localPath('/library'),
    skillsRoot: localPath('/library/skills'),
  },
}
const tab: SkillagerDetailTab = {
  id: 'tab',
  metadata: {
    id: 'lib/example',
    name: 'Example',
    description: 'Pending',
    source: { type: 'collection', ownership: 'library', libraryId: 'library' },
    trust: 'discovered',
    tags: [],
    matchReasons: [],
    exposure: 'unknown',
  },
}
const detail: SkillagerReview = {
  reviewId: 'review',
  root: localPath('/library/skills/example'),
  skillId: tab.metadata.id,
  hash: 'a'.repeat(64),
  files: [{ entry: 'SKILL.md', size: 10, executable: false }],
  canAccept: true,
  scanRisk: 'low',
  lintStatus: 'ok',
  findings: [],
  history: { available: false, reason: 'no-git', versions: [] },
}
const invoke = vi.fn<(channel: string, request: unknown) => Promise<unknown>>()
let container: HTMLDivElement, react: Root, current: SkillagerReviewController
const accepted = vi.fn()
function Harness({
  open = true,
  connected = true,
  project,
  activeId = tab.id,
  openTabs = tabs,
}: {
  open?: boolean
  connected?: boolean
  project?: ProjectState
  activeId?: string
  openTabs?: readonly SkillagerDetailTab[]
}) {
  current = useSkillagerReview({
    connection: connected ? connection : undefined,
    root: project?.root ?? root,
    projectState: project,
    agent: 'codex',
    tabs: open ? openTabs : [],
    activeId: open ? activeId : undefined,
    onAccepted: accepted,
  })
  return null
}
const tabs = [tab]
beforeEach(() => {
  container = document.createElement('div')
  document.body.append(container)
  react = createRoot(container)
  accepted.mockReset()
  invoke
    .mockReset()
    .mockImplementation((channel) =>
      Promise.resolve(
        channel === 'skillager:review'
          ? { ok: true, value: detail }
          : channel === 'skillager:history'
            ? { ok: true, value: detail.history }
            : channel === 'skillager:accept-review'
              ? { ok: true, value: { status: 'accepted', hash: detail.hash } }
              : undefined,
      ),
    )
  Object.defineProperty(window, 'hvir', { configurable: true, value: { invoke } })
})
afterEach(() => {
  act(() => react.unmount())
  container.remove()
})
async function render(props: Parameters<typeof Harness>[0] = {}) {
  await act(async () => {
    react.render(<Harness {...props} />)
    await Promise.resolve()
  })
}

it('does no implicit content work and separately requests history, review, and acceptance', async () => {
  await render()
  expect(invoke).not.toHaveBeenCalled()
  await act(async () => current.history(tab))
  expect(current.states.tab?.history).toEqual(detail.history)
  expect(current.states.tab?.detail).toBeUndefined()
  await act(async () => current.review(tab))
  expect(current.states.tab?.detail).toEqual(detail)
  expect(accepted).not.toHaveBeenCalled()
  await act(async () => current.accept(tab.id))
  expect(accepted).toHaveBeenCalledTimes(1)
  expect(current.states.tab?.message).toContain('Workspace copies are unchanged')
  expect(current.states.tab?.used).toBe(true)
})

it('revokes a review at SSH loss and admits a fresh independent Personal review while disconnected', async () => {
  const remote = hostPath(asHostId('ssh:fixture'), '/workspace')
  const connected = projectState(remote)
  const disconnected = {
    ...connected,
    connectionState: 'disconnected' as const,
    projects: connected.projects.map((project) => ({
      ...project,
      connectionState: 'disconnected' as const,
    })),
  }
  await render({ project: connected })
  const original = invoke.getMockImplementation()!
  let finish!: (value: unknown) => void
  invoke.mockImplementation((channel, request) =>
    channel === 'skillager:review'
      ? new Promise((resolve) => {
          finish = resolve
        })
      : original(channel, request),
  )
  let pending!: Promise<void>
  act(() => {
    pending = current.review(tab)
  })
  await render({ project: disconnected })
  await act(async () => {
    finish({ ok: true, value: detail })
    await pending
  })
  expect(current.states.tab).toBeUndefined()
  expect(invoke).toHaveBeenCalledWith('skillager:release-review', {
    reviewId: detail.reviewId,
  })
  invoke.mockImplementation(original)
  await act(async () => current.review(tab))
  expect(current.states.tab?.detail).toEqual(detail)
  expect(invoke).toHaveBeenLastCalledWith(
    'skillager:review',
    expect.objectContaining({ workspaceRoot: remote }),
  )
})

it('closes a pending review without allowing a late response to restore content', async () => {
  let finish!: (value: unknown) => void
  invoke.mockImplementation((channel) =>
    channel === 'skillager:review'
      ? new Promise((resolve) => {
          finish = resolve
        })
      : Promise.resolve(),
  )
  await render()
  let pending!: Promise<void>
  act(() => {
    pending = current.review(tab)
  })
  await render({ open: false })
  expect(
    invoke.mock.calls.some(([channel]) => channel === 'skillager:cancel-review'),
  ).toBe(true)
  await act(async () => {
    finish({ ok: true, value: detail })
    await pending
  })
  expect(current.states.tab).toBeUndefined()
  expect(invoke).toHaveBeenCalledWith('skillager:release-review', { reviewId: 'review' })
})

it('does not let a failed obsolete diff overwrite a newer file selection', async () => {
  await render()
  await act(async () => current.review(tab))
  let failDiff!: (error: Error) => void
  invoke.mockImplementation((channel) =>
    channel === 'skillager:review-diff'
      ? new Promise((_resolve, reject) => {
          failDiff = reject
        })
      : Promise.resolve({
          ok: true,
          value: {
            entry: 'SKILL.md',
            path: localPath('/library/skills/example/SKILL.md'),
            size: 10,
            text: '# Reviewed',
          },
        }),
  )
  let pending!: Promise<void>
  act(() => {
    pending = current.diff(tab.id)
  })
  await act(async () => current.content(tab.id, 'SKILL.md'))
  await act(async () => {
    failDiff(new Error('old transport failure'))
    await pending
  })
  expect(current.states.tab?.content?.text).toBe('# Reviewed')
  expect(current.states.tab?.message).toBeUndefined()
  expect(current.states.tab?.loading).toBe(false)
})

it('revokes retained review content when disconnected and leaves uncertain confirmation consumed', async () => {
  await render()
  await act(async () => current.review(tab))
  invoke.mockImplementation((channel) =>
    Promise.resolve(
      channel === 'skillager:accept-review'
        ? { ok: false, reason: 'uncertain', message: 'Refresh before another review.' }
        : undefined,
    ),
  )
  await act(async () => current.accept(tab.id))
  expect(current.states.tab).toMatchObject({ used: true, failed: true })
  expect(accepted).toHaveBeenCalledTimes(1)
  await render({ connected: false })
  expect(current.states).toEqual({})
  expect(invoke).toHaveBeenCalledWith('skillager:release-review', { reviewId: 'review' })
})

it.each(['checking', 'stale', 'unavailable', 'destination'] as const)(
  'keeps an existing review usable when update admission fails for %s',
  async (reason) => {
    await render({ project: reason === 'destination' ? undefined : projectState(root) })
    await act(async () => current.review(tab))
    const retained = current.states.tab?.detail
    invoke.mockClear()
    const candidate: SkillagerDetailTab = {
      ...tab,
      metadata: {
        ...tab.metadata,
        trust: 'reviewed',
        contentHash: detail.hash,
        workspaceFreshness: reason === 'destination' ? 'fresh' : reason,
        workspace: {
          agent: 'codex' as const,
          id: 'lib-example',
          skillId: tab.metadata.id,
          mode: 'native',
          target: localPath('/workspace/.agents/skills/lib-example'),
          status: 'source_update',
          expectedSourceHash: detail.hash,
        },
      },
    }
    await act(async () => current.review(candidate, true))
    expect(current.states.tab?.detail).toBe(retained)
    expect(invoke).not.toHaveBeenCalled()
    await act(async () => current.history(tab))
    expect(invoke).toHaveBeenCalledWith(
      'skillager:history',
      expect.objectContaining({ requestId: 1 }),
    )
    await act(async () => current.accept(tab.id))
    expect(invoke).toHaveBeenCalledWith(
      'skillager:accept-review',
      expect.objectContaining({ reviewId: detail.reviewId }),
    )
  },
)

it('binds a Claude copy update and every reused review operation to its concrete agent with Codex setup selected', async () => {
  const selected: SkillagerDetailTab = {
    ...tab,
    metadata: {
      ...tab.metadata,
      trust: 'reviewed',
      contentHash: detail.hash,
      workspaceFreshness: 'fresh',
      workspace: {
        agent: 'claude',
        id: 'lib-example',
        skillId: tab.metadata.id,
        mode: 'stub',
        target: localPath('/workspace/.claude/skills/lib-example'),
        status: 'source_update',
        expectedSourceHash: detail.hash,
      },
    },
  }
  const original = invoke.getMockImplementation()!
  invoke.mockImplementation((channel, request) =>
    channel === 'skillager:review-content'
      ? Promise.resolve({
          ok: true,
          value: {
            entry: 'SKILL.md',
            path: localPath('/library/skills/example/SKILL.md'),
            size: 10,
            text: '# Guide',
          },
        })
      : channel === 'skillager:review-diff'
        ? Promise.resolve({
            ok: true,
            value: { toHash: detail.hash, text: 'Reviewed diff' },
          })
        : original(channel, request),
  )
  await render({ project: projectState(root), openTabs: [selected] })
  await act(async () => current.review(selected, true))
  expect(
    invoke.mock.calls.find(([channel]) => channel === 'skillager:review')?.[1],
  ).toMatchObject({
    agent: 'claude',
    update: { agent: 'claude', exposure: selected.metadata.workspace },
  })
  await act(async () => current.history(selected))
  await act(async () => current.content(selected.id, 'SKILL.md'))
  await act(async () => current.diff(selected.id))
  expect(current.states.tab?.failed).not.toBe(true)
  await act(async () => current.accept(selected.id))
  for (const channel of [
    'skillager:history',
    'skillager:review-content',
    'skillager:review-diff',
    'skillager:accept-review',
  ])
    expect(invoke).toHaveBeenCalledWith(
      channel,
      expect.objectContaining({ agent: 'claude', requestId: 1 }),
    )
  expect(
    invoke.mock.calls.filter(([channel]) => channel === 'skillager:review'),
  ).toHaveLength(1)
})

const secondTab: SkillagerDetailTab = {
  ...tab,
  id: 'second',
  metadata: { ...tab.metadata, id: 'lib/second' },
}
const bothTabs = [tab, secondTab]
it('changing active selection releases completed review content/confirmation without closing metadata tabs or restoring it on return', async () => {
  const original = invoke.getMockImplementation()!
  invoke.mockImplementation((channel, request) =>
    channel === 'skillager:review-content'
      ? Promise.resolve({
          ok: true,
          value: {
            entry: 'SKILL.md',
            path: localPath('/library/skills/example/SKILL.md'),
            size: 20,
            text: 'PRIVATE reviewed body',
          },
        })
      : original(channel, request),
  )
  await render({ openTabs: bothTabs })
  await act(async () => current.review(tab))
  await act(async () => current.content(tab.id, 'SKILL.md'))
  await act(async () => current.accept(tab.id))
  expect(current.states.tab).toMatchObject({
    content: { text: 'PRIVATE reviewed body' },
    used: true,
  })
  await render({ openTabs: bothTabs, activeId: secondTab.id })
  expect(current.states).toEqual({})
  expect(invoke).toHaveBeenCalledWith('skillager:release-review', {
    reviewId: detail.reviewId,
  })
  expect(invoke).toHaveBeenCalledWith('skillager:cancel-review', { requestId: 1 })
  invoke.mockClear()
  await act(async () => current.review(tab))
  await act(async () => current.accept(tab.id))
  expect(invoke).not.toHaveBeenCalled()
  await render({ openTabs: bothTabs, activeId: tab.id })
  expect(current.states).toEqual({})
  expect(invoke).not.toHaveBeenCalled()
  await act(async () => current.review(tab))
  expect(current.states.tab?.detail).toEqual(detail)
  expect(invoke).toHaveBeenCalledWith(
    'skillager:review',
    expect.objectContaining({ requestId: 2 }),
  )
})

it('selection changes release late successful review leases and discard in-flight content even after returning to the original metadata tab', async () => {
  const original = invoke.getMockImplementation()!
  let resolveReview!: (result: unknown) => void
  invoke.mockImplementation((channel, request) =>
    channel === 'skillager:review'
      ? new Promise((resolve) => {
          resolveReview = resolve
        })
      : original(channel, request),
  )
  await render({ openTabs: bothTabs })
  let pending!: Promise<void>
  act(() => {
    pending = current.review(tab)
  })
  await render({ openTabs: bothTabs, activeId: secondTab.id })
  await render({ openTabs: bothTabs, activeId: tab.id })
  await act(async () => {
    resolveReview({ ok: true, value: detail })
    await pending
  })
  expect(current.states).toEqual({})
  expect(invoke).toHaveBeenCalledWith('skillager:release-review', {
    reviewId: detail.reviewId,
  })
  invoke.mockImplementation(original)
  await act(async () => current.review(tab))
  let resolveContent!: (result: unknown) => void
  invoke.mockImplementation((channel, request) =>
    channel === 'skillager:review-content'
      ? new Promise((resolve) => {
          resolveContent = resolve
        })
      : original(channel, request),
  )
  act(() => {
    pending = current.content(tab.id, 'SKILL.md')
  })
  await render({ openTabs: bothTabs, activeId: secondTab.id })
  await render({ openTabs: bothTabs, activeId: tab.id })
  await act(async () => {
    resolveContent({
      ok: true,
      value: {
        entry: 'SKILL.md',
        path: localPath('/library/skills/example/SKILL.md'),
        size: 10,
        text: 'PRIVATE late content',
      },
    })
    await pending
  })
  expect(current.states).toEqual({})
  expect(
    invoke.mock.calls.filter(([channel]) => channel === 'skillager:release-review'),
  ).toHaveLength(2)
})
