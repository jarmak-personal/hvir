// @vitest-environment happy-dom
import { act, createElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, expect, it, vi } from 'vitest'
import { ExtensionsSettings } from '../src/renderer/src/settings/sections/ExtensionsSettings'
import type { ExtensionPlatformState } from '../src/shared/extensions/workbench'
import { localPath } from '../src/shared/host-path'

let root: Root, element: HTMLDivElement
const first = {
  source: 'first',
  enabled: false,
  warnings: [],
  error: 'Invalid first package',
}
const second = {
  source: 'second',
  enabled: false,
  warnings: [],
  error: 'Invalid second package',
}
const state: ExtensionPlatformState = { writable: true, installations: [first, second] }
const retained = {
  id: 'retained',
  installation: 'removed',
  outcome: 'completion-unproven',
  target: localPath('/owned/target'),
  staging: localPath('/owned/staging'),
  preserved: localPath('/owned/preserved'),
}
afterEach(() => {
  if (root) act(() => root.unmount())
  element?.remove()
  vi.unstubAllGlobals()
})
async function render(initial = state) {
  let publish!: (next: ExtensionPlatformState) => void
  let records: unknown = []
  let cleanup: Promise<unknown> = Promise.resolve({ outcome: 'completed' })
  let inspect: Promise<unknown> = Promise.resolve({
    token: 'exact',
    objects: [],
    completion: 'unproven',
  })
  const invoke = vi.fn((channel: string, input?: { kind?: string }) => {
    if (channel === 'extensions:delivery-recovery')
      return records instanceof Error ? Promise.reject(records) : Promise.resolve(records)
    if (channel === 'extensions:delivery-resolve' && input?.kind === 'inspect')
      return inspect
    if (channel === 'extensions:delivery-resolve' && input?.kind === 'cleanup')
      return cleanup
    if (channel === 'agent:access')
      return Promise.resolve({
        enabled: false,
        ready: true,
        extensions: [],
        forwards: [],
        extensionsWritable: true,
      })
    return Promise.resolve(initial)
  })
  vi.stubGlobal('hvir', {
    invoke,
    on: (channel: string, listener: typeof publish) => {
      if (channel === 'extensions:state-changed') publish = listener
      return () => {}
    },
  })
  element = document.createElement('div')
  document.body.append(element)
  root = createRoot(element)
  await act(async () => {
    root.render(createElement(ExtensionsSettings))

    await Promise.resolve()
  })
  return {
    invoke,
    publish: (next: ExtensionPlatformState) =>
      act(async () => {
        publish(next)
        await Promise.resolve()
      }),
    records: (value: unknown) => {
      records = value
    },
    cleanup: (value: Promise<unknown>) => {
      cleanup = value
    },
    inspect: (value: Promise<unknown>) => {
      inspect = value
    },
  }
}
const shared = () =>
  element.querySelector<HTMLButtonElement>('[aria-label="Extension settings"]')!
const pane = () => element.querySelector<HTMLElement>('.extension-shared-settings')!
const selected = () =>
  element.querySelector('.extension-installation-list [aria-current=true]')
const button = (text: string) =>
  [...element.querySelectorAll<HTMLButtonElement>('button')].find(
    (e) => e.textContent === text,
  )!
const click = (control: HTMLElement) =>
  act(async () => {
    control.click()
    await Promise.resolve()
  })

it('keeps shared controls independent, preserves chosen shared navigation through publications and falls back there on removal', async () => {
  const fixture = await render()
  expect(pane().hidden).toBe(true)
  await click(shared())
  expect(pane().hidden).toBe(false)
  expect(element.querySelector('.extension-installation')).toBeNull()
  expect(pane().textContent).toContain('Allow agents to inspect')
  expect(pane().textContent).toContain('Author and discovery controls')
  await fixture.publish({ ...state, installations: [second, first] })
  expect(selected()).toBe(shared())
  await click(element.querySelector<HTMLElement>('[data-source="second"]')!)
  expect(element.querySelector('.extension-installation')?.textContent).toContain(
    'Invalid second package',
  )
  await fixture.publish({ ...state, installations: [first] })
  expect(selected()).toBe(shared())
  expect(pane().hidden).toBe(false)
  await fixture.publish({ writable: true, installations: [] })
  expect(selected()).toBe(shared())
  expect(button('Add extension…').disabled).toBe(false)
  expect(pane().querySelector('.agent-access-settings')).not.toBeNull()
})

it('arrows select entries without invoking the pinned Add picker; explicit Add still invokes it once', async () => {
  const fixture = await render()
  await click(shared())
  const key = async (name: string) =>
    act(
      async () =>
        await Promise.resolve(
          selected()!.dispatchEvent(
            new KeyboardEvent('keydown', { key: name, bubbles: true }),
          ),
        ),
    )
  await key('End')
  expect(selected()?.getAttribute('data-source')).toBe('second')
  await key('ArrowDown')
  expect(selected()).toBe(shared())
  await key('ArrowUp')
  expect(selected()?.getAttribute('data-source')).toBe('second')
  await key('Home')
  expect(selected()).toBe(shared())
  expect(document.activeElement).toBe(shared())
  expect(
    fixture.invoke.mock.calls.filter(([channel]) => channel === 'extensions:add'),
  ).toHaveLength(0)
  expect(
    element
      .querySelector('.extension-installation-list')!
      .contains(button('Add extension…')),
  ).toBe(false)
  expect(element.querySelectorAll('.extension-add-action')).toHaveLength(1)
  await click(button('Add extension…'))
  expect(
    fixture.invoke.mock.calls.filter(([channel]) => channel === 'extensions:add'),
  ).toHaveLength(1)
})

