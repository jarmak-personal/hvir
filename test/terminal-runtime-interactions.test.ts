import { NativeTerminalPaneEffects } from '../src/renderer/src/terminal/native-terminal-pane-effects'
import { describe, expect, it, vi } from 'vitest'
import { TerminalRuntimeInteractions } from '../src/renderer/src/terminal/terminal-runtime-interactions'
import type {
  NativeTerminalPanePort,
  TerminalEventLocation,
} from '../src/renderer/src/terminal/terminal-pane'
import type {
  TerminalRetainedQueryCapability,
  TerminalRetainedQuery,
} from '../src/renderer/src/terminal/terminal-retained-query'

function fixture() {
  let visible = true
  const result: TerminalRetainedQuery = {
    snapshot: () => ({ revision: 1, matchCount: 0, pending: false, invalidated: false }),
    onUpdate: () => () => undefined,
    at: () => Promise.resolve(undefined),
    resolve: () => Promise.resolve(undefined),
    reveal: () => Promise.resolve(false),
    read: () => Promise.resolve(undefined),
    clearReveal: vi.fn(),
    dispose: vi.fn(),
  }
  const capability: TerminalRetainedQueryCapability = {
    search: vi.fn(() => Promise.resolve(result)),
    cancelSearch: vi.fn(),
    activeScreen: () => Promise.resolve('normal'),
    resolveBoundary: vi.fn<TerminalRetainedQueryCapability['resolveBoundary']>(() =>
      Promise.resolve({ screen: 'normal', row: 0, column: 0 }),
    ),
    captureEnd: () => Promise.resolve(undefined),
    revealBoundary: vi.fn(() => Promise.resolve(true)),
    readRange: () => Promise.resolve(''),
    cancelExtraction: vi.fn(),
  }
  const pane: NativeTerminalPanePort = {
    engine: 'native',
    retained: capability,
    selection: {
      status: () => Promise.resolve({ hasSelection: false }),
      read: () => Promise.resolve(undefined),
      selectAll: () => Promise.resolve(),
      clear: () => Promise.resolve(),
      reset: () => Promise.resolve(),
    },
    mount: vi.fn(),
    reparent: vi.fn(),
    setPresentation: vi.fn(),
    focus: vi.fn(),
    dispose: vi.fn(),
    paste: vi.fn(),
    viewport: () => ({ width: 640, height: 480, backingScale: 1 }),
    bind: () => Promise.resolve(),
    setReadonly: vi.fn(),
    onInput: () => () => undefined,
  }
  const interactions = new TerminalRuntimeInteractions(
    'Terminal',
    () => visible,
    vi.fn(),
    vi.fn(),
  )
  interactions.updateAvailability(true)
  interactions.bindSelection(pane, 'pty')
  return {
    pane,
    capability,
    interactions,
    hide: () => {
      visible = false
      interactions.synchronizeAvailability()
    },
  }
}

describe('native retained runtime interactions', () => {
  it('binds the narrow capability and keeps visible retained search available after physical exit', () => {
    const f = fixture()
    expect(f.interactions.search.open()).toBe(true)
    f.pane.setReadonly()
    f.interactions.revoke(false)
    expect(f.interactions.search.snapshot().open).toBe(false)
    expect(f.interactions.search.open()).toBe(true)
    expect(f.interactions.contextMenuTarget()).toBeDefined()
    f.interactions.revoke(true)
    expect(f.interactions.search.open()).toBe(false)
    expect(f.interactions.contextMenuTarget()).toBeUndefined()
  })

  it('closes retained search when the surface becomes unavailable', () => {
    const f = fixture()
    expect(f.interactions.search.open()).toBe(true)
    f.hide()
    expect(f.interactions.search.snapshot().open).toBe(false)
    expect(f.interactions.search.open()).toBe(false)
    f.interactions.revoke(true)
  })

  it('clears the old semantic region on an inclusive-cutoff gap before accepting a later parser boundary', async () => {
    const f = fixture()
    const effects = new NativeTerminalPaneEffects(() => ({
      sessionId: 's',
      instanceId: 'i',
      disposed: false,
    }))
    effects.subscribe((event) => {
      f.interactions.paneEvents.handle(event)
    })
    const marker = (eventSerial: number) => ({
      id: 's',
      instanceId: 'i',
      eventSerial,
      effect: {
        kind: 'semantic' as const,
        action: 3,
        options: '',
        screen: 'normal' as const,
        row: 0,
        column: 0,
        boundaryId: `b-${eventSerial}`,
      },
    })
    effects.accept(marker(5))
    expect(f.interactions.paneEvents.snapshot().semanticRegionsAvailable).toBe(true)
    effects.accept({
      id: 's',
      instanceId: 'i',
      eventSerial: 5,
      effect: { kind: 'semantic-gap' },
    })
    expect(f.interactions.paneEvents.snapshot().semanticRegionsAvailable).toBe(false)
    effects.accept(marker(8))
    const read = vi.spyOn(f.capability, 'readRange')
    await f.interactions.paneEvents.extractCurrentRegion(
      f.pane,
      new AbortController().signal,
    )
    expect(read.mock.calls[0]?.[0]).toMatchObject({ id: 8, boundaryId: 'b-8' })
    f.interactions.revoke(true)
    effects.clear()
  })

  it('revokes an in-flight semantic navigation before a hidden pane can reveal or activate it', async () => {
    const f = fixture()
    let finish!: (location: TerminalEventLocation | undefined) => void
    const resolve = vi.spyOn(f.capability, 'resolveBoundary').mockImplementation(
      () =>
        new Promise((done) => {
          finish = done
        }),
    )
    const reveal = vi.spyOn(f.capability, 'revealBoundary')
    f.interactions.paneEvents.handle({
      type: 'semantic',
      action: 'prompt-start',
      options: '',
      provenance: { id: 1, boundaryId: 'boundary', screen: 'normal', row: 0, column: 0 },
    })
    const navigation = f.interactions.paneEvents.navigate('previous', f.pane)
    await vi.waitFor(() => expect(resolve).toHaveBeenCalledOnce())
    const signal = resolve.mock.calls[0]?.[1]
    f.hide()
    expect(signal?.aborted).toBe(true)
    finish({ screen: 'normal', row: 0, column: 0 })
    await navigation
    expect(reveal).not.toHaveBeenCalled()
    expect(f.interactions.paneEvents.snapshot().semanticRegion).toBeUndefined()
    f.interactions.revoke(true)
  })
})
