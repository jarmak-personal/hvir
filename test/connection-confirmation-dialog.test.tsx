// @vitest-environment happy-dom
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import type { ExtensionConnectionProposal } from '../src/shared/extensions/connectors'
import { ConnectionConfirmationDialog } from '../src/renderer/src/workbench/ConnectionConfirmationDialog'

const proposal: ExtensionConnectionProposal = {
  id: 'decision-one',
  installationId: 'installed',
  name: 'Library',
  programs: [
    {
      connector: 'tool',
      description: 'Read library metadata',
      context: 'application',
      host: 'local',
      canonicalExecutable: '/usr/bin/tool',
      configuration: { args: [], env: {} },
    },
  ],
}
let host: HTMLDivElement,
  root: Root,
  publish: (next: readonly ExtensionConnectionProposal[]) => void,
  initial: (next: readonly ExtensionConnectionProposal[]) => void
let invoke: ReturnType<
    typeof vi.fn<(channel: string, input?: unknown) => Promise<unknown>>
  >,
  unsubscribe: ReturnType<typeof vi.fn>
beforeEach(() => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true)
  vi.stubGlobal('requestAnimationFrame', (callback: FrameRequestCallback) => {
    callback(0)
    return 1
  })
  vi.stubGlobal('cancelAnimationFrame', vi.fn())
  unsubscribe = vi.fn()
  const snapshot = new Promise<readonly ExtensionConnectionProposal[]>((resolve) => {
    initial = resolve
  })
  invoke = vi.fn<(channel: string, input?: unknown) => Promise<unknown>>(
    (channel: string) =>
      channel === 'extensions:connection-proposals' ? snapshot : Promise.resolve(),
  )
  Object.defineProperty(window, 'hvir', {
    configurable: true,
    value: {
      invoke,
      on: vi.fn(
        (
          _channel: string,
          listener: (next: readonly ExtensionConnectionProposal[]) => void,
        ) => {
          publish = listener
          return unsubscribe
        },
      ),
    },
  })
  host = document.createElement('div')
  document.body.append(host)
  root = createRoot(host)
  act(() => root.render(<ConnectionConfirmationDialog nested={false} />))
})
afterEach(() => {
  act(() => root.unmount())
  host.remove()
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
})
it('keeps a fresh published decision over an older snapshot and submits only its ID and consent', async () => {
  await act(async () => {
    publish([proposal])
    initial([{ ...proposal, id: 'old', name: 'Old library' }])
    await Promise.resolve()
  })
  expect(host.textContent).toContain('Connect Library')
  expect(host.textContent).not.toContain('Old library')
  expect(host.textContent).toContain('local: /usr/bin/tool')
  expect(host.textContent).toContain('No extra arguments or environment overrides')
  expect(host.textContent).toContain('local scratch folder')
  act(() => button('Connect').click())
  expect(invoke).toHaveBeenLastCalledWith('extensions:connection-decide', {
    id: 'decision-one',
    accepted: true,
  })
  act(() => publish([]))
  expect(host.querySelector('[role="dialog"]')).toBeNull()
})
it('retires the old component while a reply is held and keeps the next decision independent', async () => {
  let reject!: (error: Error) => void
  const reply = new Promise<void>((_resolve, fail) => {
    reject = fail
  })
  invoke.mockImplementationOnce(() => reply)
  await act(async () => {
    publish([proposal])
    await Promise.resolve()
  })
  act(() => button('Not now').click())
  expect(invoke).toHaveBeenLastCalledWith('extensions:connection-decide', {
    id: 'decision-one',
    accepted: false,
  })
  act(() => publish([{ ...proposal, id: 'decision-two', name: 'Next library' }]))
  await act(async () => {
    reject(new Error('Old response ended'))
    await Promise.resolve()
  })
  expect(host.textContent).toContain('Connect Next library')
  expect(host.querySelector('[role="alert"]')).toBeNull()
  expect(button('Connect').disabled).toBe(false)
})
it('describes workspace approval as host-scoped account access rather than folder confinement', async () => {
  await act(async () => {
    publish([
      {
        ...proposal,
        programs: proposal.programs.map((program) => ({
          ...program,
          context: 'workspace',
        })),
      },
    ])
    await Promise.resolve()
  })
  expect(host.textContent).toContain('registered projects on this host')
  expect(host.textContent).toContain('folder does not restrict account access')
  expect(host.textContent).not.toContain('local scratch folder')
})
it('cleans its subscription and ignores an initial reply after unmount', async () => {
  act(() => root.render(null))
  expect(unsubscribe).toHaveBeenCalledOnce()
  await act(async () => {
    initial([proposal])
    await Promise.resolve()
  })
  expect(host.querySelector('[role="dialog"]')).toBeNull()
})
function button(label: string): HTMLButtonElement {
  const result = [...host.querySelectorAll('button')].find(
    (button) => button.textContent === label,
  )
  if (!result) throw new Error('Missing trusted action')
  return result
}
