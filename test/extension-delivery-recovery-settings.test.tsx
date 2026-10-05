// @vitest-environment happy-dom
import { act, createElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, expect, it, vi } from 'vitest'
import { DeliveryRecoverySettings } from '../src/renderer/src/settings/sections/DeliveryRecoverySettings'
import { asHostId, hostPath } from '../src/shared/host-path'
import type { DeliveryRecoveryEntry } from '../src/shared/extensions/managed-delivery'
let root: Root | undefined, element: HTMLDivElement
const id = asHostId('ssh:host'),
  row: DeliveryRecoveryEntry = {
    id: 'operation',
    workspace: 'workspace',
    root: hostPath(id, '/project'),
    installation: 'forgotten-installation',
    phase: 'publishing',
    sourceVersion: 'version',
    outcome: 'completion-unproven',
    target: hostPath(id, '/project/skill'),
    staging: hostPath(id, '/project/stage'),
    preserved: hostPath(id, '/project/preserved'),
  }
afterEach(() => {
  if (root) act(() => root!.unmount())
  root = undefined
  element?.remove()
  vi.unstubAllGlobals()
})
async function render() {
  element = document.createElement('div')
  document.body.append(element)
  root = createRoot(element)
  await act(async () => {
    root!.render(createElement(DeliveryRecoverySettings))
    await Promise.resolve()
  })
}
const button = (name: string) =>
  [...element.querySelectorAll<HTMLButtonElement>('button')].find(
    (entry) => entry.textContent === name,
  )!
it.each(['snapshot', 'error'])(
  'rejects a late initial %s after a newer recovery refresh',
  async (completion) => {
    let resolve!: (value: DeliveryRecoveryEntry[]) => void,
      reject!: (reason: Error) => void
    const initial = new Promise<DeliveryRecoveryEntry[]>((yes, no) => {
        resolve = yes
        reject = no
      }),
      invoke = vi.fn().mockReturnValueOnce(initial).mockResolvedValue([row])
    vi.stubGlobal('hvir', { invoke })
    await render()
    await act(async () => {
      button('Refresh retained deliveries').click()
      await Promise.resolve()
    })
    expect(element.textContent).toContain('forgotten-installation')
    await act(async () => {
      if (completion === 'snapshot') resolve([])
      else reject(new Error('stale recovery error'))
      await initial.catch(() => undefined)
    })
    expect(element.textContent).toContain('forgotten-installation')
    expect(element.textContent).not.toContain('stale recovery error')
  },
)
it('discloses exact supporting-parent identities and binds keep-files only to the fresh inspection token', async () => {
  const objects = [
    {
      path: hostPath(id, '/project/.agents'),
      state: 'unverifiable',
      recordedIdentity: 'created-parent',
    },
    {
      path: hostPath(id, '/project/.agents/skills'),
      state: 'present',
      identity: 'observed-parent',
    },
  ]
  let rows = [row]
  const invoke = vi.fn((channel: string, input?: { kind: string; id: string }) => {
    if (channel === 'extensions:delivery-recovery') return Promise.resolve(rows)
    if (input?.kind === 'inspect')
      return Promise.resolve({ token: 'fresh-facts', completion: 'unproven', objects })
    if (input?.kind === 'keep') {
      expect(input.id).toBe('fresh-facts')
      rows = []
      return Promise.resolve({
        outcome: 'resolved-by-retaining-files',
        completion: 'unproven',
      })
    }
    return Promise.reject(new Error('Unexpected recovery action'))
  })
  vi.stubGlobal('hvir', { invoke })
  await render()
  await act(async () => {
    button('Inspect retained files').click()
    await Promise.resolve()
  })
  expect(element.textContent).toContain('recorded identity created-parent')
  expect(element.textContent).toContain('recorded identity unknown')
  expect(element.textContent).toContain('observed identity observed-parent')
  expect(element.textContent).toContain('Original completion: unproven')
  await act(async () => {
    button('Keep these files and end delivery tracking').click()
    await Promise.resolve()
  })
  expect(invoke).toHaveBeenCalledWith('extensions:delivery-resolve', {
    kind: 'keep',
    id: 'fresh-facts',
  })
  expect(element.textContent).toContain('without cleanup or adoption')
  expect(element.querySelector('fieldset')).toBeNull()
})
it('ignores an inspection completion after unmount', async () => {
  let resolve!: (value: unknown) => void
  const pending = new Promise((yes) => {
      resolve = yes
    }),
    invoke = vi.fn().mockResolvedValueOnce([row]).mockReturnValueOnce(pending)
  vi.stubGlobal('hvir', { invoke })
  await render()
  act(() => button('Inspect retained files').click())
  act(() => root!.unmount())
  root = undefined
  await act(async () => {
    resolve({ token: 'late', completion: 'unproven', objects: [] })
    await pending
  })
  expect(element.childElementCount).toBe(0)
})

it.each([
  { situation: 'no retained files', result: [], open: false },
  { situation: 'unknown retained completion', result: [row], open: true },
])(
  'keeps recovery reachable and automatically shows $situation',
  async ({ result, open }) => {
    vi.stubGlobal('hvir', { invoke: vi.fn().mockResolvedValue(result) })
    await render()
    const disclosure = element.querySelector('details')!
    expect(disclosure.open).toBe(open)
    expect(disclosure.querySelector('summary')?.textContent).toContain(
      'Delivery recovery',
    )
    if (open) {
      expect(element.textContent).toContain('Completion unknown')
      expect(element.textContent).toContain('unknown completion remains unknown')
      expect(element.textContent).toContain('ssh:host: /project/skill')
      expect(button('Inspect retained files')).toBeDefined()
    }
  },
)
it('opens recovery when its current read fails, keeping an achievable error visible', async () => {
  vi.stubGlobal('hvir', {
    invoke: vi
      .fn()
      .mockRejectedValue(
        new Error(
          'Saved delivery files cannot be inspected. Check this host before cleanup.',
        ),
      ),
  })
  await render()
  expect(element.querySelector('details')?.open).toBe(true)
  expect(element.querySelector('[role=status]')?.textContent).toContain(
    'Check this host before cleanup',
  )
})

it('distinguishes owning extensions and actual outcomes without opening technical details', async () => {
  vi.stubGlobal('hvir', {
    invoke: vi.fn().mockResolvedValue([
      row,
      {
        ...row,
        id: 'completed',
        installation: 'other-extension',
        outcome: 'completed-with-retained-objects',
      },
      {
        ...row,
        id: 'conflicted',
        installation: 'third-extension',
        outcome: 'conflicted-with-retained-objects',
      },
    ]),
  })
  await render()
  expect(element.querySelector('summary')?.textContent).toContain('3 to inspect')
  const records = [...element.querySelectorAll('article')]
  for (const [index, text] of [
    'Completion unknown · Extension forgotten-installation',
    'Delivery completed · saved files remain · Extension other-extension',
    'Delivery conflict · saved files remain · Extension third-extension',
  ].entries()) {
    expect(records[index]!.querySelector('p')?.textContent).toBe(text)
    expect(records[index]!.querySelector('p')?.closest('details')).toBe(
      element.querySelector('details'),
    )
    expect(records[index]!.querySelector('details')?.open).toBe(false)
  }
})
