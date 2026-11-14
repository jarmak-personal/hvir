import { runInNewContext } from 'node:vm'
import { EventEmitter } from 'node:events'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  nativeSelectionFixture,
  nativeSelectionBrowser,
  nativeSelectionHitCensusScript,
  nativeSelectionPointerObservation,
  nativeSelectionLargeExpected,
  nativeSelectionLargeRow,
  nativeSelectionRecorderSource,
} from '../src/main/smoke/native-terminal-selection'
/** Only the recorder's protocol and synthetic goldens; not a native formatter/TTY proof. */
function recorder(block = false) {
  const stdin = Object.assign(new EventEmitter(), {
      setRawMode: vi.fn(),
      resume: vi.fn(),
      pause: vi.fn(),
    }),
    writes: string[] = [],
    exit = vi.fn()
  const stdout = Object.assign(new EventEmitter(), {
    write: (text: string, done?: () => void) => {
      writes.push(text)
      done?.()
      return !(block && (text.includes('unrelated-output') || /^L[0-9]{4}:/.test(text)))
    },
  })
  runInNewContext(
    nativeSelectionRecorderSource(
      80,
      30,
      'file:///fixture/package.json',
      'http://127.0.0.1:12345/native-selection',
    ),
    { process: { stdin, stdout, exit }, Buffer, setTimeout, clearTimeout },
  )
  const emit = (data: string) => stdin.emit('data', Buffer.from(data))
  return {
    stdin,
    stdout,
    writes,
    exit,
    emit,
    command: (name: string) => emit('\x1d' + name + '\x1d'),
    text: () => writes.join(''),
  }
}
beforeEach(() => vi.useFakeTimers())
afterEach(() => {
  vi.clearAllTimers()
  vi.useRealTimers()
})
describe('same-PTY native selection qualification protocol', () => {
  it('dismisses an existing menu with Escape before the unchanged independent Ctrl-click, and refuses a non-native hit', async () => {
    let menu = true,
      nativeHit = true
    const events: { type: string; keyCode?: string; modifiers?: string[] }[] = []
    const win = {
      webContents: {
        executeJavaScript: (script: string) =>
          Promise.resolve(
            script.includes('const menus=')
              ? { menus: Number(menu), nativeHit }
              : script.includes('getBoundingClientRect')
                ? { x: 0, y: 0, width: 100, height: 100 }
                : {},
          ),
        sendInputEvent: (event: (typeof events)[number]) => {
          events.push(event)
          if (event.keyCode === 'Escape') menu = false
        },
      },
    } as unknown as Parameters<typeof nativeSelectionBrowser>[0]
    const native = {
      inspectRetained: () =>
        Promise.resolve({
          geometry: {
            width: 100,
            backingScale: 1,
            paddingLeft: 0,
            paddingTop: 0,
            cellWidth: 5,
            cellHeight: 10,
          },
        }),
    } as unknown as Parameters<typeof nativeSelectionBrowser>[1]
    const browser = nativeSelectionBrowser(win, native, {
      id: 's',
      ownerId: 'o',
      ownerGeneration: 1,
    } as unknown as Parameters<typeof nativeSelectionBrowser>[2])
    await browser.clicks(4.5, 2.5, 1, ['control'])
    expect(events.map((event) => event.keyCode ?? event.type)).toEqual([
      'Escape',
      'Escape',
      'mouseDown',
      'mouseUp',
    ])
    expect(events.at(-1)?.modifiers).toEqual(['control'])
    expect(browser.menuDismissals).toEqual([
      { visible: true, dismissed: true, nativeHit: true },
    ])
    nativeHit = false
    await expect(browser.clicks(4.5, 2.5, 1, ['control'])).rejects.toThrow(
      'link-hit-not-native',
    )
    expect(events).toHaveLength(4)
  })
  it('observes actual hit order and menu bounds without serializing element text or paths', () => {
    const node = {
      tagName: 'DIV',
      className: 'terminal-context-menu',
      textContent: 'private',
      getAttribute: (name: string) => (name === 'role' ? 'menu' : null),
      getBoundingClientRect: () => ({ x: 1, y: 2, width: 3, height: 4 }),
    }
    const document = {
      querySelectorAll: (selector: string) =>
        selector === '.terminal-context-menu' ? [node] : [],
      elementsFromPoint: vi.fn(() => [node]),
      activeElement: node,
    }
    const value: unknown = runInNewContext(
      nativeSelectionHitCensusScript('session', 12, 34),
      {
        document,
      },
    )
    expect(document.elementsFromPoint).toHaveBeenCalledWith(12, 34)
    expect(value).toMatchObject({
      point: { x: 12, y: 34 },
      menus: 1,
      menuBounds: [{ x: 1, y: 2, width: 3, height: 4 }],
      pane: false,
      canvas: false,
    })
    expect(JSON.stringify(value)).not.toContain('private')
  })
  it('retains numeric viewport, pane, canvas and backing metrics without terminal content', () => {
    const canvas = {
      width: 1600,
      height: 600,
      getBoundingClientRect: () => ({ x: 2, y: 3, width: 800, height: 300 }),
    }
    const pane = {
      hidden: false,
      getAttribute: () => null,
      querySelector: () => canvas,
      querySelectorAll: () => [],
      contains: () => false,
      getBoundingClientRect: () => ({ x: 2, y: 3, width: 800, height: 300 }),
    }
    const panel = { hidden: false, getAttribute: () => 's', querySelector: () => pane }
    const document = {
      querySelectorAll: (selector: string) =>
        selector === '.terminal-surface' ? [panel] : [],
      elementsFromPoint: () => [],
      activeElement: null,
    }
    const value: unknown = runInNewContext(nativeSelectionHitCensusScript('s', 0, 0), {
      document,
      innerWidth: 1000,
      innerHeight: 500,
      devicePixelRatio: 2,
    })
    expect(value).toMatchObject({
      viewport: { width: 1000, height: 500, dpr: 2 },
      canvasBacking: { width: 1600, height: 600 },
      canvasBounds: { width: 800, height: 300 },
      paneBounds: { width: 800, height: 300 },
    })
  })
  it('records only closed pointer/link completion metadata, excluding arbitrary payload fields', () => {
    const observation = nativeSelectionPointerObservation(
      { kind: 'pointer', x: 12, y: 34, button: 1, action: 0, modifiers: 2 },
      { requestedMutation: 9, captured: false, selectionResult: 0, linkCandidate: true },
      'link-external',
    )
    expect(observation).toEqual({
      phase: 'link-external',
      x: 12,
      y: 34,
      button: 1,
      action: 0,
      modifiers: 2,
      captured: false,
      selectionResult: 0,
      linkCandidate: true,
    })
    expect(Object.keys(observation)).not.toContain('requestedMutation')
  })
  it('emits fixed Unicode/whitespace/softwrap goldens and invisible marker controls, accepting only the actual split DSR reply', () => {
    const f = recorder(),
      fixture = nativeSelectionFixture(80)
    expect(f.text()).toBe('\x1b]0;__HVIR_NATIVE_SELECTION_READY__\x07')
    f.command('grid')
    expect(f.text()).toContain('\x1b[?1049h')
    expect(f.text()).toContain('\x1b[48;2;0;0;255;97m' + fixture.word + '\x1b[0m')
    expect(f.text()).toContain('\x1b[7;1H' + fixture.unicode)
    expect(fixture.unicode).toBe('  A界e\u0301B  ')
    expect(fixture.wrap).toBe('w'.repeat(80) + 'tail')
    expect(f.text()).toContain(
      '\x1b]8;;file:///fixture/package.json\x1b\\OSC8-file\x1b]8;;\x1b\\',
    )
    f.emit('\x1b[')
    expect(f.text()).not.toContain('GRID_READY__')
    f.emit('0n')
    expect(f.text()).toContain('GRID_READY__')
    f.command('quit')
    expect(f.exit).toHaveBeenCalledExactlyOnceWith(0)
    expect(f.stdin.setRawMode.mock.calls).toEqual([[true], [false]])
  })
  it('honors backpressure and requires at least64KiB ALREADYwritten before its live selection trigger', async () => {
    const f = recorder(true)
    f.command('continuous-warmup')
    f.emit('\x1b[0n')
    const body = () => f.writes.filter((text) => text.includes('unrelated-output'))
    expect(body()).toHaveLength(1)
    await vi.advanceTimersByTimeAsync(20)
    expect(body()).toHaveLength(1)
    for (let n = 0; n < 200 && !f.text().includes('CONTINUOUS_TRIGGER_'); n++)
      f.stdout.emit('drain')
    const index = f.writes.findIndex((text) => text.includes('CONTINUOUS_TRIGGER_'))
    expect(index).toBeGreaterThan(0)
    expect(
      f.writes
        .slice(0, index)
        .filter((text) => text.includes('unrelated-output'))
        .reduce((count, text) => count + Buffer.byteLength(text), 0),
    ).toBeGreaterThanOrEqual(65536)
    expect(
      body().every(
        (text) =>
          text.includes('\x1b7\x1b[29;1H\r\x1b[2Kunrelated-output\x1b8') &&
          !text.includes('\n'),
      ),
    ).toBe(true)
    f.emit('\x03')
    expect(f.text()).toContain('CONTINUOUS_INTERRUPTED_')
    expect(f.stdout.listenerCount('drain')).toBe(0)
  })
  it('streams4096 exact full-width hard rows with no final newline and keeps source/body out of receipt markers', () => {
    const f = recorder(true)
    f.command('large')
    expect(f.writes.filter((text) => /^L[0-9]{4}:/.test(text))).toHaveLength(1)
    for (let n = 0; n < 4096; n++) f.stdout.emit('drain')
    const rows = f.writes.filter((text) => /^L[0-9]{4}:/.test(text))
    expect(rows).toHaveLength(4096)
    expect(rows[0]).toBe(nativeSelectionLargeRow(80, 0) + '\r\n')
    expect(rows.at(-1)).toBe(nativeSelectionLargeRow(80, 4095))
    expect(rows.slice(0, -1).every((text) => text.length === 82)).toBe(true)
    expect(nativeSelectionLargeExpected(80).bytes).toBe(4096 * 81 - 1)
    f.emit('\x1b[0n')
    expect(f.text()).toContain('LARGE_READY__')
    f.emit('\x03')
    expect(f.text()).toContain('\x1b[Hchanged')
    expect(f.text()).toContain('LARGE_INTERRUPTED__')
    f.emit('a')
    expect(f.text()).toContain('LARGE_KEY__')
  })
  it('fails rather than accepting an unexpected raw byte or an unbounded producer', async () => {
    const bad = recorder()
    bad.command('grid')
    bad.emit('xxxx')
    expect(bad.exit).toHaveBeenCalledExactlyOnceWith(2)
    const live = recorder(true)
    live.command('continuous-warmup')
    live.emit('\x1b[0n')
    await vi.advanceTimersByTimeAsync(2000)
    expect(live.exit).toHaveBeenCalledExactlyOnceWith(2)
    expect(live.text()).toContain('FAILED_continuous-deadline')
  })
})
