import type { BrowserWindow } from 'electron'
import type { NativeTerminalApplication } from '../terminal/native-terminal-application'
import type { NativeTerminalStatus } from '../../shared/native-terminal'
import type { ManagedPty, PtySupervisor } from '../pty/pty-supervisor'
import type { TerminalDeliverySample } from './capacity-terminals'
import { activateCapacityTerminal } from './capacity-terminals'
import { verifyNativeTerminalAppearance } from './native-terminal-appearance'
import { verifyNativeTerminalQuery } from './native-terminal-query'
import { nativeSelectionBrowser } from './native-terminal-selection-browser'
import { matchesCapacityFrameColor } from './capacity-frame-observation'
import type { CapacityPerformanceMode } from './capacity-performance'
import {
  CAPACITY_RETAINED_HISTORY_ROWS,
  capacityRetainedHistoryProducer,
} from './capacity-terminals'
import {
  sameNativeTerminalView,
  validNativeTerminalViewGrant,
  type NativeTerminalViewGrant,
} from '../../shared/native-terminal-presentation'

interface NativeCapacityView {
  readonly sessionId: string
  readonly viewId: string
  readonly visible: boolean
  readonly canvases: number
  readonly delivery: TerminalDeliverySample
  readonly semanticRegions: number
  readonly semanticRegionLimit: number
}
export interface NativeCapacitySample extends NativeCapacityView {
  readonly instanceId: string
  readonly handle: string
  readonly appliedSequence: number
  readonly appearanceSerial: number
  /** Accepted receiver submission, not compositor observation or physical paint. */
  readonly receiverDraws: number
  readonly currentDrawnGrant: boolean
}
export interface NativeCapacityActivityReport {
  readonly engine: 'native'
  readonly hiddenPanes: number
  readonly hiddenAppliedSequenceDelta: number
  readonly hiddenReceiverDrawDelta: number
  readonly visibleReceiverDrawDelta: number
  readonly nativeDataEvents: number
  readonly deliveryCallbacks: number
  readonly peakBufferedBytes: number
  readonly semanticCapExercised: true
  readonly physicalReclamationQualified: false
}

/** Existing capacity contracts at the actual native parser/receiver seam. Concrete
 * web render/shaping counters are deliberately not invented for this engine. */
