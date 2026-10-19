// @vitest-environment happy-dom
import { act, createElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, expect, it, vi } from 'vitest'
import { ExtensionSetupSettings } from '../src/renderer/src/settings/sections/ExtensionSetupSettings'
import type { ExtensionSetupReview } from '../src/shared/extensions/setup-review'
import { localPath } from '../src/shared/host-path'

let root: Root | undefined, element: HTMLDivElement | undefined
afterEach(() => {
  if (root) act(() => root?.unmount())
  element?.remove()
  root = undefined
  vi.unstubAllGlobals()
})
async function flushChange(change: () => void): Promise<void> {
  await act(async () => {
    change()
    await Promise.resolve()
  })
}
function setup(agentSnapshot: Promise<unknown> = Promise.resolve({ enabled: false })) {
  let review: ExtensionSetupReview = {
    request: '',
    installationId: 'installation',
    name: 'Example',
    file: 'example.json',
    expires: Date.now() + 600_000,
    phase: 'ready',
    rows: [
      {
        id: 'program-0',
        title: 'Run tool',
        kind: 'program',
        state: 'ready',
        selected: true,
        location: localPath('/checked/tool'),
        program: {
          installationId: 'installation',
          connector: 'tool',
          host: 'local',
          executable: '/launcher/tool',
          canonicalExecutable: '/checked/tool',
          configuration: { args: ['--json'], env: { TOOL_KEY: 'secret-value' } },
          declaration: {
            id: 'tool',
            description: 'Tool',
            context: 'application',
            environment: ['TOOL_KEY'],
            timeoutMs: 1000,
            outputBytes: 1024,
          },
        },
      },
      {
        id: 'source-0',
        title: 'Read library',
        kind: 'source',
        state: 'unchanged',
        selected: false,
        location: localPath('/library'),
      },
      {
        id: 'agent',
        title: 'Allow agents to use this extension',
        kind: 'agent',
        state: 'ready',
        selected: true,
        agentAccess: true,
      },
    ],
  }
  const listeners = new Map<string, (value: ExtensionSetupReview) => void>()
  const invoke = vi.fn(
    async (channel: string, value?: { request?: string; rows?: readonly string[] }) => {
      if (channel === 'agent:access') return agentSnapshot
      if (channel === 'extensions:setup-import') {
        review = { ...review, request: value!.request! }
        return review
      }
      if (channel === 'extensions:setup-select') {
        review = {
          ...review,
          rows: review.rows.map((row) => ({
            ...row,
            selected: value!.rows!.includes(row.id),
          })),
        }
        return review
      }
      if (channel === 'extensions:setup-apply') {
        review = {
          ...review,
          phase: 'finished',
          rows: review.rows.map((row) =>
            row.state === 'ready'
              ? { ...row, state: row.selected ? 'saved' : 'declined' }
              : row,
          ),
        }
        return review
      }
      return undefined
    },
  )
  vi.stubGlobal('hvir', {
    invoke,
    on: (channel: string, listener: (value: ExtensionSetupReview) => void) => {
      listeners.set(channel, listener)
      return () => listeners.delete(channel)
    },
  })
  element = document.createElement('div')
  document.body.append(element)
  root = createRoot(element)
  const settled = vi.fn()
  act(() =>
    root!.render(
      createElement(ExtensionSetupSettings, {
        installation: 'installation',
        disabled: false,
        onSettled: settled,
      }),
    ),
  )
  const click = async (label: string) => {
    const button = [...element!.querySelectorAll('button')].find(
      (entry) => entry.textContent === label,
    )
    expect(button).toBeDefined()
    await flushChange(() => {
      button!.click()
    })
  }
  return {
    invoke,
    settled,
    click,
    publish: (next: ExtensionSetupReview) =>
      listeners.get('extensions:setup-changed')?.(next),
    review: () => review,
    changeReview: (next: ExtensionSetupReview) => {
      review = next
    },
    agentChanged: (enabled: boolean) =>
      (listeners.get('agent:access-changed') as (value: unknown) => void)?.({ enabled }),
    switchInstallation: () =>
      act(() =>
        root!.render(
          createElement(ExtensionSetupSettings, {
            installation: 'other',
            disabled: false,
            onSettled: settled,
          }),
        ),
      ),
  }
}
it('shows canonical targets in one compact review, collapses unchanged access and masks values until reveal', async () => {
  const f = setup()
  await f.click('Review setup…')
  expect(element!.querySelector('[role=dialog]')).not.toBeNull()
  expect(element!.textContent).toContain('/checked/tool')
  expect(element!.textContent).toContain('App-wide Agent access is off')
  expect(element!.textContent).not.toContain('secret-value')
  expect(
    element!.querySelector<HTMLDetailsElement>('.extension-setup-existing')?.open,
  ).toBe(false)
  await f.click('Reveal values')
  expect(element!.textContent).toContain('secret-value')
  const agent = element!.querySelector<HTMLInputElement>(
    'input[aria-label="Allow agents to use this extension"]',
  )!
  await flushChange(() => agent.click())
  await f.click('Apply 1 change')
  expect(f.invoke).toHaveBeenCalledWith('extensions:setup-apply', {
    request: f.review().request,
  })
  expect(f.invoke.mock.calls.some(([channel]) => channel === 'agent:configure')).toBe(
    false,
  )
  expect(f.settled).toHaveBeenCalledOnce()
  expect(element!.textContent).toContain('Saved')
})
it('cancels on unmount and ignores late publication from the retired request', async () => {
  const f = setup()
  await f.click('Review setup…')
  const previous = f.review()
  await f.click('Cancel')
  expect(f.invoke).toHaveBeenCalledWith('extensions:setup-cancel', {
    request: previous.request,
  })
  act(() => f.publish(previous))
  expect(element!.querySelector('[role=dialog]')).toBeNull()
  await f.click('Review setup…')
  act(() => root!.unmount())
  root = undefined
  expect(
    f.invoke.mock.calls.filter(([channel]) => channel === 'extensions:setup-cancel'),
  ).toHaveLength(2)
})
it('retains stopping and settled partial outcomes until explicit Close, then ignores late publication', async () => {
  const f = setup()
  await f.click('Review setup…')
  const review = f.review()
  act(() => f.publish({ ...review, phase: 'saving' }))
  await f.click('Cancel')
  expect(element!.textContent).toContain('Stopping…')
  expect(f.invoke).toHaveBeenCalledWith('extensions:setup-cancel', {
    request: review.request,
  })
  const settled: ExtensionSetupReview = {
    ...review,
    phase: 'ended',
    rows: [
      { ...review.rows[0]!, state: 'saved' },
      { ...review.rows[1]!, state: 'interrupted-uncertain', retainedSetting: false },
      { ...review.rows[2]!, state: 'declined' },
    ],
  }
  act(() => f.publish(settled))
  expect(element!.textContent).toContain('Saved')
  expect(element!.textContent).toContain('Check current access')
  expect(element!.textContent).toContain('Not applied')
  await f.click('Close')
  act(() => f.publish(settled))
  expect(element!.querySelector('[role=dialog]')).toBeNull()
})
it('returns quietly to Settings when the chooser is dismissed', async () => {
  const f = setup()
  f.invoke.mockResolvedValueOnce(undefined)
  await f.click('Review setup…')
  expect(element!.querySelector('[role=dialog]')).toBeNull()
  expect(element!.textContent).not.toContain('Checking setup')
  await f.click('Review setup…')
  expect(element!.querySelector('[role=dialog]')).not.toBeNull()
})
it('shows old and new arguments and masked environment differences for configuration-only replacement', async () => {
  const f = setup()
  const review = f.review(),
    program = review.rows[0]!.program!
  f.changeReview({
    ...review,
    rows: [
      {
        ...review.rows[0]!,
        previousPrograms: [
          {
            ...program,
            configuration: { args: ['--old'], env: { TOOL_KEY: 'old-secret' } },
          },
        ],
      },
    ],
  })
  await f.click('Review setup…')
  expect(element!.textContent).toContain('Previous arguments: ["--old"]')
  expect(element!.textContent).toContain('Arguments: ["--json"]')
  expect(element!.textContent).toContain('Environment overrides changed')
  expect(element!.textContent).not.toContain('Previous launcher')
  expect(element!.textContent).not.toContain('Previous resolved program')
  expect(element!.textContent).not.toContain('old-secret')
  expect(element!.textContent).not.toContain('secret-value')
  await f.click('Reveal values')
  expect(element!.textContent).toContain('old-secret')
})
it('does not copy a template returned after switching the selected installation', async () => {
  const f = setup()
  const writeText = vi.fn(() => Promise.resolve())
  vi.stubGlobal('navigator', { clipboard: { writeText } })
  let resolve!: (value: string) => void
  f.invoke.mockImplementationOnce(
    () =>
      new Promise<string>((done) => {
        resolve = done
      }),
  )
  await f.click('Get setup template')
  f.switchInstallation()
  await flushChange(() => resolve('stale template'))
  expect(writeText).not.toHaveBeenCalled()
  expect(element!.textContent).not.toContain('Template copied')
})
it('ignores selection failures after cancellation and refreshes settled saves without reopening their review', async () => {
  const f = setup()
  await f.click('Review setup…')
  let reject!: (reason: Error) => void
  f.invoke.mockImplementationOnce(
    () =>
      new Promise<never>((_done, fail) => {
        reject = fail
      }),
  )
  await flushChange(() =>
    element!.querySelector<HTMLInputElement>('input[type=checkbox]')!.click(),
  )
  await f.click('Cancel')
  await flushChange(() => reject(new Error('stale selection failure')))
  expect(element!.textContent).not.toContain('stale selection failure')
  await f.click('Review setup…')
  let resolve!: (value: ExtensionSetupReview) => void
  f.invoke.mockImplementationOnce(
    () =>
      new Promise<ExtensionSetupReview>((done) => {
        resolve = done
      }),
  )
  await f.click('Apply 2 changes')
  await f.click('Cancel')
  expect(element!.textContent).toContain('Stopping…')
  await f.click('Close')
  await flushChange(() => resolve({ ...f.review(), phase: 'finished' }))
  expect(f.settled).toHaveBeenCalledOnce()
  expect(element!.querySelector('[role=dialog]')).toBeNull()
})
it('does not overwrite a newer app-wide access publication with the initial snapshot', async () => {
  let resolve!: (value: unknown) => void
  const f = setup(
    new Promise((done) => {
      resolve = done
    }),
  )
  act(() => f.agentChanged(true))
  await flushChange(() => resolve({ enabled: false }))
  await f.click('Review setup…')
  expect(element!.textContent).not.toContain('App-wide Agent access is off')
})
