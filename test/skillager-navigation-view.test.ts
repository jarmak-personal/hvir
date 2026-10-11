// @vitest-environment happy-dom
import { readFileSync } from 'node:fs'
import { runInNewContext } from 'node:vm'
import { buildSync } from 'esbuild'
import { afterEach, expect, it, vi } from 'vitest'

afterEach(() => {
  window.dispatchEvent(new Event('pagehide'))
  document.body.replaceChildren()
  vi.useRealTimers()
})

it.each(['project', 'library', 'detail'])(
  'admits %s management navigation only after visible main context and disables it on hide/revocation',
  async (view) => {
    vi.useFakeTimers()
    const template = document.createElement('template')
    template.innerHTML = readFileSync(`packages/skillager-extension/${view}.html`, 'utf8')
    for (const node of template.content.querySelectorAll('script, link')) node.remove()
    document.body.replaceChildren(template.content.cloneNode(true))
    document.body.dataset['view'] = view
    const sent: Array<Record<string, unknown>> = []
    let receive!: (message: Record<string, unknown>) => void
    const bridge = {
      onMessage(callback: typeof receive) {
        receive = callback
        return () => undefined
      },
      send(message: Record<string, unknown>) {
        sent.push(message)
      },
    }
    const ui = {
      bindPresentation: () => () => undefined,
      bindList: () => ({ refresh: () => undefined, dispose: () => undefined }),
    }
    const bundle = buildSync({
      entryPoints: ['packages/skillager-extension/src/app.mjs'],
      bundle: true,
      format: 'iife',
      write: false,
    })
    runInNewContext(bundle.outputFiles[0]!.text, {
      document,
      window: {
        hvirExtension: bridge,
        hvirUI: ui,
        addEventListener: window.addEventListener.bind(window),
        setTimeout,
        clearTimeout,
      },
      Date,
      performance,
      TextEncoder,
      AbortController,
      setTimeout,
      clearTimeout,
    })
    const manage = document.getElementById('manage') as HTMLButtonElement
    expect(manage.disabled).toBe(true)
    manage.click()
    await vi.advanceTimersByTimeAsync(50)
    expect(sent.some((request) => request['capability'] === 'viewer.open-own')).toBe(
      false,
    )
    receive({ kind: 'context', context: { surface: 'viewer', visible: true } })
    expect(manage.disabled).toBe(false)
    manage.click()
    await vi.advanceTimersByTimeAsync(50)
    expect(
      sent.filter((request) => request['capability'] === 'viewer.open-own'),
    ).toHaveLength(1)
    receive({ kind: 'context', context: { surface: 'viewer', visible: false } })
    expect(manage.disabled).toBe(true)
    manage.click()
    await vi.advanceTimersByTimeAsync(50)
    expect(
      sent.filter((request) => request['capability'] === 'viewer.open-own'),
    ).toHaveLength(1)
    receive({ kind: 'context', context: { surface: 'viewer', visible: true } })
    expect(manage.disabled).toBe(false)
    receive({ kind: 'revoked' })
    expect(manage.disabled).toBe(true)
  },
)