export function createNativeCapacityTerminals(
  win: BrowserWindow,
  supervisor: PtySupervisor,
  native: NativeTerminalApplication,
) {
  const targets = native.targets
  let observing = true
  const create = targets.create
  const createDescriptor = Object.getOwnPropertyDescriptor(targets, 'create')
  const grants = new Map<
    string,
    {
      grant: NativeTerminalViewGrant
      frame: Parameters<typeof targets.acknowledge>[0]
      current(): boolean
    }
  >()
  const observedCreate: typeof create = (...args) => {
    const target = create.apply(targets, args)
    const publish = target.publishGrant
    let viewId: string | undefined
    target.publishGrant = (grant, refit) => {
      publish.call(target, grant, refit)
      if (!observing) return
      if (grant) {
        viewId = grant.viewId
        grants.set(viewId, {
          grant: { ...grant },
          frame: target.frame,
          current: target.isCurrent,
        })
      } else if (viewId) grants.delete(viewId)
    }
    return target
  }
  targets.create = observedCreate
  const acknowledge = targets.acknowledge
  const descriptor = Object.getOwnPropertyDescriptor(targets, 'acknowledge')
  const draws = new Map<string, number>()
  const observedAcknowledge: typeof acknowledge = function (frame, value) {
    acknowledge.call(targets, frame, value)
    const ack = value as {
      kind?: unknown
      screen?: unknown
      grant?: NativeTerminalViewGrant
    }
    if (
      ack?.kind !== 'drawn' ||
      !validNativeTerminalViewGrant(ack.grant) ||
      (ack.screen !== 0 && ack.screen !== 1)
    )
      return
    const granted = grants.get(ack.grant.viewId)
    if (
      !granted ||
      granted.frame !== frame ||
      !granted.current() ||
      !sameNativeTerminalView(granted.grant, ack.grant)
    )
      return
    const accepted = targets.drawn(ack.grant.viewId, frame)
    if (!accepted || accepted.geometrySerial !== ack.grant.geometrySerial) return
    if (!draws.has(ack.grant.viewId) && draws.size >= 128)
      throw new Error('capacity-native-draw-observation-bound')
    draws.set(ack.grant.viewId, (draws.get(ack.grant.viewId) ?? 0) + 1)
  }
  targets.acknowledge = observedAcknowledge
  const owner = (terminal: ManagedPty) => ({
    id: terminal.ownerId,
    generation: terminal.ownerGeneration,
  })
  const evaluate = <T>(source: string): Promise<T> =>
    win.webContents.executeJavaScript(`(()=>{${source}})()`)
  const snapshot = async (): Promise<readonly NativeCapacitySample[]> => {
    const views = await evaluate<NativeCapacityView[]>(`
      return [...document.querySelectorAll('.terminal-surface')].map(surface=>{
        const engine=surface.querySelector('.native-terminal-pane');
        const mount=engine?.querySelector('[id^="native-terminal-"]');
        const delivery=surface.querySelector('.terminal-container')?.__hvirTerminalDelivery;
        if(!engine||!mount||!delivery)throw new Error('capacity-native-view-missing');
        return {sessionId:surface.getAttribute('data-terminal-session')||'',
          viewId:mount.id.slice('native-terminal-'.length),
          visible:getComputedStyle(surface).visibility==='visible',
          canvases:mount.querySelectorAll('canvas').length,delivery,
          semanticRegions:Number(surface.querySelector('.terminal-container')?.dataset.terminalSemanticRegions??-1),
          semanticRegionLimit:Number(surface.querySelector('.terminal-container')?.dataset.terminalSemanticRegionLimit??-1)};
      });`)
    return Promise.all(
      views.map(async (view) => {
        const terminal = supervisor.get(view.sessionId)
        const state = native.sessions.get(view.sessionId)
        if (
          !terminal ||
          !state ||
          state.unavailable ||
          state.retiring ||
          state.session.instanceId !== terminal.instanceId
        )
          throw new Error('capacity-native-instance-mismatch')
        const status = await native.inspectRetained(terminal.id, owner(terminal))
        assertNativeCapacityStatus(status)
        return {
          ...view,
          instanceId: terminal.instanceId,
          handle: state.handle,
          appliedSequence: status.appliedSequence,
          appearanceSerial: status.appliedAppearanceSerial,
          receiverDraws: draws.get(view.viewId) ?? 0,
          currentDrawnGrant: !!targets.drawn(view.viewId, win.webContents.mainFrame),
        }
      }),
    )
  }
  const ready = async () => {
    await wait(async () => {
      const samples = await snapshot()
      return (
        samples.length === 12 &&
        samples.filter((item) => item.visible).length === 1 &&
        samples.every((item) =>
          item.visible
            ? item.canvases === 1 && item.currentDrawnGrant
            : item.canvases === 0 && !item.currentDrawnGrant,
        )
      )
    }, 'one-visible-eleven-hidden')
  }
  // Failure-only observation: never changes the final readiness predicate or its deadline.
  const reportSessionsReadinessFailure = async (): Promise<void> => {
    let timer: ReturnType<typeof setTimeout> | undefined
    let finished = false
    const partial: { dom?: unknown; actors: unknown[] } = { actors: [] }
    try {
      const observation = await Promise.race([
        (async () => {
          const dom = await evaluate<{
            views: Array<{ sessionId: string; viewId: string }>
            [key: string]: unknown
          }>(`
            const limit=32, id=value=>typeof value==='string'?value.slice(0,128):'';
            const all=[...document.querySelectorAll('.terminal-surface')];
            const tabs=[...document.querySelectorAll('.project-tab-main')];
            const rows=[...document.querySelectorAll('.terminal-list-row')];
            const box=node=>{const b=node.getBoundingClientRect();return {
              width:Math.round(b.width*100)/100,height:Math.round(b.height*100)/100};};
            const first=tabs[0];
            return {sessionsActive:!!document.querySelector('.sessions-destination.active'),
              sessionsDetail:!!document.querySelector('.sessions-terminal-detail'),
              projectTabs:tabs.length,activeProjectTabs:tabs.slice(0,limit).flatMap((node,index)=>
                node.getAttribute('aria-current')==='page'?[index]:[]),
              activeWorkspaceTabs:[...document.querySelectorAll('.workspace-tab')].slice(0,limit)
                .flatMap((node,index)=>node.classList.contains('active')?[index]:[]),
              firstProjectTab:{present:!!first,disabled:first instanceof HTMLButtonElement?first.disabled:null,
                connected:first?.isConnected??false},
              activeTerminalRows:rows.slice(0,limit).flatMap((node,index)=>node.classList.contains('active')?[index]:[]),
              totalSurfaces:all.length,truncated:all.length>limit||tabs.length>limit||rows.length>limit,
              globalCanvases:document.querySelectorAll('.native-terminal-pane canvas').length,
              detailCanvases:document.querySelectorAll('.sessions-detail-terminal-container .native-terminal-pane canvas').length,
              views:all.slice(0,limit).map(surface=>{
                const engine=surface.querySelector('.native-terminal-pane');
                const mount=engine?.querySelector('[id^="native-terminal-"]');
                const style=getComputedStyle(surface);
                const notice=mount?.querySelector('[role="status"]');
                return {sessionId:id(surface.getAttribute('data-terminal-session')),
                  viewId:id(mount?.id.slice('native-terminal-'.length)),
                  connected:surface.isConnected,visible:style.visibility==='visible',
                  displayed:style.display!=='none',classVisible:surface.classList.contains('visible'),
                  surfaceBounds:box(surface),mountBounds:mount?box(mount):null,
                  canvases:mount?.querySelectorAll('canvas').length??0,
                  unavailableNotice:notice?.textContent==='Terminal unavailable',
                  inputReady:engine?.__hvirNativeTerminalAppearance?.applied===true};
              })};`)
          if (finished) return { outcome: 'observation-timeout' as const }
          partial.dom = dom
          await Promise.all(
            dom.views.slice(0, 32).map(async (view) => {
              const terminal = supervisor.get(view.sessionId)
              const state = native.sessions.get(view.sessionId)
              const grant = grants.get(view.viewId)
              const facts = {
                sessionId: view.sessionId,
                viewId: view.viewId,
                managed: !!terminal,
                native: !!state,
                instanceId: terminal?.instanceId,
                nativeInstanceId: state?.session.instanceId,
                handle: state?.handle,
                owner: terminal && owner(terminal),
                unavailable: state?.unavailable,
                retiring: state?.retiring,
                grant: grant?.grant,
                targetCurrent: grant?.current() ?? false,
                targetFrameMatches: grant?.frame === win.webContents.mainFrame,
                drawn: targets.drawn(view.viewId, win.webContents.mainFrame),
                receiverDraws: draws.get(view.viewId) ?? 0,
              }
              const actor: typeof facts & { status: unknown } = {
                ...facts,
                status: terminal ? 'pending' : 'missing-managed',
              }
              partial.actors.push(actor)
              if (!terminal) return
              try {
                const status = await native.inspectRetained(terminal.id, owner(terminal))
                actor.status = {
                  failure: status.failure,
                  closing: status.closing,
                  rendererHealth: status.rendererHealth,
                  presentationFailure: status.presentationFailure,
                  geometryFailureSerial: status.geometryFailureSerial,
                  geometry: status.geometry,
                  appliedSequence: status.appliedSequence,
                  ioAppliedMutation: status.ioAppliedMutation,
                }
              } catch {
                actor.status = 'observation-error'
              }
            }),
          )
          return { outcome: 'observed' as const }
        })(),
        new Promise<{ outcome: 'observation-timeout' }>((resolve) => {
          timer = setTimeout(() => resolve({ outcome: 'observation-timeout' }), 1000)
        }),
      ])
      console.log(
        '[smoke:capacity:native-sessions-readiness] ' +
          JSON.stringify({ ...observation, ...partial }),
      )
    } catch {
      try {
        console.log(
          '[smoke:capacity:native-sessions-readiness] ' +
            JSON.stringify({ outcome: 'observation-error', ...partial }),
        )
      } catch {
        /* Preserve original readiness failure. */
      }
    } finally {
      finished = true
      if (timer !== undefined) clearTimeout(timer)
    }
  }
  return {
    snapshot,
    async columns() {
      const terminal = supervisor.list()[0]
      if (!terminal) throw new Error('capacity-native-reflow-terminal')
      const status = await native.inspectRetained(terminal.id, owner(terminal))
      assertNativeCapacityStatus(status)
      return status.geometry.columns
    },
    async hiddenSettles() {
      await ready()
      const before = await snapshot()
      await new Promise((resolve) => setTimeout(resolve, 1200))
      const after = await snapshot()
      for (const sample of after.filter((item) => !item.visible)) {
        const previous = before.find((item) => item.sessionId === sample.sessionId)
        if (
          !previous ||
          sample.receiverDraws !== previous.receiverDraws ||
          sample.canvases ||
          sample.currentDrawnGrant
        )
          throw new Error('capacity-native-hidden-receiver-work')
      }
    },
    async sessions() {
      const before = await snapshot()
      await evaluate(`document.querySelector('.sessions-destination')?.click();`)
      await wait(
        () =>
          evaluate(
            `return document.querySelectorAll('.session-card').length>=12 && [...document.querySelectorAll('.session-card button')].filter(node=>node.textContent?.trim()==='Interact').length===12;`,
          ),
        'sessions-twelve',
      )
      await wait(
        () =>
          evaluate(
            `return document.querySelectorAll('.native-terminal-pane canvas').length===0;`,
          ),
        'sessions-overview-hidden',
      )
      await evaluate(
        `const button=[...document.querySelectorAll('.session-card button')].find(node=>node.textContent?.trim()==='Interact');if(!(button instanceof HTMLButtonElement))throw new Error('capacity-native-interact');button.click();`,
      )
      await wait(
        () =>
          evaluate(
            `return document.querySelectorAll('.sessions-detail-terminal-container .native-terminal-pane canvas').length===1 && document.querySelectorAll('.native-terminal-pane canvas').length===1;`,
          ),
        'sessions-one-consumer',
      )
      await evaluate(
        `const button=[...document.querySelectorAll('.sessions-detail-actions button')].find(node=>node.textContent?.trim()==='Close');if(!(button instanceof HTMLButtonElement))throw new Error('capacity-native-sessions-close');button.click();`,
      )
      await wait(
        () =>
          evaluate(
            `return !document.querySelector('.sessions-terminal-detail') && document.querySelectorAll('.native-terminal-pane canvas').length===0;`,
          ),
        'sessions-release',
      )
      await evaluate(`document.querySelector('.project-tab-main')?.click();`)
      try {
        await ready()
      } catch (error) {
        await reportSessionsReadinessFailure()
        throw error
      }
      assertNativeCapacityIdentity(before, await snapshot())
      return {
        actualNative: true,
        retainedInstances: before.length,
        sessionsPresented: 1,
        hiddenMountedConsumers: 0,
        physicalReclamationQualified: false,
      }
    },
    async appearance() {
      const before = await snapshot()
      const terminal = supervisor.list()[0]
      if (!terminal) throw new Error('capacity-native-appearance-terminal')
      // Sessions interaction can legitimately focus a differently sorted actor.
      // Bind this qualification to the exact managed actor it will inspect.
      await activateCapacityTerminal(win, 0)
      try {
        await wait(async () => {
          const active = (await snapshot()).find((item) => item.sessionId === terminal.id)
          return (
            !!active &&
            active.instanceId === terminal.instanceId &&
            active.visible &&
            active.canvases === 1 &&
            active.currentDrawnGrant
          )
        }, 'appearance-target-drawn')
      } catch (error) {
        console.log(
          '[smoke:capacity:native-appearance-owner] ' +
            JSON.stringify({
              targetSession: terminal.id,
              targetInstance: terminal.instanceId,
              visible: (await snapshot())
                .filter((item) => item.visible)
                .map((item) => ({
                  sessionId: item.sessionId,
                  instanceId: item.instanceId,
                  currentDrawnGrant: item.currentDrawnGrant,
                  canvases: item.canvases,
                })),
            }),
        )
        throw error
      }
      await evaluate(`const state={samples:[],pending:new Set()};
        const click=event=>{
          const target=event.target instanceof Element?event.target.closest('button'):null;
          if(!target||!(target.classList.contains('theme-toggle')||
            (target.closest('.settings-dialog')&&target.textContent?.trim()==='Save app settings')))return;
          const started=performance.now();
          queueMicrotask(()=>{
            const synchronousMs=performance.now()-started;
            const timer=setTimeout(()=>{
              state.pending.delete(timer);
              state.samples.push({synchronousMs,eventLoopDelayMs:performance.now()-started});
            },0);state.pending.add(timer);
          });
        };
        state.dispose=()=>{document.removeEventListener('click',click,true);
          for(const timer of state.pending)clearTimeout(timer);state.pending.clear();};
        document.addEventListener('click',click,true);globalThis.__hvirNativeCapacityAppearance=state;`)
      const appearance = await verifyNativeTerminalAppearance(
        win,
        supervisor,
        native,
        terminal,
      ).then(
        (value) => ({ ok: true, value }) as const,
        (error: unknown) => ({ ok: false, error }) as const,
      )
      const observation = await evaluate<{
        samples: { synchronousMs: number; eventLoopDelayMs: number }[]
        pending: number
      }>(`const state=globalThis.__hvirNativeCapacityAppearance;
          if(!state)throw new Error('capacity-native-appearance-observer');
          try{return {samples:state.samples,pending:state.pending.size};}
          finally{state.dispose();delete globalThis.__hvirNativeCapacityAppearance;}`).then(
        (value) => ({ ok: true, value }) as const,
        (error: unknown) => ({ ok: false, error }) as const,
      )
      if (!appearance.ok) throw appearance.error
      if (!observation.ok) throw observation.error
      const proof = appearance.value,
        timing = observation.value
      if (
        !timing.samples.length ||
        timing.pending ||
        timing.samples.some(
          (sample) =>
            !Number.isFinite(sample.synchronousMs) ||
            !Number.isFinite(sample.eventLoopDelayMs) ||
            sample.synchronousMs > 100 ||
            sample.eventLoopDelayMs > 250,
        )
      )
        throw new Error('capacity-native-appearance-renderer-budget')
      await ready()
      const after = await snapshot()
      assertNativeCapacityIdentity(before, after)
      if (
        after.some(
          (item) =>
            item.appearanceSerial <=
            before.find((old) => old.sessionId === item.sessionId)!.appearanceSerial,
        )
      )
        throw new Error('capacity-native-retained-appearance-not-applied')
      return {
        actualNative: true,
        retainedInstances: after.length,
        updatedInstances: after.length,
        settingsClickTiming: timing.samples,
        visiblePixelAndHiddenReveal: proof,
      }
    },
    activity: verifyNativeCapacityActivity,
    async retainedHistory(unicodeWrapped: boolean) {
      await activateCapacityTerminal(win, 0)
      const terminal = supervisor.list()[0]
      if (!terminal) throw new Error('capacity-native-history-terminal')
      const previousTitleSerial =
        native.sessions.get(terminal.id)?.title?.eventSerial ?? 0
      const deadline = performance.now() + 60_000
      supervisor.write(
        terminal.id,
        terminal.ownerId,
        capacityRetainedHistoryProducer(unicodeWrapped),
        terminal.ownerGeneration,
      )
      try {
        await wait(
          () => {
            const state = native.sessions.get(terminal.id)
            return (
              state?.title?.title === 'Capacity retained ready' &&
              state.title.eventSerial > previousTitleSerial
            )
          },
          'history-retained-cap',
          deadline,
        )
        const started = performance.now()
        await evaluate(`const surface=document.querySelector('.terminal-surface.active');
          const engine=surface?.querySelector('.native-terminal-pane');
          if(!engine)throw new Error('capacity-native-history-engine');
          engine.dispatchEvent(new KeyboardEvent('keydown',{key:'f',code:'KeyF',shiftKey:true,
            ...(/Mac/.test(navigator.platform)?{metaKey:true}:{ctrlKey:true}),bubbles:true,cancelable:true}));`)
        await wait(
          () =>
            evaluate(
              `return !!document.querySelector('.terminal-surface.active [aria-label="Find in terminal"]');`,
            ),
          'history-search-open',
          deadline,
        )
        const query = async (text: string, expected: string) => {
          await evaluate(`const input=document.querySelector('.terminal-surface.active [aria-label="Find in terminal"]');
            if(!(input instanceof HTMLInputElement))throw new Error('capacity-native-history-query');
            Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,'value').set.call(input,${JSON.stringify(text)});
            input.dispatchEvent(new Event('input',{bubbles:true}));`)
          await wait(
            () =>
              evaluate(
                `return document.querySelector('.terminal-surface.active .terminal-search-status')?.textContent?.trim()===${JSON.stringify(expected)};`,
              ),
            'history-search-result',
            deadline,
          )
        }
        await query('capacity-retained-fill-119999', '1 of 1')
        await query('capacity-retained-fill-000000', 'No matches')
        await evaluate(
          `document.querySelector('.terminal-surface.active [aria-label="Close terminal search"]')?.click();`,
        )
        return {
          actualNative: true,
          emittedRows: CAPACITY_RETAINED_HISTORY_ROWS,
          newestMatches: 1,
          oldestMatches: 0,
          evictionObserved: true,
          durationMs: performance.now() - started,
          unicodeWrapped,
        }
      } finally {
        supervisor.write(terminal.id, terminal.ownerId, '\n', terminal.ownerGeneration)
      }
    },
    async search(mode: CapacityPerformanceMode) {
      const terminal = supervisor.list()[0]
      if (!terminal) throw new Error('capacity-native-search-terminal')
      await activateCapacityTerminal(win, 0)
      const before = await snapshot()
      const result = await verifyNativeTerminalQuery(
        win,
        supervisor,
        native,
        terminal,
        mode,
      )
      assertNativeCapacityIdentity(before, await snapshot())
      return { ...result, retainedInstances: before.length }
    },
    async synchronizedOutput() {
      const terminal = supervisor.list()[0]
      if (!terminal) throw new Error('capacity-native-sync-terminal')
      await activateCapacityTerminal(win, 0)
      const browser = nativeSelectionBrowser(win, native, terminal)
      await browser.ready()
      const write = (value: string) =>
        supervisor.writeConfirmed(
          terminal.id,
          terminal.ownerId,
          `printf '${[...value].map((character) => '\\' + character.charCodeAt(0).toString(8).padStart(3, '0')).join('')}'\r`,
          terminal.ownerGeneration,
        )
      const text = async () =>
        new TextDecoder().decode(await native.readRetained(terminal.id, owner(terminal)))
      const capturedColor = async (rgb: readonly [number, number, number]) => {
        const layout = await browser.layout()
        const image = await win.webContents.capturePage({
          x: Math.ceil(layout.bounds.x) + 4,
          y: Math.ceil(layout.bounds.y) + 4,
          width: 32,
          height: 4,
        })
        return matchesCapacityFrameColor(image.toBitmap(), rgb)
      }
      let released = false
      const run = async () => {
        await write(
          '\x1b[?2026l\x1b[2J\x1b[H\x1b[48;2;240;16;32m\x1b[2K\x1b[2;1H\x1b[0mHVIR_CAPACITY_SYNC_BASE',
        )
        await wait(
          async () =>
            (await text()).includes('HVIR_CAPACITY_SYNC_BASE') &&
            (await capturedColor([240, 16, 32])),
          'sync-baseline',
        )
        await write(
          '\x1b[?2026h\x1b[H\x1b[48;2;16;32;240m\x1b[2K\x1b[2;1H\x1b[0mHVIR_CAPACITY_SYNC_HELD',
        )
        await wait(
          async () => (await text()).includes('HVIR_CAPACITY_SYNC_HELD'),
          'sync-parser-progress',
        )
        const held = await native.inspectRetained(terminal.id, owner(terminal))
        const started = performance.now()
        let observations = 0
        do {
          const info = await native.rendererInfo(terminal.id, owner(terminal))
          if (info.lastFrame && info.lastFrame.streamSequence >= held.appliedSequence)
            throw new Error('capacity-native-sync-published-held-sequence')
          if (!(await capturedColor([240, 16, 32])))
            throw new Error('capacity-native-sync-changed-consumer-before-commit')
          observations++
        } while (performance.now() - started < 100)
        await write('\x1b[?2026l')
        released = true
        await wait(
          async () => await capturedColor([16, 32, 240]),
          'sync-committed-consumer',
        )
        const committed = await native.inspectRetained(terminal.id, owner(terminal))
        await wait(async () => {
          const latest = await native.inspectRetained(terminal.id, owner(terminal))
          const info = await native.rendererInfo(terminal.id, owner(terminal))
          return (
            !!info.lastFrame &&
            info.lastFrame.streamSequence >= committed.appliedSequence &&
            info.lastFrame.streamSequence === latest.appliedSequence
          )
        }, 'sync-committed-sequence')
        return {
          actualNative: true,
          parserProgress: true,
          heldConsumerUnchanged: true,
          minimumHeldObservationMs: 100,
          observations,
          committedLatestSequence: true,
          physicalPresentationQualified: false,
        }
      }
      const outcome = await run().then(
        (value) => ({ ok: true, value }) as const,
        (error: unknown) => ({ ok: false, error }) as const,
      )
      if (!released) await write('\x1b[?2026l').catch(() => undefined)
      await browser.proof().catch(() => undefined)
      const cleanup = await win.webContents
        .executeJavaScript('window.nativeSelectionProbe?.restore();')
        .then(
          () => ({ ok: true }) as const,
          (error: unknown) => ({ ok: false, error }) as const,
        )
      if (!outcome.ok) throw outcome.error
      if (!cleanup.ok) throw cleanup.error
      return outcome.value
    },
    dispose() {
      observing = false
      if (targets.acknowledge === observedAcknowledge) {
        if (descriptor) Object.defineProperty(targets, 'acknowledge', descriptor)
        else delete (targets as Partial<typeof targets>).acknowledge
      }
      if (targets.create === observedCreate) {
        if (createDescriptor) Object.defineProperty(targets, 'create', createDescriptor)
        else delete (targets as Partial<typeof targets>).create
      }
      draws.clear()
      grants.clear()
    },
  }
}

