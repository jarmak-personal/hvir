import { runInNewContext } from 'node:vm'
import type { BrowserWindow } from 'electron'
import { afterEach, expect, it, vi } from 'vitest'
import {
  extensionRailGeometryProbe,
  verifyExtensionRailGeometry,
} from '../src/main/smoke/extension-presentation-geometry'
import type { ProjectHost } from '../src/main/project-host/project-host'

// These immediate DOM metrics prove the probe/diagnostic contract, not Chromium layout.
function rail() {
  const rect = (x: number, width: number, y = 5, height = 26) => ({
    x,
    y,
    width,
    height,
    left: x,
    right: x + width,
    top: y,
    bottom: y + height,
  })
  const headerRect = rect(0, 220, 0, 36),
    groupRect = rect(8, 84)
  const button = () => ({
    getBoundingClientRect: () => rect(8, 26),
    scrollWidth: 26,
    clientWidth: 26,
    title: 'PRIVATE_LABEL',
    getAttribute: () => 'PRIVATE_LABEL',
  })
  const buttons = Array.from({ length: 7 }, button)
  const actions = Array.from({ length: 4 }, (_, i) => ({
    getBoundingClientRect: () => rect(93 + i * 27, 26),
  }))
  const group = {
    getBoundingClientRect: () => groupRect,
    querySelectorAll: () => buttons,
    scrollWidth: 194,
    clientWidth: 84,
    scrollLeft: 110,
  }
  const header = {
    textContent: 'PRIVATE_TERMINAL_CONTENT',
    getBoundingClientRect: () => headerRect,
    querySelector: (selector: string) =>
      selector === '.extension-terminal-items'
        ? group
        : selector === '.terminal-header-actions'
          ? { children: [group, ...actions] }
          : null,
    querySelectorAll: (selector: string) => (selector === 'button' ? buttons : actions),
  }
  const outer = { getAttribute: () => 'PRIVATE_PATH', querySelector: () => header }
  const style = { overflowX: 'auto', getPropertyValue: () => '1.3' }
  const context = {
    document: {
      querySelector: () => outer,
      documentElement: { dataset: { theme: 'light' } },
      fonts: { status: 'loaded' },
    },
    innerWidth: 760,
    innerHeight: 656,
    devicePixelRatio: 1,
    getComputedStyle: () => style,
  }
  const sample = (): Record<string, unknown> =>
    runInNewContext(extensionRailGeometryProbe(7), context) as Record<string, unknown>
  return { sample, buttons, groupRect, headerRect, style, context }
}

afterEach(() => {
  vi.restoreAllMocks()
  vi.unstubAllEnvs()
})

it('retains accepted geometry and only closed numeric/boolean layout diagnostics', () => {
  const fixture = rail(),
    observation = fixture.sample()
  expect(observation).toMatchObject({
    accepted: true,
    contributions: 7,
    viewport: { width: 760, height: 656, dpr: 1 },
    scale: '1.3',
    theme: 'light',
    fonts: 'loaded',
    group: { width: 84, scrollLeft: 110 },
  })
  expect(Array.isArray(observation.buttons)).toBe(true)
  expect(observation.buttons).toHaveLength(7)
  expect(JSON.stringify(observation)).not.toMatch(/PRIVATE|textContent|title|aria-label/)
})

it.each(['overlap', 'overflow', 'too-narrow', 'scroll-policy'] as const)(
  'keeps the original %s refusal while naming the failed check',
  (failure) => {
    const fixture = rail()
    if (failure === 'overlap') fixture.headerRect.right = 190
    if (failure === 'overflow') fixture.buttons[0]!.scrollWidth = 27
    if (failure === 'too-narrow') fixture.groupRect.width = 51
    if (failure === 'scroll-policy') fixture.style.overflowX = 'hidden'
    const check = {
      overlap: 'contained',
      overflow: 'buttonsFit',
      'too-narrow': 'contributionWidth',
      'scroll-policy': 'scroll',
    }[failure]
    expect(fixture.sample()).toMatchObject({
      accepted: false,
      checks: { [check]: false },
    })
  },
)

it('reports missing elements without inventing geometry', () => {
  const context = rail().context
  context.document.querySelector = () =>
    null as unknown as ReturnType<typeof context.document.querySelector>
  const observation: unknown = runInNewContext(extensionRailGeometryProbe(7), context)
  expect(observation).toMatchObject({
    accepted: false,
    contributions: 0,
    checks: { elements: false, contributions: false },
  })
})

it('logs only the LAST failed sample once at the original wait failure and rethrows that exact error', async () => {
  vi.stubEnv('HVIR_EXTENSION_VISUAL_DIRECTORY', '')
  const fixture = rail(),
    failure = new Error('original wait timeout'),
    log = vi.spyOn(console, 'log').mockImplementation(() => undefined)
  const setContentSize = vi.fn(),
    input = vi.fn()
  const win = {
    getContentSize: () => [1000, 700],
    setContentSize,
    getBounds: () => ({ x: 1, y: 2, width: 760, height: 684 }),
    getContentBounds: () => ({ x: 1, y: 30, width: 760, height: 656 }),
    webContents: {
      getZoomFactor: () => 1.25,
      sendInputEvent: input,
      executeJavaScript: (script: string) =>
        Promise.resolve(
          script.startsWith('({theme:')
            ? { theme: 'dark', scale: '1' }
            : script.includes('const rail=')
              ? fixture.sample()
              : undefined,
        ),
    },
  } as unknown as BrowserWindow
  await expect(
    verifyExtensionRailGeometry(
      win,
      async (predicate) => {
        fixture.groupRect.width = 51
        expect(await predicate()).toBe(false)
        expect(log).not.toHaveBeenCalled()
        fixture.groupRect.width = 84
        fixture.buttons[0]!.scrollWidth = 27
        expect(await predicate()).toBe(false)
        expect(log).not.toHaveBeenCalled()
        throw failure
      },
      7,
      {} as ProjectHost,
    ),
  ).rejects.toBe(failure)
  expect(log).toHaveBeenCalledOnce()
  const call: readonly unknown[] = log.mock.calls[0]!
  const prefix = call[0],
    serialized = call[1]
  expect(prefix).toBe('[smoke] terminal rail geometry failure')
  expect(JSON.parse(serialized as string)).toMatchObject({
    zoom: 1.25,
    content: { width: 760, height: 656 },
    lastObservation: {
      accepted: false,
      checks: { contributionWidth: true, buttonsFit: false },
    },
  })
  expect(setContentSize.mock.calls).toEqual([
    [1280, 800],
    [1000, 700],
  ])
  expect(input).not.toHaveBeenCalled()
})
