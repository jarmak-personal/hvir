// @vitest-environment happy-dom
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  useSkillagerExposure,
  type SkillagerExposureController,
} from '../src/renderer/src/skillager/use-skillager-exposure'
import {
  SkillagerActions,
  SkillagerActionsMenu,
} from '../src/renderer/src/skillager/SkillagerActions'
import { SkillagerExposureDialog } from '../src/renderer/src/skillager/SkillagerExposureDialog'
import { parseExposurePreview } from '../src/main/skillager/skillager-exposure-contract'
import {
  exposureResponse,
  projectState,
  request,
  selection,
} from './fixtures/skillager-exposure-fixture'
import type { SkillagerMetadata } from '../src/shared/skillager'
import { asHostId, hostPath } from '../src/shared/host-path'
import type { ProjectState } from '../src/shared/workspace-types'

const metadata: SkillagerMetadata = {
  id: 'lib/demo',
  name: 'Demo',
  description: '',
  trust: 'reviewed',
  source: { type: 'collection', ownership: 'library', libraryId: 'library' },
  tags: [],
  matchReasons: [],
  exposure: 'hidden',
}
const invoke = vi.fn<(channel: string, args: unknown) => Promise<unknown>>()
let container: HTMLDivElement, root: Root, controller: SkillagerExposureController
const completion = vi.fn()
async function settle(action: () => unknown): Promise<void> {
  await act(async () => {
    await Promise.resolve(action())
  })
}
function Harness({
  visible = true,
  connected = true,
  active = true,
  detailId = 'tab',
  showFirst = true,
  projects = projectState(),
}: {
  visible?: boolean
  connected?: boolean
  active?: boolean
  detailId?: string
  showFirst?: boolean
  projects?: ProjectState
}) {
  controller = useSkillagerExposure({
    projectState: projects,
    agent: 'codex',
    visible,
    sidebarVisible: active,
    detailsVisible: visible && Boolean(detailId),
    detailId,
    connection: connected
      ? { ...selection, connectionId: 'connection', library: selection.library }
      : undefined,
    onCompleted: completion,
  })
  return (
    <>
      {showFirst ? (
        <SkillagerActions
          metadata={metadata}
          controller={controller.menu}
          surface="sidebar"
        >
          <button className="row">
            <strong>Demo</strong>
          </button>
        </SkillagerActions>
      ) : null}
      <SkillagerActions
        metadata={{ ...metadata, id: 'lib/second', name: 'Second' }}
        controller={controller.menu}
        surface="sidebar"
      >
        <button className="second-row">Second</button>
      </SkillagerActions>
      <SkillagerActions
        metadata={metadata}
        controller={controller.menu}
        surface="details"
      >
        <button className="detail-row">Detail</button>
      </SkillagerActions>
      <SkillagerActionsMenu controller={controller.menu} />
      <SkillagerExposureDialog controller={controller} />
    </>
  )
}
const button = (text: string): HTMLButtonElement =>
  [...document.querySelectorAll<HTMLButtonElement>('button')].find(
    (item) => item.textContent === text,
  )!
