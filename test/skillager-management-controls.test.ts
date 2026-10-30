// @vitest-environment happy-dom
import { createContext, runInContext } from 'node:vm'
import type { WebContents } from 'electron'
import { expect, it } from 'vitest'
import { skillagerManagementControls } from '../src/main/smoke/skillager-management-controls'

it('sets the exact control and preserves quoted input through document evaluation', async () => {
  const id = `fixture'"\\\u2028`,
    value = `');globalThis.injected=true;//\n</script>保存-𐐨\u2029`
  const input = document.createElement('textarea')
  input.id = id
  document.body.append(input)
  let changes = 0
  input.addEventListener('input', () => changes++)
  const context = createContext({ document, Event, injected: false })
  const guest = {
    debugger: {
      sendCommand: (_method: string, { expression }: { expression: string }) =>
        Promise.resolve({
          result: { value: runInContext(expression, context) as unknown },
        }),
    },
  } as unknown as WebContents
  try {
    await skillagerManagementControls(guest, {
      wait: async (predicate) => {
        expect(await predicate()).toBe(true)
      },
    }).set(id, value)
    expect(input.value).toBe(value)
    expect(changes).toBe(1)
    expect(context.injected).toBe(false)
  } finally {
    input.remove()
  }
})
