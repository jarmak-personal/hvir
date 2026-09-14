import { localPath, type HostPath } from '../src/shared/host-path'
// @vitest-environment happy-dom
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import {
  useSkillagerLibrarySync,
  type SkillagerLibrarySyncController,
} from '../src/renderer/src/skillager/use-skillager-library-sync'
import {
  SkillagerSyncAction,
  SkillagerSyncProgress,
  SkillagerLibraryMenu,
} from '../src/renderer/src/skillager/SkillagerLibrarySync'
import { SkillagerLineage } from '../src/renderer/src/skillager/SkillagerLineage'
import {
  syncContext,
  syncSelection,
  syncStatus,
  syncCompletion,
} from './fixtures/skillager-sync-fixture'
const invoke = vi.fn<(channel: string, request: unknown) => Promise<unknown>>(),
  completed = vi.fn()
let element: HTMLDivElement, react: Root, current: SkillagerLibrarySyncController
function Harness({
  root = syncContext,
  visible = true,
  menu = false,
}: {
  root?: HostPath
  visible?: boolean
  menu?: boolean
}) {
  current = useSkillagerLibrarySync({
    root,
    connection: {
      connectionId: 'connected',
      executable: syncSelection.executable,
      version: syncSelection.version,
      library: syncSelection.library,
    },
    agent: 'codex',
    visible,
    onCompleted: completed,
  })
  return (
    <>
      {menu ? (
        <SkillagerLibraryMenu controller={current} />
      ) : (
        <SkillagerSyncAction controller={current} />
      )}
      <SkillagerSyncProgress controller={current} local={true} />
      <SkillagerLineage
        controller={current}
        metadata={{
          id: 'lib/example',
          name: 'Example',
          description: '',
          source: {
            type: 'collection',
            ownership: 'library',
            libraryId: syncSelection.library.id,
          },
          trust: 'reviewed',
          exposure: 'hidden',
          tags: [],
          matchReasons: [],
        }}
      />
    </>
  )
}
async function render(props: Parameters<typeof Harness>[0] = {}) {
  await act(() => Promise.resolve(react.render(<Harness {...props} />)))
}
function button(text: string) {
  return [...document.querySelectorAll('button')].find(
    (button) => button.textContent === text,
  )!
}
async function click(text: string) {
  await act(() => Promise.resolve(button(text).click()))
}
beforeEach(() => {
  element = document.createElement('div')
  document.body.append(element)
  react = createRoot(element)
  Object.assign(window, { hvir: { invoke } })
  invoke.mockReset()
  completed.mockReset()
  invoke.mockImplementation((channel) =>
    Promise.resolve(
      channel === 'skillager:sync-status'
        ? {
            ok: true,
            value: {
              report: syncStatus(),
              observationId: 'main-observed',
              requiresNewSync: false,
            },
          }
        : channel === 'skillager:sync-approved'
          ? { ok: true, value: syncCompletion() }
          : undefined,
    ),
  )
})
afterEach(async () => {
  await act(() => Promise.resolve(react.unmount()))
  element.remove()
})
it('does no sync observation or mutation on mount and performs one explicit check then apply', async () => {
  await render()
  expect(invoke).not.toHaveBeenCalled()
  await click('Sync approved skills')
  expect(invoke.mock.calls.map(([channel]) => channel)).toEqual([
    'skillager:sync-status',
    'skillager:sync-approved',
    'skillager:cancel-sync',
  ])
  expect(invoke.mock.calls[1]![1]!).toMatchObject({
    observationId: 'main-observed',
    workspaceRoot: syncContext,
    requestId: 2,
  })
  expect(element.textContent).toContain('1 created')
  expect(completed).toHaveBeenCalledOnce()
})
it.each(['cancel', 'workspace', 'disable'])(
  'cannot continue into apply after %s during the check',
  async (action) => {
    let resolve!: (value: unknown) => void
    invoke.mockImplementationOnce(
      () =>
        new Promise((finish) => {
          resolve = finish
        }),
    )
    await render()
    let task!: Promise<void>
    await act(() => {
      task = current.sync()
      return Promise.resolve()
    })
    expect(element.textContent).toContain('Checking approved skills…')
    if (action === 'cancel') await click('Cancel sync')
    else
      await render(
        action === 'workspace' ? { root: localPath('/other') } : { visible: false },
      )
    await act(async () => {
      resolve({
        ok: true,
        value: { report: syncStatus(), observationId: 'late', requiresNewSync: false },
      })
      await task
    })
    expect(
      invoke.mock.calls.some(([channel]) => channel === 'skillager:sync-approved'),
    ).toBe(false)
  },
)
it('requires a separate check and then a new Sync gesture after uncertain completion', async () => {
  invoke.mockImplementation((channel) =>
    Promise.resolve(
      channel === 'skillager:sync-status'
        ? {
            ok: true,
            value: {
              report: syncStatus(),
              observationId: 'main-observed',
              requiresNewSync:
                invoke.mock.calls.filter(([kind]) => kind === 'skillager:sync-status')
                  .length === 2,
            },
          }
        : channel === 'skillager:sync-approved'
          ? {
              ok: false,
              reason: 'uncertain',
              message: 'Check current state before another sync.',
            }
          : undefined,
    ),
  )
  await render()
  await click('Sync approved skills')
  expect(current.state.uncertain).toBe(true)
  await click('Check current state')
  expect(
    invoke.mock.calls.filter(([channel]) => channel === 'skillager:sync-approved'),
  ).toHaveLength(1)
  expect(current.state.uncertain).toBe(false)
  expect(element.textContent).toContain('Choose Sync approved skills')
  await click('Sync approved skills')
  expect(
    invoke.mock.calls.filter(([channel]) => channel === 'skillager:sync-approved'),
  ).toHaveLength(2)
})
it('a main-retained uncertainty survives a fresh renderer and stops its initial gesture after checking', async () => {
  invoke.mockResolvedValueOnce({
    ok: true,
    value: { report: syncStatus(), observationId: 'reconciled', requiresNewSync: true },
  })
  await render()
  await click('Sync approved skills')
  expect(
    invoke.mock.calls.some(([channel]) => channel === 'skillager:sync-approved'),
  ).toBe(false)
  expect(element.textContent).toContain('Current state checked')
})
it('keeps failed or incomplete observations from enabling apply', async () => {
  invoke.mockResolvedValueOnce({
    ok: true,
    value: {
      report: {
        ...syncStatus(),
        coverage: { ...syncStatus().coverage, complete: false },
      },
      requiresNewSync: false,
    },
  })
  await render()
  await click('Sync approved skills')
  expect(
    invoke.mock.calls.some(([channel]) => channel === 'skillager:sync-approved'),
  ).toBe(false)
})
it('offers a compact library menu with keyboard dismissal and focus restoration', async () => {
  await render({ menu: true })
  const trigger = element.querySelector<HTMLButtonElement>(
    '[aria-label="Your library actions"]',
  )!
  await act(() => Promise.resolve(trigger.click()))
  expect(document.querySelector('[role="menu"]')).not.toBeNull()
  expect(document.activeElement?.textContent).toBe('Sync approved skills')
  trigger.focus()
  const outsideArrow = new KeyboardEvent('keydown', {
    key: 'ArrowDown',
    bubbles: true,
    cancelable: true,
  })
  document.dispatchEvent(outsideArrow)
  expect(outsideArrow.defaultPrevented).toBe(false)
  expect(document.activeElement).toBe(trigger)
  await act(() =>
    document.dispatchEvent(
      new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }),
    ),
  )
  expect(document.querySelector('[role="menu"]')).toBeNull()
  expect(document.activeElement).toBe(trigger)
  await act(() => Promise.resolve(trigger.click()))
  await act(() =>
    Promise.resolve(
      void document.body.dispatchEvent(
        new PointerEvent('pointerdown', { bubbles: true }),
      ),
    ),
  )
  expect(document.querySelector('[role="menu"]')).toBeNull()
  const afterDismiss = new KeyboardEvent('keydown', {
    key: 'ArrowDown',
    bubbles: true,
    cancelable: true,
  })
  document.dispatchEvent(afterDismiss)
  expect(afterDismiss.defaultPrevented).toBe(false)
  expect(invoke).not.toHaveBeenCalled()
})
it('preserves all 5000 outcomes with bounded rendering and selected lineage metadata', async () => {
  const complete = syncCompletion(),
    item = complete.items[0]!
  invoke.mockImplementation((channel) =>
    Promise.resolve(
      channel === 'skillager:sync-status'
        ? {
            ok: true,
            value: {
              report: syncStatus(),
              observationId: 'main',
              requiresNewSync: false,
            },
          }
        : channel === 'skillager:sync-approved'
          ? {
              ok: true,
              value: {
                ...complete,
                counts: { ...complete.counts, created: 5000 },
                coverage: {
                  ...complete.coverage,
                  selectedSources: 5000,
                  processedSources: 5000,
                },
                items: Array.from({ length: 5000 }, (_, index) => ({
                  ...item,
                  sourceIdentity: `source-${index}`,
                  canonicalSkillId: `lib/skill-${index}`,
                })),
              },
            }
          : undefined,
    ),
  )
  await render()
  await click('Sync approved skills')
  expect(current.state.completion?.items).toHaveLength(5000)
  expect(element.querySelectorAll('.skillager-sync-items li')).toHaveLength(50)
  expect(element.textContent).not.toContain('lib/skill-50 ·')
  await click('Next')
  expect(element.textContent).toContain('lib/skill-50')
  expect(element.querySelectorAll('.skillager-sync-items li')).toHaveLength(50)
  await click('Check library lineage')
  expect(element.textContent).toContain('Approved in its original project')
  expect(element.textContent).toContain('lib/example · accepted · reviewed')
})
