// @vitest-environment happy-dom
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { localPath } from '../src/shared/host-path'
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
}: {
  open?: boolean
  connected?: boolean
}) {
  current = useSkillagerReview({
    connection: connected ? connection : undefined,
    root,
    agent: 'codex',
    tabs: open ? tabs : [],
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
