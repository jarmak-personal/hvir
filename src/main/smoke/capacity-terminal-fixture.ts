import {
  capacityTerminalMeasurement,
  type CapacityTerminalScrollProof,
} from './capacity-terminal-measurement'
import type { BrowserWindow } from 'electron'
import { dirnameHostPath, joinHostPath, type HostPath } from '../../shared/host-path'
import type { ProjectHost } from '../project-host/project-host'
import type { PtySupervisor } from '../pty/pty-supervisor'
import type { NativeTerminalApplication } from '../terminal/native-terminal-application'
import { addCapacityTerminals, activateCapacityTerminal } from './capacity-terminals'
import { measureAdditionalTerminalReadiness } from './capacity-terminal-readiness'
import { observeCapacityNativeWheel } from './capacity-native-wheel-observation'
import { focusSmokeWindow } from './window-focus'
import {
  capacityTerminalTaggedProducer,
  CAPACITY_TERMINAL_TAG_CELL_COUNT,
  capacityTerminalTagCellCount,
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
  type CapacityTerminalLayout,
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
  options?: { readonly profile: 'large-viewport' },
) {
  if (options && !native) throw new Error('capacity-content-wheel-requires-native')
  const profile = options?.profile
  const source = observeCapacityTerminalSource()
  const wheel = native && observeCapacityNativeWheel(native)
  const producer = joinHostPath(
    dirnameHostPath(existingFixture),
    '.hvir-capacity-terminal-producer.cjs',
  )
  try {
    await host.writeFile(producer, capacityTerminalTaggedProducer(profile))
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
      const state={sequence:0,trace:false,events:[]};
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
      state?: (
        layout: CapacityTerminalLayout,
      ) => Promise<CapacityTerminalScrollProof | undefined>,
    ) => {
      let firstMatchingVisibleFrameAtMs: number | undefined
      let lastObserved: string | undefined
      let lastLayout: CapacityTerminalLayout | undefined
      let lastPixelProbe
      try {
        return await wait(
          async () => {
            assertActor()
            const layout = await readCapacityTerminalLayout(win, terminal, native)
            lastLayout = layout
            const stateProof = state ? await state(layout) : undefined
            const stateCheckedAtMs = performance.now()
            const captured = await captureCapacityTerminalTag(
              win,
              layout,
              viewport === 'top' ? 0 : layout.rows - 1,
              profile,
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
            firstMatchingVisibleFrameAtMs ??= captured.completedAtMs
            if (state && stateProof === undefined) return
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
              firstMatchingVisibleFrameAtMs,
              stateCheckedAtMs,
              stateProof,
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
        let coveringControls: unknown
        if (lastLayout) {
          const points = {
            x: lastLayout.x + lastLayout.paddingLeft,
            y:
              lastLayout.y +
              lastLayout.paddingTop +
              ((viewport === 'top' ? 0 : lastLayout.rows - 1) + 0.5) *
                lastLayout.cellHeight,
            cellWidth: lastLayout.cellWidth,
            count: capacityTerminalTagCellCount(profile),
          }
          coveringControls = await win.webContents
            .executeJavaScript(
              `(()=>{
            const p=${JSON.stringify(points)};
            const nav=document.querySelector('.terminal-surface.active .terminal-semantic-navigation');
            const b=nav?.getBoundingClientRect();
            return {webViewport:document.querySelector('.terminal-surface.active .terminal-engine-host')?.__hvirTerminalViewport??null,
              wheelTrace:window.__hvirCapacityWheelObservation?.trace?window.__hvirCapacityWheelObservation.events:undefined,
              semanticNavigation: b?{x:b.x,y:b.y,width:b.width,height:b.height,
              visibility:getComputedStyle(nav).visibility,display:getComputedStyle(nav).display}:null,
              cells:Array.from({length:p.count},(_,index)=>{const x=p.x+(index+0.5)*p.cellWidth;
                const hit=document.elementFromPoint(x,p.y);
                return {index,x,y:p.y,insideSemanticNavigation:!!nav&&!!hit&&nav.contains(hit)};})};
          })()`,
            )
            .catch(() => ({ observationUnavailable: true }))
        }
        console.log(
          '[smoke:capacity:tagged-witness-failure] ' +
            JSON.stringify({
              expected,
              lastPixelProbe,
              lastObserved,
              lastLayout,
              coveringControls,
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
      const layout = await wait(
        () => readCapacityTerminalLayout(win, terminal, native),
        'scroll-applied-layout',
      )
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
      if (
        native &&
        (!layout.viewId || !layout.nativeEpoch || layout.attachment === undefined)
      )
        throw new Error('capacity-tagged-wheel-grant-missing')
      const arm = wheel?.arm({
        viewId: layout.viewId!,
        owner: { id: terminal.ownerId, generation: terminal.ownerGeneration },
      })
      const startedAtMs = performance.now()
      try {
        // The separate large-viewport profile requests content rows in CSS
        // pixels. Its padded pane can contain an extra partial row; the fixed
        // comparison retains its original DOM page gesture unchanged.
        const delta = direction === 'up' ? -1 : 1
        const deltaY = options ? delta * layout.rows * layout.cellHeight : delta
        await win.webContents.executeJavaScript(`(()=>{
        const engine=document.querySelector('.terminal-surface.active .terminal-engine-host');
        if(!(engine instanceof HTMLElement))throw new Error('capacity-tagged-scroll-control');
        const b=engine.getBoundingClientRect();
        const state=window.__hvirCapacityWheelObservation;
        const before=state.trace?engine.__hvirTerminalViewport?.viewportY:undefined;
        engine.dispatchEvent(new WheelEvent('wheel',{deltaMode:${options ? 0 : 2},deltaY:${deltaY},
          clientX:b.x+b.width/2,clientY:b.y+b.height/2,bubbles:true,cancelable:true}));
        if(state.trace){if(state.events.length>=32)throw new Error('capacity-scroll-trace-bound');
          state.events.push({sequence:state.sequence,before,afterDispatch:engine.__hvirTerminalViewport?.viewportY,atEpochMs:performance.timeOrigin+performance.now()});}
        return true;
      })()`)
        // Historical content keeps its original emission geometry. The current
        // viewport is independently pinned to the latest actual PTY observation.
        const observed = await observe(expected, 'top', current, async (applied) => {
          if (!native) {
            return applied.webViewportY === scrollOffset
              ? {
                  engine: 'web',
                  viewportY: applied.webViewportY,
                  expectedViewportY: scrollOffset,
                }
              : undefined
          }
          if (
            applied.viewId !== layout.viewId ||
            applied.nativeEpoch !== layout.nativeEpoch ||
            applied.attachment !== layout.attachment
          )
            throw new Error('capacity-tagged-wheel-grant-changed')
          const completion = arm?.read()
          if (!completion) return
          if (
            completion.failed ||
            completion.refused ||
            !completion.requestedMutation ||
            completion.sequence !== expectedInputSequence
          )
            throw new Error('capacity-tagged-wheel-native-completion')
          const owner = { id: terminal.ownerId, generation: terminal.ownerGeneration }
          const retained = await native.inspectRetained(terminal.id, owner)
          const renderer = await native.rendererInfo(terminal.id, owner)
          if (
            retained.ioAppliedMutation < completion.requestedMutation ||
            !renderer.lastFrame ||
            renderer.lastFrame.snapshotMutation < completion.requestedMutation
          )
            return
          return {
            engine: 'native',
            sequence: completion.sequence,
            requestedMutation: completion.requestedMutation,
            ioAppliedMutation: retained.ioAppliedMutation,
            frameSnapshotMutation: renderer.lastFrame.snapshotMutation,
            viewId: applied.viewId!,
            nativeEpoch: applied.nativeEpoch!,
            attachment: applied.attachment!,
            geometrySerial: applied.geometrySerial!,
            frameGeometrySerial: renderer.lastFrame.geometrySerial,
          }
        })
        const inputState = (await win.webContents.executeJavaScript(`(()=>{
        const state=window.__hvirCapacityWheelObservation;
        const engine=document.querySelector('.terminal-surface.active .terminal-engine-host');
        return {sequence:state.sequence,...(state.trace?{viewport:{
          events:state.events,atMatchingCapture:engine?.__hvirTerminalViewport?.viewportY,
          atEpochMs:performance.timeOrigin+performance.now()}}:{})};
      })()`)) as { sequence: number; viewport?: unknown }
        const observedInputSequence = inputState.sequence
        if (observedInputSequence !== expectedInputSequence)
          throw new Error('capacity-tagged-wheel-input-sequence')
        return {
          startedAtMs,
          ...observed,
          expectedInputSequence,
          observedInputSequence,
          ...(inputState.viewport === undefined
            ? {}
            : { webViewportState: inputState.viewport }),
        }
      } finally {
        arm?.close()
      }
    }
    return {
      terminal,
      initial,
      initialFrame,
      captureCalls,
      appliedLayout: () =>
        wait(async () => {
          assertActor()
          const layout = await readCapacityTerminalLayout(win, terminal, native)
          assertActor()
          return layout
        }, 'fixture-applied-layout'),
      command,
      resize,
      scroll,
      dispose: async () => {
        try {
          await write('\u0003')
        } finally {
          wheel?.dispose()
          source.dispose()
          await host.removeFile(producer, { ignoreMissing: true })
        }
      },
    }
  } catch (error) {
    wheel?.dispose()
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
  sequenceDiagnostic = false,
): Promise<void> {
  const active = await createCapacityTerminalFixture(
    win,
    supervisor,
    host,
    fixture,
    native,
  )
  const samples: Array<{ kind: string } & Awaited<ReturnType<typeof active.scroll>>> = []
  const placements: unknown[] = []
  const placement = async (label: string, value: typeof active.initialFrame) => {
    const layout = value.layout
    const tagRect = {
      x: layout.x + layout.paddingLeft,
      y: layout.y + layout.paddingTop + (layout.rows - 0.5) * layout.cellHeight,
      width: CAPACITY_TERMINAL_TAG_CELL_COUNT * layout.cellWidth,
      height: 2,
    }
    const observed = (await win.webContents.executeJavaScript(`(()=>{
      const r=${JSON.stringify(tagRect)};
      const nav=document.querySelector('.terminal-surface.active .terminal-semantic-navigation');
      if(!nav)return {visible:false};const b=nav.getBoundingClientRect(),style=getComputedStyle(nav);
      return {visible:style.visibility==='visible'&&style.display!=='none',
        navigation:{x:b.x,y:b.y,width:b.width,height:b.height},tagRectangle:r,
        overlap:r.x<b.right&&r.x+r.width>b.left&&r.y<b.bottom&&r.y+r.height>b.top};
    })()`)) as { visible: boolean; overlap?: boolean }
    placements.push({
      label,
      observed,
      actualCaptureRectangle: value.captured.pixelProbe.rectangle,
    })
    if (!observed.visible || observed.overlap)
      throw new Error('capacity-tagged-visible-control-placement')
  }
  try {
    await placement('initial', active.initialFrame)
    if (sequenceDiagnostic) {
      if (native) {
        await measureAdditionalTerminalReadiness(win, supervisor, 'baseline', 1)
        await activateCapacityTerminal(win, 0)
        await active.appliedLayout()
      }
      {
        await win.webContents.executeJavaScript(
          'window.__hvirCapacityWheelObservation.trace=true;true',
        )
        for (let index = 0; index < 10; index++) {
          const value = await active.scroll(index % 2 === 0 ? 'up' : 'down')
          samples.push({ kind: 'sequence-scroll', ...value })
        }
      }
    }
    for (let sequence = 1; sequence <= 3; sequence++)
      samples.push({ kind: 'output', ...(await active.command('output', sequence)) })
    samples.push({ kind: 'echo', ...(await active.command('echo', 4)) })
    const collapsed = await active.resize(5)
    samples.push({ kind: 'resize', ...collapsed })
    await placement('collapsed', collapsed)
    const restored = await active.resize(6)
    samples.push({ kind: 'resize', ...restored })
    await placement('restored', restored)
    samples.push({ kind: 'scroll-up', ...(await active.scroll('up')) })
    samples.push({ kind: 'scroll-down', ...(await active.scroll('down')) })
  } finally {
    console.log(
      '[smoke:capacity:tagged-diagnostic] ' +
        JSON.stringify({
          diagnosticOnly: true,
          sequenceDiagnostic,
          controlledComparisonQualified: false,
          physicalPresentationQualified: false,
          initial: active.initial,
          initialLayout: active.initialFrame.layout,
          samples,
          serializedMeasurements: samples.map((sample, sequence) => ({
            kind: sample.kind,
            measurement: capacityTerminalMeasurement(sample, sequence),
          })),
          placements,
          captures: active.captureCalls,
        }),
    )
    await active.dispose()
  }
}
