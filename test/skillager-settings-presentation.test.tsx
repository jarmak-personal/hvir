// @vitest-environment happy-dom
import { act } from 'react'
import { createRoot } from 'react-dom/client'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { SkillagerSettings } from '../src/renderer/src/skillager/SkillagerSettings'
import type { SkillagerController } from '../src/renderer/src/skillager/use-skillager-workspace'
import { getAppSettings } from '../src/renderer/src/settings/settings'
import { localPath } from '../src/shared/host-path'

let mount: HTMLDivElement, root: ReturnType<typeof createRoot>
const settings = { ...getAppSettings(), interfaceScale: 1.25 }
const update = vi.fn(),
  check = vi.fn(),
  disconnect = vi.fn()
function render(enabled: boolean) {
  const controller = {
    enabled,
    probing: false,
    check,
    disconnect,
    connection: {
      connectionId: 'connected',
      version: 'fixture CLI',
      executable: localPath('/tools/skillager'),
      library: {
        id: 'library',
        root: localPath('/personal/library'),
        skillsRoot: localPath('/personal/library/skills'),
      },
    },
  } as unknown as SkillagerController
  act(() =>
    root.render(
      <SkillagerSettings
        controller={controller}
        settings={settings}
        onSettings={update}
      />,
    ),
  )
}
beforeEach(() => {
  mount = document.createElement('div')
  document.body.append(mount)
  root = createRoot(mount)
  update.mockClear()
  check.mockClear()
  disconnect.mockClear()
})
afterEach(() => {
  act(() => root.unmount())
  mount.remove()
})
it('keeps only the labeled checkbox while disabled and preserves existing settings when toggled', () => {
  render(false)
  expect(mount.textContent).toBe('SkillagerEnable Skillager')
  expect(mount.querySelectorAll('button, input, select, details')).toHaveLength(1)
  const control = mount.querySelector<HTMLInputElement>('#skillager-enabled')!
  expect(control.closest('label')?.textContent).toBe('Enable Skillager')
  act(() => control.click())
  expect(update).toHaveBeenCalledWith({ ...settings, skillagerEnabled: true })
  expect(check).not.toHaveBeenCalled()
})
it('keeps connected status compact and exact connection/executable facts inside collapsed details', () => {
  render(true)
  expect(mount.querySelector('.skillager-connection-summary')?.textContent).toBe(
    'Personal libraryDisconnect',
  )
  expect(mount.querySelector('.skillager-connection-summary')?.textContent).not.toContain(
    '/personal',
  )
  const details = mount.querySelector<HTMLDetailsElement>(
    '.skillager-connection-details',
  )!
  expect(details.open).toBe(false)
  expect(details.textContent).toContain('/personal/library')
  expect(details.textContent).toContain('/tools/skillager')
  expect(details.textContent).toContain('fixture CLI')
  expect(
    mount.querySelector<HTMLDetailsElement>('.skillager-executable-details')!.open,
  ).toBe(false)
  expect(mount.querySelector('label button, label details')).toBeNull()
  act(() =>
    mount
      .querySelector<HTMLButtonElement>('.skillager-connection-summary button')!
      .click(),
  )
  expect(disconnect).toHaveBeenCalledOnce()
  expect(check).not.toHaveBeenCalled()
})
