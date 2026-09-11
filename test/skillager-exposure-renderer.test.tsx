// @vitest-environment happy-dom
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  useSkillagerExposure,
  type SkillagerExposureController,
} from '../src/renderer/src/skillager/use-skillager-exposure'
import { SkillagerActions } from '../src/renderer/src/skillager/SkillagerActions'
import { SkillagerExposureDialog } from '../src/renderer/src/skillager/SkillagerExposureDialog'
import { parseExposurePreview } from '../src/main/skillager/skillager-exposure-contract'
import {
  exposureResponse,
  projectState,
  request,
  selection,
} from './fixtures/skillager-exposure-fixture'
import type { SkillagerMetadata } from '../src/shared/skillager'

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
}: {
  visible?: boolean
  connected?: boolean
  active?: boolean
  detailId?: string
}) {
  controller = useSkillagerExposure({
    projectState: projectState(),
    agent: 'codex',
    visible,
    detailId,
    connection: connected
      ? { ...selection, connectionId: 'connection', library: selection.library }
      : undefined,
    onCompleted: completion,
  })
  return (
    <>
      <SkillagerActions metadata={metadata} controller={controller} active={active}>
        <button className="row">
          <strong>Demo</strong>
        </button>
      </SkillagerActions>
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
    expect(dialog.textContent).toContain('materialized_at: UTC installation time')
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
  it('shows an uncertain outcome once and never offers repeated confirmation', async () => {
    await open()
    invoke.mockRejectedValue(new Error('lost IPC'))
    await settle(() => button('Confirm exact changes').click())
    expect(document.querySelector('[role="alert"]')?.textContent).toContain('uncertain')
    expect(button('Confirm exact changes')).toBeUndefined()
    expect(completion).not.toHaveBeenCalled()
    expect(
      invoke.mock.calls.filter(([channel]) => channel === 'skillager:apply-exposure'),
    ).toHaveLength(1)
  })
})
