import { MAX_TERMINAL_SEMANTIC_REGIONS } from '../src/renderer/src/terminal/terminal-semantic-regions'
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
    revealBoundary: vi.fn(() => Promise.resolve(true)),
    readRange: () => Promise.resolve(''),
    cancelExtraction: vi.fn(),
  }
  const pane: NativeTerminalPanePort = {
    engine: 'native',
    setAppearance: vi.fn(),
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

  it('finishes a held nearest-boundary navigation while new parser markers append', async () => {
    const f = fixture()
    const event = (
      id: number,
      action:
        | 'prompt-start'
        | 'end-prompt-start-input'
        | 'end-input-start-output'
        | 'end-command',
    ) =>
      f.interactions.paneEvents.handle({
        type: 'semantic',
        action,
        options: '',
        provenance: { id, boundaryId: `b-${id}`, screen: 'normal', row: id, column: 0 },
      })
    event(1, 'prompt-start')
    event(2, 'end-prompt-start-input')
    event(3, 'end-input-start-output')
    event(4, 'end-command')
    let finish!: (location: TerminalEventLocation | undefined) => void
    const resolve = vi.spyOn(f.capability, 'resolveBoundary').mockImplementationOnce(
      () =>
        new Promise((done) => {
          finish = done
        }),
    )
    const reveal = vi.spyOn(f.capability, 'revealBoundary')
    const navigation = f.interactions.paneEvents.navigate('previous', f.pane)
    await vi.waitFor(() => expect(resolve).toHaveBeenCalledOnce())
    const signal = resolve.mock.calls[0]![1]!
    event(5, 'prompt-start')
    event(6, 'end-prompt-start-input')
    event(7, 'end-input-start-output')
    event(8, 'end-command')
    expect(signal.aborted).toBe(false)
    finish({ screen: 'normal', row: 3, column: 0 })
    await navigation
    expect(resolve).toHaveBeenCalledTimes(2)
    expect(reveal).toHaveBeenCalledOnce()
    expect(reveal.mock.calls[0]![0].id).toBe(3)
    expect(f.interactions.paneEvents.snapshot().semanticRegion).toEqual({
      kind: 'output',
      index: 3,
      total: 6,
    })
    f.interactions.revoke(true)
  })

  it('does not cancel a safe held candidate when append evicts unrelated fallback metadata at capacity', async () => {
    const f = fixture()
    const event = (
      id: number,
      action:
        | 'prompt-start'
        | 'end-prompt-start-input'
        | 'end-input-start-output'
        | 'end-command',
    ) =>
      f.interactions.paneEvents.handle({
        type: 'semantic',
        action,
        options: '',
        provenance: { id, boundaryId: `b-${id}`, screen: 'normal', row: id, column: 0 },
      })
    const cycles = Math.floor(MAX_TERMINAL_SEMANTIC_REGIONS / 3)
    for (let index = 0; index < cycles; index++) {
      const id = index * 4 + 1
      event(id, 'prompt-start')
      event(id + 1, 'end-prompt-start-input')
      event(id + 2, 'end-input-start-output')
      event(id + 3, 'end-command')
    }
    const heldId = cycles * 4 + 1
    event(heldId, 'prompt-start')
    let finish!: (location: TerminalEventLocation | undefined) => void
    const resolve = vi.spyOn(f.capability, 'resolveBoundary').mockImplementationOnce(
      () =>
        new Promise((done) => {
          finish = done
        }),
    )
    const reveal = vi.spyOn(f.capability, 'revealBoundary')
    const navigation = f.interactions.paneEvents.navigate('previous', f.pane)
    await vi.waitFor(() => expect(resolve).toHaveBeenCalledOnce())
    const signal = resolve.mock.calls[0]![1]!
    event(heldId + 1, 'end-prompt-start-input')
    event(heldId + 2, 'end-input-start-output')
    event(heldId + 3, 'end-command')
    expect(signal.aborted).toBe(false)
    finish({ screen: 'normal', row: heldId, column: 0 })
    await navigation
    expect(resolve).toHaveBeenCalledTimes(2)
    expect(reveal).toHaveBeenCalledOnce()
    expect(reveal.mock.calls[0]![0].id).toBe(heldId)
    expect(f.interactions.paneEvents.snapshot().semanticRegion).toEqual({
      kind: 'prompt',
      index: MAX_TERMINAL_SEMANTIC_REGIONS - 2,
      total: MAX_TERMINAL_SEMANTIC_REGIONS,
    })
    f.interactions.revoke(true)
  })

  it.each([undefined, 10])(
    'cancels a held candidate removed by semantic gap/cutoff %s',
    async (controlCutoff) => {
      const f = fixture()
      f.interactions.paneEvents.handle({
        type: 'semantic',
        action: 'prompt-start',
        options: '',
        provenance: { id: 10, boundaryId: 'b-10', screen: 'normal', row: 0, column: 0 },
      })
      let finish!: (location: TerminalEventLocation | undefined) => void
      const resolve = vi.spyOn(f.capability, 'resolveBoundary').mockImplementationOnce(
        () =>
          new Promise((done) => {
            finish = done
          }),
      )
      const reveal = vi.spyOn(f.capability, 'revealBoundary')
      const navigation = f.interactions.paneEvents.navigate('previous', f.pane)
      await vi.waitFor(() => expect(resolve).toHaveBeenCalledOnce())
      const signal = resolve.mock.calls[0]![1]!
      f.interactions.paneEvents.handle({
        type: 'semantic-gap',
        ...(controlCutoff === undefined ? {} : { controlCutoff }),
      })
      expect(signal.aborted).toBe(true)
      finish({ screen: 'normal', row: 0, column: 0 })
      await navigation
      expect(reveal).not.toHaveBeenCalled()
      expect(f.interactions.paneEvents.snapshot().semanticRegion).toBeUndefined()
      f.interactions.revoke(true)
    },
  )

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