export function assertNativeCapacityStatus(status: NativeTerminalStatus): void {
  if (
    status.failure ||
    status.inputFailure ||
    status.presentationFailure ||
    status.geometryFailureSerial ||
    status.appearanceFailureSerial ||
    status.closing
  )
    throw new Error('capacity-native-state-failed')
}

export function assertNativeCapacityIdentity(
  before: readonly NativeCapacitySample[],
  after: readonly NativeCapacitySample[],
): void {
  if (
    before.length !== 12 ||
    after.length !== 12 ||
    new Set(before.map((item) => item.sessionId)).size !== 12 ||
    new Set(after.map((item) => item.sessionId)).size !== 12 ||
    after.some(
      (item) =>
        !before.some(
          (old) =>
            old.sessionId === item.sessionId &&
            old.instanceId === item.instanceId &&
            old.handle === item.handle,
        ),
    )
  )
    throw new Error('capacity-native-retained-state-replaced')
}

/** Verify observed native parser/consumer behavior, without pretending that an
 * accepted receiver draw or a removed canvas proves physical GPU reclamation. */
export function verifyNativeCapacityActivity(
  before: readonly NativeCapacitySample[],
  after: readonly NativeCapacitySample[],
  activeFixtureIds: readonly string[],
): NativeCapacityActivityReport {
  assertNativeCapacityIdentity(before, after)
  if (
    after.filter((item) => item.visible).length !== 1 ||
    after.filter((item) => !item.visible).length !== 11
  )
    throw new Error('capacity-native-presentation-topology')
  let hiddenAppliedSequenceDelta = 0,
    hiddenReceiverDrawDelta = 0,
    visibleReceiverDrawDelta = 0,
    nativeDataEvents = 0,
    deliveryCallbacks = 0,
    peakBufferedBytes = 0
  for (const current of after) {
    const previous = before.find((item) => item.sessionId === current.sessionId)!
    const sequenceDelta = current.appliedSequence - previous.appliedSequence
    const drawDelta = current.receiverDraws - previous.receiverDraws
    if (
      [
        current.appliedSequence,
        current.receiverDraws,
        current.delivery.nativeDataEvents,
        current.delivery.deliveryCallbacks,
        current.delivery.bufferedBytes,
        current.delivery.peakBufferedBytes,
      ].some((value) => !Number.isSafeInteger(value) || value < 0)
    )
      throw new Error('capacity-native-observation-invalid')
    if (sequenceDelta < 0 || drawDelta < 0)
      throw new Error('capacity-native-counter-regressed')
    if (
      current.semanticRegionLimit <= 0 ||
      current.semanticRegions !== current.semanticRegionLimit
    )
      throw new Error('capacity-native-semantic-cap-not-exercised')
    if (
      current.delivery.bufferedBytes > 64 * 1024 ||
      current.delivery.peakBufferedBytes > 64 * 1024
    )
      throw new Error('capacity-native-delivery-byte-bound')
    const events = current.delivery.nativeDataEvents - previous.delivery.nativeDataEvents
    const deliveries =
      current.delivery.deliveryCallbacks - previous.delivery.deliveryCallbacks
    if (events < 0 || deliveries < 0)
      throw new Error('capacity-native-delivery-counter-regressed')
    nativeDataEvents += events
    deliveryCallbacks += deliveries
    peakBufferedBytes = Math.max(peakBufferedBytes, current.delivery.peakBufferedBytes)
    if (current.visible) {
      if (current.canvases !== 1 || !current.currentDrawnGrant)
        throw new Error('capacity-native-visible-consumer')
      visibleReceiverDrawDelta += drawDelta
    } else {
      if (current.canvases || current.currentDrawnGrant || drawDelta !== 0)
        throw new Error('capacity-native-hidden-consumer-work')
      if (activeFixtureIds.includes(current.sessionId) && sequenceDelta <= 0)
        throw new Error('capacity-native-hidden-parser-stalled')
      hiddenAppliedSequenceDelta += sequenceDelta
      hiddenReceiverDrawDelta += drawDelta
    }
  }
  if (visibleReceiverDrawDelta <= 0)
    throw new Error('capacity-native-visible-submission-stalled')
  if (deliveryCallbacks >= nativeDataEvents)
    throw new Error('capacity-native-delivery-not-coalesced')
  return {
    engine: 'native',
    hiddenPanes: 11,
    hiddenAppliedSequenceDelta,
    hiddenReceiverDrawDelta,
    visibleReceiverDrawDelta,
    nativeDataEvents,
    deliveryCallbacks,
    peakBufferedBytes,
    semanticCapExercised: true,
    physicalReclamationQualified: false,
  }
}

async function wait(
  check: () => boolean | Promise<boolean>,
  stage: string,
  deadline = performance.now() + 15_000,
): Promise<void> {
  do {
    if (await check()) return
    await new Promise((resolve) => setTimeout(resolve, 25))
  } while (performance.now() < deadline)
  throw new Error('capacity-native-timeout:' + stage)
}
