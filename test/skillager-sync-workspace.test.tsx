// @vitest-environment happy-dom
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import {
  useSkillagerWorkspace,
  type SkillagerController,
} from '../src/renderer/src/skillager/use-skillager-workspace'
import { SkillagerDetails } from '../src/renderer/src/skillager/SkillagerDetails'
import { localPath, type HostPath } from '../src/shared/host-path'
import type { SkillagerMetadata } from '../src/shared/skillager'
import { projectState } from './fixtures/skillager-exposure-fixture'
import {
  syncContext,
  syncSelection,
  syncStatus,
  syncCompletion,
} from './fixtures/skillager-sync-fixture'

const invoke = vi.fn<(channel: string, request: unknown) => Promise<unknown>>()
const rows: SkillagerMetadata[] = ['first', 'second'].map((name) => ({
  id: `lib/${name}`,
  name,
  description: '',
  trust: 'reviewed',
  source: {
    type: 'collection',
    ownership: 'library',
    libraryId: syncSelection.library.id,
  },
  exposure: 'hidden',
  tags: [],
  matchReasons: [],
}))
let container: HTMLDivElement, react: Root, current: SkillagerController
function Harness({ root = syncContext }: { readonly root?: HostPath }) {
  current = useSkillagerWorkspace({
    enabled: true,
    projectState: projectState(root),
    sidebarVisible: true,
    viewerVisible: true,
    onActivate: () => undefined,
    onDisabled: () => undefined,
  })
  return current.active ? (
    <SkillagerDetails
      metadata={current.active.metadata}
      librarySync={current.librarySync}
    />
  ) : null
}
async function render(root = syncContext) {
  await act(() => Promise.resolve(react.render(<Harness root={root} />)))
}
function result(channel: string) {
  if (channel === 'skillager:probe')
    return { ok: true, value: { ...syncSelection, probeId: 'probe' } }
  if (channel === 'skillager:connect')
    return { ok: true, value: { ...syncSelection, connectionId: 'connected' } }
  if (channel === 'skillager:inventory' || channel === 'skillager:project-metadata')
    return {
      ok: true,
      value: { rows, checkedAt: Date.now(), durationMs: 1, exposures: [] },
    }
  if (channel === 'skillager:sync-status')
    return {
      ok: true,
      value: {
        report: syncStatus(),
        observationId: 'main-observation',
        requiresNewSync: false,
      },
    }
  if (channel === 'skillager:sync-approved') return { ok: true, value: syncCompletion() }
  return undefined
}
beforeEach(() => {
  vi.spyOn(document, 'hasFocus').mockReturnValue(true)
  container = document.createElement('div')
  document.body.append(container)
  react = createRoot(container)
  invoke.mockReset().mockImplementation((channel) => Promise.resolve(result(channel)))
  Object.assign(window, { hvir: { invoke } })
})
afterEach(async () => {
  await act(() => Promise.resolve(react.unmount()))
  container.remove()
  vi.restoreAllMocks()
})
it.each(['checking', 'syncing'] as const)(
  'selects another real detail during %s without interrupting library sync',
  async (phase) => {
    await render()
    await act(() => current.connect())
    expect(current.connection).toBeDefined()
    await act(() => Promise.resolve(current.select(rows[0]!)))
    const delayed =
      phase === 'checking' ? 'skillager:sync-status' : 'skillager:sync-approved'
    let finish!: (value: unknown) => void
    invoke.mockImplementation((channel) =>
      channel === delayed
        ? new Promise((resolve) => {
            finish = resolve
          })
        : Promise.resolve(result(channel)),
    )
    let pending!: Promise<void>
    await act(() => {
      pending = current.librarySync.sync()
      return Promise.resolve()
    })
    expect(current.librarySync.state.busy).toBe(phase)
    await act(() => Promise.resolve(current.select(rows[1]!)))
    expect(current.active?.metadata.id).toBe('lib/second')
    expect(container.querySelector('h1')?.textContent).toBe('second')
    expect(current.librarySync.state.busy).toBe(phase)
    expect(
      invoke.mock.calls.some(([channel]) => channel === 'skillager:cancel-sync'),
    ).toBe(false)
    await act(async () => {
      finish(result(delayed))
      await pending
    })
    expect(current.active?.metadata.id).toBe('lib/second')
    expect(current.librarySync.state.completion?.counts.created).toBe(1)
    expect(current.librarySync.state.uncertain).toBe(false)
    expect(
      invoke.mock.calls.filter(([channel]) => channel === 'skillager:sync-approved'),
    ).toHaveLength(1)
  },
)
it.each(['checking', 'syncing'] as const)(
  'changing the actual workspace during %s cancels and ignores late output',
  async (phase) => {
    await render()
    await act(() => current.connect())
    const delayed =
      phase === 'checking' ? 'skillager:sync-status' : 'skillager:sync-approved'
    let finish!: (value: unknown) => void
    invoke.mockImplementation((channel) =>
      channel === delayed
        ? new Promise((resolve) => {
            finish = resolve
          })
        : Promise.resolve(result(channel)),
    )
    let pending!: Promise<void>
    await act(() => {
      pending = current.librarySync.sync()
      return Promise.resolve()
    })
    expect(current.librarySync.state.busy).toBe(phase)
    await render(localPath('/other-workspace'))
    expect(
      invoke.mock.calls.some(([channel]) => channel === 'skillager:cancel-sync'),
    ).toBe(true)
    await act(async () => {
      finish(result(delayed))
      await pending
    })
    expect(current.librarySync.state.completion).toBeUndefined()
    expect(
      invoke.mock.calls.filter(([channel]) => channel === 'skillager:sync-approved'),
    ).toHaveLength(phase === 'checking' ? 0 : 1)
  },
)
