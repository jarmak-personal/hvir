// @vitest-environment happy-dom
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import type { ExtensionSourceRequestProposal } from '../src/shared/extensions/source-access'
import { localPath } from '../src/shared/host-path'
import { SourceConfirmationDialog } from '../src/renderer/src/workbench/SourceConfirmationDialog'

const proposal: ExtensionSourceRequestProposal = {
  id: 'decision-one',
  name: 'Library',
  source: 'library',
  description: 'Read selected library files',
  root: localPath('/library'),
}
let host: HTMLDivElement,
  root: Root,
  publish: (next: readonly ExtensionSourceRequestProposal[]) => void,
  initial: (next: readonly ExtensionSourceRequestProposal[]) => void
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
  const snapshot = new Promise<readonly ExtensionSourceRequestProposal[]>((resolve) => {
    initial = resolve
  })
  invoke = vi.fn<(channel: string, input?: unknown) => Promise<unknown>>(
    (channel: string) =>
      channel === 'extensions:source-proposals' ? snapshot : Promise.resolve(),
  )
  Object.defineProperty(window, 'hvir', {
    configurable: true,
    value: {
      invoke,
      on: vi.fn(
        (
          _channel: string,
          listener: (next: readonly ExtensionSourceRequestProposal[]) => void,
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
  act(() => root.render(<SourceConfirmationDialog />))
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
  expect(host.textContent).toContain('Read with Library')
  expect(host.textContent).not.toContain('Old library')
  expect(host.textContent).toContain('local: /library')
  expect(host.textContent).toContain(
    'does not permit writing files or grant access to agents',
  )
  act(() => button('Allow read-only access').click())
  expect(invoke).toHaveBeenLastCalledWith('extensions:source-decide', {
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
  expect(invoke).toHaveBeenLastCalledWith('extensions:source-decide', {
    id: 'decision-one',
    accepted: false,
  })
  act(() => publish([{ ...proposal, id: 'decision-two', name: 'Next library' }]))
  await act(async () => {
    reject(new Error('Old response ended'))
    await Promise.resolve()
  })
  expect(host.textContent).toContain('Read with Next library')
  expect(host.querySelector('[role="alert"]')).toBeNull()
  expect(button('Allow read-only access').disabled).toBe(false)
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