beforeEach(async () => {
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true })
  Object.assign(window, { hvir: { invoke } })
  invoke.mockReset()
  completion.mockReset()
  invoke.mockImplementation((channel) =>
    Promise.resolve(
      channel === 'skillager:preview-exposure'
        ? {
            ok: true,
            value: {
              ...parseExposurePreview(exposureResponse().value, selection, request)
                .detail,
              previewId: 'preview',
            },
          }
        : undefined,
    ),
  )
  container = document.createElement('div')
  document.body.append(container)
  root = createRoot(container)
  await settle(() => root.render(<Harness />))
})
afterEach(async () => {
  await settle(() => root.unmount())
  container.remove()
})
async function open(): Promise<void> {
  await settle(() => controller.start(metadata, 'add'))
  await settle(() => controller.choose({ destination: request.destination }))
  await settle(() => controller.preview())
}
describe('workspace skill action UI', () => {
  it('selects a remote worktree, forces Full mode, and discloses prerequisites and retained cleanup', async () => {
    const remote = hostPath(asHostId('ssh:fixture'), '/remote')
    const projects = projectState(remote)
    await settle(() => root.render(<Harness projects={projects} />))
    await settle(() => controller.start(metadata, 'add'))
    await settle(() =>
      controller.choose({ destination: request.destination, mode: 'stub' }),
    )
    expect(controller.state?.mode).toBe('stub')
    const destination = controller.destinations.find(
      (item) => item.root.hostId === remote.hostId,
    )!
    await settle(() => controller.choose({ destination }))
    expect(controller.state?.mode).toBe('native')
    expect(
      document.querySelector<HTMLOptionElement>('option[value="stub"]')?.disabled,
    ).toBe(true)
    expect(document.body.textContent).toContain('Stubs require a Skillager runtime')
    const preview = {
      ...parseExposurePreview(exposureResponse().value, selection, request).detail,
      previewId: 'remote-preview',
      target: hostPath(remote.hostId, '/remote/.agents/skills/lib-demo'),
      remote: {
        declarations: ['Required: EXAMPLE_ENV'],
        createdParents: [hostPath(remote.hostId, '/remote/.agents')],
        temporaryPaths: [hostPath(remote.hostId, '/remote/.agents/skills/.stage')],
      },
    }
    invoke.mockResolvedValueOnce({ ok: true, value: preview })
    await settle(() => controller.preview())
    expect(invoke).toHaveBeenLastCalledWith(
      'skillager:preview-exposure',
      expect.objectContaining({ destination, mode: 'native' }),
    )
    expect(document.body.textContent).toContain('Not checked on remote host')
    expect(document.body.textContent).toContain('Required: EXAMPLE_ENV')
    expect(document.body.textContent).toContain('ssh:fixture:/remote/.agents')
    invoke.mockResolvedValueOnce({
      ok: true,
      value: {
        status: 'exposed',
        target: preview.target,
        skillId: metadata.id,
        mode: 'native',
        notice: 'Cleanup retained. Start a fresh preview to reconcile.',
      },
    })
    await settle(() => controller.apply())
    expect(document.body.textContent).toContain(
      'Cleanup retained. Start a fresh preview to reconcile.',
    )
  })
  it('uses the same keyboard and mouse menu, restoring the actual row after nested-label Escape', async () => {
    const row = document.querySelector<HTMLButtonElement>('.row')!
    await settle(() =>
      row
        .querySelector('strong')!
        .dispatchEvent(
          new MouseEvent('contextmenu', { bubbles: true, clientX: 20, clientY: 20 }),
        ),
    )
    const labels = [...document.querySelectorAll('[role="menuitem"]')].map(
      (item) => item.textContent,
    )
    await settle(() =>
      document.dispatchEvent(
        new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }),
      ),
    )
    expect(document.activeElement).toBe(row)
    expect(document.querySelector('[role="menu"]')).toBeNull()
    await settle(() =>
      row.dispatchEvent(
        new KeyboardEvent('keydown', { key: 'F10', shiftKey: true, bubbles: true }),
      ),
    )
    expect(
      [...document.querySelectorAll('[role="menuitem"]')].map((item) => item.textContent),
    ).toEqual(labels)
    expect(document.activeElement?.textContent).toBe('Add to project…')
    await settle(() => root.render(<Harness active={false} />))
    expect(document.querySelector('[role="menu"]')).toBeNull()
  })
  it('chooses an exact nonactive worktree, displays every supporting/metadata effect and confirms only the handle', async () => {
    await open()
    expect(invoke).toHaveBeenCalledWith(
      'skillager:preview-exposure',
      expect.objectContaining({
        destination: request.destination,
        workspaceRoot: projectState().root,
      }),
    )
    const dialog = document.querySelector('[role="dialog"]')!
    expect(dialog.textContent).toContain('/other/.agents/skills/lib-demo')
    expect(dialog.textContent).toContain('support.md')
    expect(dialog.textContent).toContain('materialized_at: "UTC installation time"')
    expect(dialog.textContent).toContain('Incoming accepted source version')
    invoke.mockResolvedValue({
      ok: true,
      value: {
        status: 'exposed',
        target: request.destination.root,
        skillId: metadata.id,
        mode: 'native',
      },
    })
    await settle(() => button('Confirm exact changes').click())
    expect(invoke).toHaveBeenCalledWith('skillager:apply-exposure', {
      previewId: 'preview',
    })
    expect(completion).toHaveBeenCalledTimes(1)
    expect(button('Confirm exact changes')).toBeUndefined()
  })
  it.each(['hidden', 'disconnected', 'dismissed', 'tab-departure'])(
    'releases preview on %s and rejects late completion',
    async (kind) => {
      let finish!: (value: unknown) => void
      invoke.mockImplementation(async (channel) =>
        channel === 'skillager:preview-exposure'
          ? new Promise((resolve) => {
              finish = resolve
            })
          : undefined,
      )
      await settle(() => controller.start(metadata, 'add'))
      await settle(() => controller.choose({ destination: request.destination }))
      let pending!: Promise<void>
      await settle(() => {
        pending = controller.preview()
      })
      await settle(() => {
        if (kind === 'dismissed') controller.close()
        else
          root.render(
            <Harness
              visible={kind !== 'hidden'}
              connected={kind !== 'disconnected'}
              detailId={kind === 'tab-departure' ? 'different-tab' : 'tab'}
            />,
          )
      })
      expect(invoke).toHaveBeenCalledWith('skillager:cancel-exposure', { requestId: 1 })
      await settle(async () => {
        finish({
          ok: true,
          value: {
            ...parseExposurePreview(exposureResponse().value, selection, request).detail,
            previewId: 'late',
          },
        })
        await pending
      })
      expect(invoke).toHaveBeenCalledWith('skillager:release-exposure', {
        previewId: 'late',
      })
      expect(document.querySelector('[role="dialog"]')).toBeNull()
      expect(
        invoke.mock.calls.filter(([channel]) => channel === 'skillager:apply-exposure'),
      ).toHaveLength(0)
    },
  )
  it.each(['Cancel', 'Escape'])(
    'actually cancels read-only preview preparation with %s and rejects late publication',
    async (action) => {
      let finish!: (value: unknown) => void
      invoke.mockImplementation((channel) =>
        channel === 'skillager:preview-exposure'
          ? new Promise((resolve) => {
              finish = resolve
            })
          : Promise.resolve(),
      )
      await settle(() => controller.start(metadata, 'add'))
      await settle(() => controller.choose({ destination: request.destination }))
      await settle(() => button('Preview changes').click())
      expect(button('Cancel').disabled).toBe(false)
      expect(button('Preview changes').disabled).toBe(true)
      await settle(() =>
        action === 'Cancel'
          ? button('Cancel').click()
          : document.dispatchEvent(
              new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }),
            ),
      )
      expect(document.querySelector('[role="dialog"]')).toBeNull()
      expect(invoke).toHaveBeenCalledWith('skillager:cancel-exposure', { requestId: 1 })
      await settle(() =>
        finish({
          ok: true,
          value: {
            ...parseExposurePreview(exposureResponse().value, selection, request).detail,
            previewId: 'late-preparation',
          },
        }),
      )
      expect(document.querySelector('[role="dialog"]')).toBeNull()
      expect(invoke).toHaveBeenCalledWith('skillager:release-exposure', {
        previewId: 'late-preparation',
      })
      expect(
        invoke.mock.calls.filter(([channel]) => channel === 'skillager:apply-exposure'),
      ).toHaveLength(0)
    },
  )
  it('owns only one menu across rows and dismisses the exact hidden or departing source', async () => {
    const first = document.querySelector<HTMLButtonElement>('.row')!,
      second = document.querySelector<HTMLButtonElement>('.second-row')!
    await settle(() =>
      first.dispatchEvent(
        new KeyboardEvent('keydown', { key: 'ContextMenu', bubbles: true }),
      ),
    )
    await settle(() =>
      second.dispatchEvent(
        new KeyboardEvent('keydown', { key: 'F10', shiftKey: true, bubbles: true }),
      ),
    )
    expect(document.querySelectorAll('[role="menu"]')).toHaveLength(1)
    expect(document.querySelector('[role="menu"]')?.getAttribute('aria-label')).toBe(
      'Skill actions for Second',
    )
    await settle(() =>
      document.dispatchEvent(new KeyboardEvent('keydown', { key: 'End', bubbles: true })),
    )
    expect(document.activeElement?.textContent).toBe('Add to project…')
    await settle(() => root.render(<Harness active={false} />))
    expect(document.querySelector('[role="menu"]')).toBeNull()
    await settle(() =>
      document
        .querySelector('.detail-row')!
        .dispatchEvent(
          new KeyboardEvent('keydown', { key: 'ContextMenu', bubbles: true }),
        ),
    )
    expect(document.querySelectorAll('[role="menu"]')).toHaveLength(1)
    await settle(() => root.render(<Harness active={false} detailId="different" />))
    expect(document.querySelector('[role="menu"]')).toBeNull()
    await settle(() => root.render(<Harness />))
    await settle(() =>
      first.dispatchEvent(
        new KeyboardEvent('keydown', { key: 'ContextMenu', bubbles: true }),
      ),
    )
    await settle(() =>
      document.body.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true })),
    )
    expect(document.querySelector('[role="menu"]')).toBeNull()
  })
  it('releases the menu when its row departs or integration disconnects', async () => {
    await settle(() =>
      document
        .querySelector('.row')!
        .dispatchEvent(
          new KeyboardEvent('keydown', { key: 'ContextMenu', bubbles: true }),
        ),
    )
    expect(document.querySelector('[role="menu"]')).not.toBeNull()
    await settle(() => root.render(<Harness showFirst={false} />))
    expect(document.querySelector('[role="menu"]')).toBeNull()
    await settle(() =>
      document
        .querySelector('.second-row')!
        .dispatchEvent(
          new KeyboardEvent('keydown', { key: 'ContextMenu', bubbles: true }),
        ),
    )
    await settle(() => root.render(<Harness showFirst={false} connected={false} />))
    expect(document.querySelector('[role="menu"]')).toBeNull()
    await settle(() =>
      document
        .querySelector('.second-row')!
        .dispatchEvent(
          new KeyboardEvent('keydown', { key: 'ContextMenu', bubbles: true }),
        ),
    )
    expect(document.querySelector('[role="menu"]')).toBeNull()
  })
  it('reports a mode change as Changed to its actual mode and target', async () => {
    const selected = {
      ...metadata,
      workspace: {
        id: 'lib-demo',
        skillId: metadata.id,
        target: request.destination.root,
        mode: 'native',
        status: 'current',
      },
    }
    await settle(() => controller.start(selected, 'change'))
    await settle(() => controller.preview())
    invoke.mockResolvedValue({
      ok: true,
      value: {
        status: 'exposed',
        target: request.destination.root,
        skillId: metadata.id,
        mode: 'stub',
      },
    })
    await settle(() => button('Confirm exact changes').click())
    expect(
      document.querySelector('.skillager-exposure-dialog [role="status"]')?.textContent,
    ).toBe('Changed lib/demo to Stub at local:/other.')
  })
  it('refreshes an uncertain outcome once and never offers repeated confirmation', async () => {
    await open()
    invoke.mockRejectedValue(new Error('lost IPC'))
    await settle(() => button('Confirm exact changes').click())
    expect(document.querySelector('[role="alert"]')?.textContent).toContain('uncertain')
    expect(button('Confirm exact changes')).toBeUndefined()
    expect(completion).toHaveBeenCalledTimes(1)
    expect(
      invoke.mock.calls.filter(([channel]) => channel === 'skillager:apply-exposure'),
    ).toHaveLength(1)
  })
})