it.each([{ installations: [] }, { installations: [first] }])(
  'keeps errors and global access reachable when installation state cannot be written',
  async ({ installations }) => {
    await render({
      writable: false,
      explanation: 'Close the other hvir instance',
      installations,
    })
    await click(shared())
    expect(element.querySelector('[role=status]')?.textContent).toBe(
      'Close the other hvir instance',
    )
    expect(pane().hidden).toBe(false)
    expect(button('Add extension…').disabled).toBe(true)
  },
)

it('reports retained deliveries and observation errors while installed settings are selected', async () => {
  const fixture = await render()
  fixture.records([retained])
  await fixture.publish({ ...state })
  expect(pane().hidden).toBe(true)
  expect(shared().textContent).toContain('1 to inspect')
  const description = shared().getAttribute('aria-describedby')!
  expect(document.getElementById(description)?.textContent).toBe('1 to inspect')
  expect(shared().querySelector('[role=status]')).toBeNull()
  fixture.records(new Error('Recovery records unavailable'))
  await fixture.publish({ ...state })
  expect(shared().textContent).toContain('Recovery needs attention')
  expect(document.getElementById(description)?.textContent).toBe(
    'Recovery needs attention',
  )
  await click(shared())
  expect(pane().textContent).toContain('Recovery records unavailable')
})

it.each(['completed', 'pending'])(
  'retires an unconfirmed %s recovery inspection when leaving shared settings',
  async (completion) => {
    const fixture = await render()
    fixture.records([retained])
    await fixture.publish({ ...state })
    await click(shared())
    let finish!: (value: unknown) => void
    if (completion === 'pending')
      fixture.inspect(
        new Promise((resolve) => {
          finish = resolve
        }),
      )
    await click(button('Inspect retained files'))
    if (completion === 'completed')
      expect(pane().textContent).toContain('Keep files and end tracking?')
    await click(element.querySelector<HTMLElement>('[data-source="first"]')!)
    if (completion === 'pending')
      await act(
        async () =>
          await Promise.resolve(
            finish({ token: 'late', objects: [], completion: 'unproven' }),
          ),
      )
    await click(shared())
    expect(pane().textContent).not.toContain('Keep files and end tracking?')
    expect(
      fixture.invoke.mock.calls.filter(([, input]) => input?.kind === 'keep'),
    ).toHaveLength(0)
  },
)

it('starts a changed settings destination at the top without jumping on a publication for the same package', async () => {
  const fixture = await render()
  const content = element.querySelector<HTMLElement>('.extension-settings-pane')!
  content.scrollTop = 120
  await fixture.publish({ ...state, installations: [{ ...first }, second] })
  expect(content.scrollTop).toBe(120)
  await click(element.querySelector<HTMLElement>('[data-source="second"]')!)
  expect(content.scrollTop).toBe(0)
  content.scrollTop = 240
  await click(shared())
  expect(content.scrollTop).toBe(0)
})

it('keeps the initially empty shared destination and its inspection when an installation appears', async () => {
  const fixture = await render({ writable: true, installations: [] })
  fixture.records([retained])
  await fixture.publish({ writable: true, installations: [] })
  await click(button('Inspect retained files'))
  expect(pane().textContent).toContain('Keep files and end tracking?')
  await fixture.publish(state)
  expect(selected()).toBe(shared())
  expect(pane().hidden).toBe(false)
  expect(pane().textContent).toContain('Keep files and end tracking?')
  expect(element.querySelector('.extension-installation')).toBeNull()
})

it.each(['success', 'failure'])(
  'preserves submitted cleanup and attention while visiting installed settings: %s',
  async (completion) => {
    const fixture = await render()
    fixture.records([retained])
    await fixture.publish({ ...state })
    await click(shared())
    let finish!: (result: unknown) => void, fail!: (reason: Error) => void
    const pending = new Promise((resolve, reject) => {
      finish = resolve
      fail = reject
    })
    fixture.cleanup(pending)
    await click(button('Remove saved staging and old copies'))
    await click(element.querySelector<HTMLElement>('[data-source="first"]')!)
    expect(pane().hidden).toBe(true)
    await act(async () => {
      if (completion === 'failure') fail(new Error('Cleanup remains unproven'))
      else finish({ outcome: 'completed' })
      await pending.catch(() => {})
    })
    expect(pane().hidden).toBe(true)
    expect(shared().textContent).toContain(
      completion === 'failure' ? 'Recovery needs attention' : '1 to inspect',
    )
    await click(shared())
    expect(pane().textContent).toContain(
      completion === 'failure' ? 'Cleanup remains unproven' : 'Cleanup: completed',
    )
    expect(button('Refresh retained deliveries').disabled).toBe(false)
    expect(
      fixture.invoke.mock.calls.filter(([, input]) => input?.kind === 'cleanup'),
    ).toHaveLength(1)
  },
)
