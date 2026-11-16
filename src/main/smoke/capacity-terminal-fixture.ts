import type { BrowserWindow } from 'electron'
import { dirnameHostPath, joinHostPath, type HostPath } from '../../shared/host-path'
import type { ProjectHost } from '../project-host/project-host'
import type { PtySupervisor } from '../pty/pty-supervisor'
import type { NativeTerminalApplication } from '../terminal/native-terminal-application'
import { addCapacityTerminals } from './capacity-terminals'
import { focusSmokeWindow } from './window-focus'
import {
  capacityTerminalTaggedProducer,
  type CapacityTerminalTag,
} from './capacity-terminal-tags'
import {
  observeCapacityTerminalSource,
  type CapacityTerminalSourceReceipt,
} from './capacity-terminal-source-observation'
import {
  captureCapacityTerminalTag,
  readCapacityTerminalLayout,
  CapacityTerminalLayoutPending,
} from './capacity-terminal-compositor'

const tagIdentity = (tag: CapacityTerminalTag): string =>
  [tag.row, tag.sequence, tag.columns, tag.rows].join(':')

/** One real producer behind the ordinary supervisor/ProjectHost/input paths.
 * Frame completion always requires decoded synthetic terminal pixels. */
export async function createCapacityTerminalFixture(
  win: BrowserWindow,
  supervisor: PtySupervisor,
  host: ProjectHost,
  existingFixture: HostPath,
  native?: NativeTerminalApplication,
) {
  const source = observeCapacityTerminalSource()
  const producer = joinHostPath(
    dirnameHostPath(existingFixture),
    '.hvir-capacity-terminal-producer.cjs',
  )
  try {
    await host.writeFile(producer, capacityTerminalTaggedProducer())
    await addCapacityTerminals(win, 1)
    await focusSmokeWindow(win)
    const terminal = supervisor.list()[0]
    if (
      !terminal ||
      supervisor.list().length !== 1 ||
      terminal.hostId !== producer.hostId
    )
      throw new Error('capacity-tagged-fixture-identity')
    const observation = source.get(terminal.pid)
    if (!observation) throw new Error('capacity-tagged-source-unobserved')
    const write = (text: string) =>
      supervisor.writeConfirmed(
        terminal.id,
        terminal.ownerId,
        text,
        terminal.ownerGeneration,
      )
    await write(`node '${producer.path.replaceAll("'", `'"'"'`)}'\r`)
    const wait = async <T>(
      read: () => Promise<T | undefined> | T | undefined,
      stage: string,
    ): Promise<T> => {
      const deadline = performance.now() + 15000
      let pendingCategory: string | undefined
      do {
        try {
          const value = await read()
          if (value !== undefined) return value
        } catch (error) {
          if (!(error instanceof CapacityTerminalLayoutPending)) throw error
          pendingCategory = error.category
        }
        await new Promise((resolve) => setTimeout(resolve, 5))
      } while (performance.now() < deadline)
      throw new Error(
        'capacity-tagged-fixture-timeout:' +
          stage +
          ':' +
          (pendingCategory ?? 'no-receipt'),
      )
    }
    const receipt = (kind: string, sequence: number) =>
      wait(() => observation.get(kind, sequence), kind)
    await receipt('armed', 0)
    await write('position:0\r')
    await wait(async () => {
      const physical = observation.get('positioned', 0)
      if (!physical) return
      const layout = await readCapacityTerminalLayout(win, terminal, native)
      if (layout.columns === physical.columns && layout.rows === physical.rows)
        return true
    }, 'applied-pty-grid-before-transcript')
    await write('start:0\r')
    const initial = await receipt('ready', 0)
    let current = initial
    const rows = new Map<number, CapacityTerminalTag>()
    let scrollOffset = 0
    let scrollInputSequence = 0
    await win.webContents.executeJavaScript(`(()=>{
      const engine=document.querySelector('.terminal-surface.active .terminal-engine-host');
      if(!(engine instanceof HTMLElement))throw new Error('capacity-tagged-scroll-owner');
      const state={sequence:0};
      engine.addEventListener('wheel',()=>{state.sequence++},{capture:true});
      window.__hvirCapacityWheelObservation=state;return true;
    })()`)
    const captureCalls: Array<{
      requestedAtMs: number
      completedAtMs: number
      captureMs: number
    }> = []
    const tagForRow = (row: number): CapacityTerminalTag =>
      rows.get(row) ?? {
        row,
        sequence: 0,
        columns: initial.columns,
        rows: initial.rows,
      }
    const frame = win.webContents.mainFrame
    const assertActor = () => {
      const current = supervisor.get(terminal.id)
      if (
        !current ||
        current.instanceId !== terminal.instanceId ||
        current.pid !== terminal.pid ||
        current.ownerGeneration !== terminal.ownerGeneration ||
        frame.isDestroyed() ||
        win.webContents.mainFrame !== frame
      )
        throw new Error('capacity-tagged-actor-revoked')
    }
    const observe = async (
      expected: CapacityTerminalTag,
      viewport: 'top' | 'bottom',
      expectedViewport: Pick<CapacityTerminalTag, 'columns' | 'rows'> = expected,
    ) => {
      let lastObserved: string | undefined
      let lastLayout
      let lastPixelProbe
      try {
        return await wait(
          async () => {
            assertActor()
            const layout = await readCapacityTerminalLayout(win, terminal, native)
            lastLayout = layout
            const captured = await captureCapacityTerminalTag(
              win,
              layout,
              viewport === 'top' ? 0 : layout.rows - 1,
            )
            lastPixelProbe = captured.pixelProbe
            if (captureCalls.length === 8192)
              throw new Error('capacity-tagged-capture-bound')
            captureCalls.push({
              requestedAtMs: captured.requestedAtMs,
              completedAtMs: captured.completedAtMs,
              captureMs: captured.captureMs,
            })
            lastObserved = captured.tag && tagIdentity(captured.tag)
            if (lastObserved !== tagIdentity(expected)) return
            if (
              layout.columns !== expectedViewport.columns ||
              layout.rows !== expectedViewport.rows
            )
              throw new Error('capacity-tagged-applied-pty-geometry')
            const after = await readCapacityTerminalLayout(win, terminal, native)
            assertActor()
            if (JSON.stringify(after) !== JSON.stringify(layout)) return
            return {
              layout,
              captured,
              tag: captured.tag!,
              expectedTag: expected,
              expectedViewport: {
                columns: expectedViewport.columns,
                rows: expectedViewport.rows,
              },
            }
          },
          'matching-compositor:' + tagIdentity(expected),
        )
      } catch (error) {
        console.log(
          '[smoke:capacity:tagged-witness-failure] ' +
            JSON.stringify({
              expected,
              lastPixelProbe,
              lastObserved,
              lastLayout,
              captures: captureCalls,
            }),
        )
        throw error
      }
    }
    const initialFrame = await observe(initial, 'bottom')
    const accept = (value: CapacityTerminalSourceReceipt) => {
      if (value.pid !== terminal.pid) throw new Error('capacity-tagged-source-owner')
      current = value
      rows.set(value.row, value)
    }
    const command = async (kind: 'output' | 'echo', sequence: number) => {
      if (scrollOffset !== 0) throw new Error('capacity-tagged-command-scrolled')
      let startedAtMs: number | undefined
      if (kind === 'echo') {
        await win.webContents.executeJavaScript(`(()=>{
          const input=document.querySelector('.terminal-surface.active .terminal-engine-host textarea');
          if(!(input instanceof HTMLTextAreaElement))throw new Error('capacity-tagged-input');
          input.focus({preventScroll:true});return true;
        })()`)
        startedAtMs = performance.now()
        for (const keyCode of 'echo:' + sequence)
          win.webContents.sendInputEvent({ type: 'char', keyCode })
        win.webContents.sendInputEvent({ type: 'keyDown', keyCode: 'Enter' })
        win.webContents.sendInputEvent({ type: 'keyUp', keyCode: 'Enter' })
      } else await write('output:' + sequence + '\r')
      const value = await receipt(kind, sequence)
      accept(value)
      const observed = await observe(value, 'bottom')
      return {
        startedAtMs: startedAtMs ?? value.receivedAtMs,
        ...observed,
        expectedInputSequence: sequence,
        observedInputSequence: observed.tag.sequence,
      }
    }
    const resize = async (sequence: number) => {
      await write('prepare:' + sequence + '\r')
      await receipt('armed', sequence)
      const before = await readCapacityTerminalLayout(win, terminal, native)
      const startedAtMs = performance.now()
      await win.webContents.executeJavaScript(`(()=>{
        const control=[...document.querySelectorAll('button[aria-label="Collapse terminal rail"],button[aria-label="Restore terminal rail"]')]
          .find(button=>!button.closest('[hidden]')&&button.getBoundingClientRect().width>0);
        if(!(control instanceof HTMLButtonElement))throw new Error('capacity-tagged-resize-control');
        control.click();return true;
      })()`)
      const value = await receipt('resize', sequence)
      if (value.receivedAtMs < startedAtMs)
        throw new Error('capacity-tagged-resize-before-dispatch')
      if (value.columns === before.columns && value.rows === before.rows)
        throw new Error('capacity-tagged-resize-grid-unchanged')
      accept(value)
      const observed = await observe(value, 'bottom')
      return {
        startedAtMs,
        ...observed,
        expectedInputSequence: sequence,
        observedInputSequence: observed.tag.sequence,
      }
    }
    const scroll = async (direction: 'up' | 'down') => {
      const layout = await readCapacityTerminalLayout(win, terminal, native)
      if (layout.columns !== current.columns || layout.rows !== current.rows)
        throw new Error('capacity-tagged-scroll-source-geometry')
      const previous = scrollOffset
      scrollOffset = Math.max(
        0,
        scrollOffset + (direction === 'up' ? layout.rows : -layout.rows),
      )
      if (previous === scrollOffset) throw new Error('capacity-tagged-scroll-no-change')
      const expected = tagForRow(current.row - layout.rows + 1 - scrollOffset)
      const expectedInputSequence = ++scrollInputSequence
      const startedAtMs = performance.now()
      await win.webContents.executeJavaScript(`(()=>{
        const engine=document.querySelector('.terminal-surface.active .terminal-engine-host');
        if(!(engine instanceof HTMLElement))throw new Error('capacity-tagged-scroll-control');
        const b=engine.getBoundingClientRect();
        engine.dispatchEvent(new WheelEvent('wheel',{deltaMode:2,deltaY:${direction === 'up' ? -1 : 1},
          clientX:b.x+b.width/2,clientY:b.y+b.height/2,bubbles:true,cancelable:true}));return true;
      })()`)
      // Historical content keeps its original emission geometry. The current
      // viewport is independently pinned to the latest actual PTY observation.
      const observed = await observe(expected, 'top', current)
      const observedInputSequence: unknown = await win.webContents.executeJavaScript(
        'window.__hvirCapacityWheelObservation.sequence',
      )
      if (observedInputSequence !== expectedInputSequence)
        throw new Error('capacity-tagged-wheel-input-sequence')
      return { startedAtMs, ...observed, expectedInputSequence, observedInputSequence }
    }
    return {
      terminal,
      initial,
      initialFrame,
      captureCalls,
      command,
      resize,
      scroll,
      dispose: async () => {
        try {
          await write('\u0003')
        } finally {
          source.dispose()
          await host.removeFile(producer, { ignoreMissing: true })
        }
      },
    }
  } catch (error) {
    source.dispose()
    await host.removeFile(producer, { ignoreMissing: true })
    throw error
  }
}

/** Small separately labelled diagnostic before any fixed acceptance population. */
export async function diagnoseCapacityTerminalTags(
  win: BrowserWindow,
  supervisor: PtySupervisor,
  host: ProjectHost,
  fixture: HostPath,
  native?: NativeTerminalApplication,
): Promise<void> {
  const active = await createCapacityTerminalFixture(
    win,
    supervisor,
    host,
    fixture,
    native,
  )
  const samples: unknown[] = []
  try {
    for (let sequence = 1; sequence <= 3; sequence++)
      samples.push({ kind: 'output', ...(await active.command('output', sequence)) })
    samples.push({ kind: 'echo', ...(await active.command('echo', 4)) })
    samples.push({ kind: 'resize', ...(await active.resize(5)) })
    samples.push({ kind: 'scroll-up', ...(await active.scroll('up')) })
    samples.push({ kind: 'scroll-down', ...(await active.scroll('down')) })
  } finally {
    console.log(
      '[smoke:capacity:tagged-diagnostic] ' +
        JSON.stringify({
          diagnosticOnly: true,
          controlledComparisonQualified: false,
          physicalPresentationQualified: false,
          initial: active.initial,
          initialLayout: active.initialFrame.layout,
          samples,
          captures: active.captureCalls,
        }),
    )
    await active.dispose()
  }
}
