import { screen, type BrowserWindow } from 'electron'
import type { HostPath } from '../../shared/host-path'
import type { ProjectHost } from '../project-host/project-host'
import type { PtySupervisor } from '../pty/pty-supervisor'
import type { NativeTerminalApplication } from '../terminal/native-terminal-application'
import {
  sampleCapacityCpuSeries,
  compareCapacityCpu,
  compareTerminalReadiness,
} from './capacity'
import { median, sampleElectronProcessMetrics } from './electron-process-metrics'
import { capacityTerminalMeasurement } from './capacity-terminal-measurement'
import { createCapacityTerminalFixture } from './capacity-terminal-fixture'
import { createNativeCapacityTerminals } from './capacity-native-terminals'
import { startCapacityOutputFixtures } from './capacity-output-fixtures'
import {
  activateCapacityTerminal,
  addCapacityTerminals,
  readTerminalPresentation,
  verifyHiddenPresentationSettles,
  verifyCapacitySessionsTerminalDetail,
  verifyTerminalActivity,
} from './capacity-terminals'
import { measureAdditionalTerminalReadiness } from './capacity-terminal-readiness'
import {
  CAPACITY_TERMINAL_COMPARISON_ORDER,
  type CapacityTerminalComparisonClass as Workload,
  type CapacityTerminalComparisonMeasurement as Measurement,
} from './capacity-terminal-comparison'
import { readCapacityTerminalLayout } from './capacity-terminal-compositor'

const kinds: readonly Workload[] = ['scroll', 'output', 'echo', 'resize', 'workbench']
import {
  workbenchClick,
  type CapacityWorkbenchCaptureTiming as CaptureTiming,
} from './capacity-workbench-observation'
type Fixture = Awaited<ReturnType<typeof createCapacityTerminalFixture>>
type TerminalSample = Awaited<ReturnType<Fixture['scroll']>>
interface PairedObservations {
  index: number
  runId: string
  workloadCompleted: boolean
  measurements: Record<Workload, Measurement[]>
  clickLatenciesMs: number[]
  workbenchCaptures: CaptureTiming[]
  terminalCaptures: Fixture['captureCalls']
  partialCadence?: { all: number[]; classes: Record<Workload, number[]> }
}
const percentile = (values: readonly number[], fraction: number) => {
  if (!values.length) throw new Error('capacity-pair-empty-distribution')
  return [...values].sort((a, b) => a - b)[Math.ceil(values.length * fraction) - 1]!
}

/** One fixed fresh-process population. Final identity/artifact serialization belongs
 * to the scenario owner; this owner returns only observations and retained evidence. */
export async function runCapacityTerminalPairedProcess(options: {
  win: BrowserWindow
  supervisor: PtySupervisor
  host: ProjectHost
  liveReloadPath: HostPath
  native?: NativeTerminalApplication
  index: number
  runId: string
  refreshHz: number
  retainObservations?: (observations: PairedObservations) => Promise<void>
}) {
  const { win, supervisor, host, liveReloadPath, native, index, runId, refreshHz } =
    options
  const engine = CAPACITY_TERMINAL_COMPARISON_ORDER[index]
  if (!engine || (engine === 'native') !== !!native || supervisor.list().length !== 0)
    throw new Error('capacity-pair-fresh-process-or-scheduled-engine')
  if (
    win.webContents.isDevToolsOpened() ||
    process.env['HVIR_NATIVE_IMPORT_DIAGNOSTICS'] === '1' ||
    process.env['HVIR_NATIVE_IMPORT_DIAGNOSTIC_WINDOW'] === '1'
  )
    throw new Error('capacity-pair-diagnostic-instrumentation-enabled')
  // Default tree/rail tracks leave 820 DIP inside the terminal container's
  // unchanged padding. Both engines use this same ordinary window geometry.
  win.setContentSize(1283, 800)
  const display = screen.getDisplayMatching(win.getBounds())
  const actualRefreshHz = display.displayFrequency
  if (!Number.isFinite(actualRefreshHz) || actualRefreshHz <= 0)
    throw new Error('capacity-pair-display-refresh-unknown')
  if (!Number.isFinite(refreshHz) || Math.abs(actualRefreshHz - refreshHz) > 0.5)
    throw new Error('capacity-pair-display-refresh-mismatch')
  const nativeCapacity = native && createNativeCapacityTerminals(win, supervisor, native)
  let fixture: Fixture | undefined
  let output: ReturnType<typeof startCapacityOutputFixtures> | undefined
  let observing = false
  let churning = false
  let churn: Promise<void> | undefined
  const stopMetrics = new AbortController()
  let metrics: ReturnType<typeof sampleElectronProcessMetrics> | undefined
  const measurements: Record<Workload, Measurement[]> = {
    scroll: [],
    output: [],
    echo: [],
    resize: [],
    workbench: [],
  }
  const clickLatenciesMs: number[] = []
  const workbenchCaptures: CaptureTiming[] = []
  // Status subscription precedes all consumer creation; no assumed presentation mode.
  const outcome = await (async () => {
    await win.webContents.executeJavaScript(`(()=>{
    const state={modes:[],dispose:undefined,clickSequence:0,lastClick:null};
    state.click=event=>{const b=event.target instanceof Element?event.target.closest('.rail-nav button'):null;
      if(b){state.clickSequence++;state.lastClick={sequence:state.clickSequence,label:b.textContent.trim(),receivedAtMs:performance.now()};}};
    document.addEventListener('click',state.click,true);
    state.dispose=window.hvir.nativeTerminalPresentation?.onStatus(value=>{
      if(state.modes.length===4096)throw new Error('capacity-pair-status-bound');
      state.modes.push({viewId:value.viewId,mode:value.mode});
    });globalThis.__hvirCapacityPairStatus=state;return true;
  })()`)
    fixture = await createCapacityTerminalFixture(
      win,
      supervisor,
      host,
      liveReloadPath,
      native,
    )
    if (
      Math.abs(fixture.initialFrame.layout.paneWidth - 820) > 0.1 ||
      fixture.initialFrame.layout.columns !== 102
    )
      throw new Error('capacity-pair-fixed-pane-or-grid-mismatch')
    const baselineReadiness = await measureAdditionalTerminalReadiness(
      win,
      supervisor,
      'baseline',
      10,
    )
    await activateCapacityTerminal(win, 0)
    const baselineCpu = await sampleCapacityCpuSeries(win, 'paired-one-terminal')
    await addCapacityTerminals(win, 12)
    await activateCapacityTerminal(win, 0)
    if (nativeCapacity) await nativeCapacity.hiddenSettles()
    else await verifyHiddenPresentationSettles(win)
    const idleCpu = compareCapacityCpu(
      baselineCpu,
      await sampleCapacityCpuSeries(win, 'paired-twelve-idle'),
    )
    metrics = sampleElectronProcessMetrics(
      win.webContents.getOSProcessId(),
      Number.POSITIVE_INFINITY,
      1000,
      stopMetrics.signal,
    )
    output = startCapacityOutputFixtures(supervisor, {
      taggedTerminalId: fixture.terminal.id,
    })
    churning = true
    churn = (async () => {
      let generation = 0
      while (churning) {
        await host.writeFile(liveReloadPath, `capacity churn ${generation++}\n`)
        await new Promise((resolve) => setTimeout(resolve, 200))
      }
    })()
    // Attach a handler immediately; retain the original error until cleanup.
    void churn.catch(() => undefined)
    const loadedReadiness = await measureAdditionalTerminalReadiness(
      win,
      supervisor,
      'loaded',
      10,
    )
    const readiness = compareTerminalReadiness(baselineReadiness, loadedReadiness)
    await activateCapacityTerminal(win, 0)
    const layout = await readCapacityTerminalLayout(win, fixture.terminal, native)
    await win.webContents.executeJavaScript(`(async()=>{
      const file=[...document.querySelectorAll('.file-row')].find(n=>n.title===${JSON.stringify(liveReloadPath.path)});
      if(!(file instanceof HTMLElement))throw new Error('capacity-pair-viewer-fixture');file.click();
      const deadline=performance.now()+15000;
      while(document.querySelector('.viewer-tab.active .tab-main')?.title!==${JSON.stringify(liveReloadPath.path)}){
        if(performance.now()>deadline)throw new Error('capacity-pair-viewer-not-applied');
        await new Promise(resolve=>setTimeout(resolve,5));}return true;
    })()`)
    const warmups = { scroll: 0, output: 0, echo: 0, resize: 0, workbench: 0 }
    let producerSequence = 0
    for (let n = 0; n < 10; n++) {
      await fixture.scroll(n % 2 === 0 ? 'up' : 'down')
      warmups.scroll++
    }
    for (let n = 0; n < 10; n++) {
      await fixture.command('output', ++producerSequence)
      warmups.output++
      await fixture.command('echo', ++producerSequence)
      warmups.echo++
      await fixture.resize(++producerSequence)
      warmups.resize++
      await workbenchClick(win, n, workbenchCaptures)
      warmups.workbench++
    }
    const nativeBefore = nativeCapacity && (await nativeCapacity.snapshot())
    const webBefore = !nativeCapacity && (await readTerminalPresentation(win))
    await startCadence(win)
    observing = true
    const record = async (kind: Workload, action: () => Promise<TerminalSample>) => {
      await setClass(win, kind)
      const value = await action()
      measurements[kind].push(
        capacityTerminalMeasurement(value, measurements[kind].length),
      )
    }
    for (let round = 0; round < 100; round++) {
      await record('scroll', () => fixture!.scroll('up'))
      await record('scroll', () => fixture!.scroll('down'))
      await record('output', () => fixture!.command('output', ++producerSequence))
      await record('output', () => fixture!.command('output', ++producerSequence))
      await record('echo', () => fixture!.command('echo', ++producerSequence))
      if (round % 3 === 0 && measurements.resize.length < 30)
        await record('resize', () => fixture!.resize(++producerSequence))
      await setClass(win, 'workbench')
      const click = await workbenchClick(win, round, workbenchCaptures)
      measurements.workbench.push(click)
      clickLatenciesMs.push(click.uiClickLatencyMs)
    }
    const cadence = await stopCadence(win)
    observing = false
    const activeFixtureIds = supervisor
      .list()
      .slice(1)
      .map((value) => value.id)
    const activity = nativeCapacity
      ? nativeCapacity.activity(
          nativeBefore!,
          await nativeCapacity.snapshot(),
          activeFixtureIds,
        )
      : verifyTerminalActivity(
          webBefore || [],
          await readTerminalPresentation(win),
          activeFixtureIds,
        )
    // Explicit hidden reveal and Workspace/Sessions transitions retain the same 12 actors.
    await activateCapacityTerminal(win, 1)
    await activateCapacityTerminal(win, 0)
    const sessions = nativeCapacity
      ? await nativeCapacity.sessions()
      : await verifyCapacitySessionsTerminalDetail(win, supervisor)
    await activateCapacityTerminal(win, 0)
    if (supervisor.list().length !== 12) throw new Error('capacity-pair-topology-changed')
    const presentation = await observedPresentation(win, fixture, native)
    stopMetrics.abort()
    const processMetrics = await metrics
    metrics = undefined
    for (const kind of kinds) {
      if (!cadence.classes[kind].length)
        throw new Error('capacity-pair-class-without-frames:' + kind)
    }
    const uiResponsivenessByClass = Object.fromEntries(
      kinds.map((kind) => [
        kind,
        {
          frameGapsMs: cadence.classes[kind],
          clickLatenciesMs: kind === 'workbench' ? clickLatenciesMs : [],
        },
      ]),
    ) as Record<Workload, { frameGapsMs: number[]; clickLatenciesMs: number[] }>
    const responsiveness = [...cadence.all, ...clickLatenciesMs]
    return {
      index,
      pair: Math.floor(index / 2),
      engine,
      runId,
      processId: String(process.pid),
      observedPresentation: presentation.mode,
      refreshHz: actualRefreshHz,
      displayId: display.id,
      layout,
      warmups,
      measurements,
      frameGapsMs: cadence.all,
      uiResponsivenessByClass,
      budgets: {
        idleRendererPlusGpuRatio: idleCpu.ratio,
        terminalReadinessP95Ratio: readiness.ratio,
        terminalReadinessMaxMs: loadedReadiness.maxMs,
        responsivenessP99Ms: percentile(responsiveness, 0.99),
        responsivenessMaxMs: Math.max(...responsiveness),
        workingSetGrowthKiB: processMetrics.memoryGrowthKiB,
      },
      accounting: {
        idleWholeAppCpu: median(
          idleCpu.twelveTerminals.map((value) => value.cpu.wholeApp),
        ),
        nativeHostCpu: processMetrics.cpu.nativeHost,
        nativeHostMemoryKiB: processMetrics.nativeHostMemoryPeakKiB,
      },
      evidence: {
        idleCpu,
        readiness,
        processMetrics,
        activity,
        sessions,
        presentation,
        captureCalls: fixture.captureCalls,
        workbenchCaptures,
        productionZeroReadbackQualified: false,
        physicalPresentationQualified: false,
      },
    }
  })().then(
    (value) => ({ ok: true, value }) as const,
    (error: unknown) => ({ ok: false, error }) as const,
  )
  {
    // Release every acquired resource even if an earlier cleanup fails. Preserve
    // the scheduled process failure instead of replacing it with cleanup noise.
    const cleanupErrors: unknown[] = []
    let partialCadence: PairedObservations['partialCadence']
    const cleanup = async (action: () => unknown) => {
      try {
        await action()
      } catch (error) {
        cleanupErrors.push(error)
      }
    }
    stopMetrics.abort()
    if (metrics) await cleanup(() => metrics)
    if (observing)
      await cleanup(async () => {
        partialCadence = await stopCadence(win)
        console.log(
          '[smoke:capacity:comparison:partial-cadence] ' +
            JSON.stringify({ index, runId, cadence: partialCadence }),
        )
      })
    churning = false
    if (churn) await cleanup(() => churn)
    await cleanup(() => output?.stop())
    await cleanup(() => fixture?.dispose())
    await cleanup(() => nativeCapacity?.dispose())
    await cleanup(() =>
      win.webContents.executeJavaScript(`(()=>{
      document.removeEventListener('click',globalThis.__hvirCapacityPairStatus?.click,true);
      globalThis.__hvirCapacityPairStatus?.dispose?.();
      delete globalThis.__hvirCapacityPairStatus;return true;
    })()`),
    )
    const observations: PairedObservations = {
      index,
      runId,
      workloadCompleted: outcome.ok,
      measurements,
      clickLatenciesMs,
      workbenchCaptures,
      terminalCaptures: fixture?.captureCalls ?? [],
      partialCadence,
    }
    await cleanup(() => options.retainObservations?.(observations))
    console.log('[smoke:capacity:comparison:raw] ' + JSON.stringify(observations))
    if (!outcome.ok) throw outcome.error
    if (cleanupErrors.length)
      throw new AggregateError(cleanupErrors, 'capacity-pair-cleanup')
    return outcome.value
  }
}

async function observedPresentation(
  win: BrowserWindow,
  fixture: Fixture,
  native?: NativeTerminalApplication,
) {
  if (!native) return { mode: 'web' as const }
  const layout = await fixture.appliedLayout()
  const terminal = fixture.terminal
  const state = native.sessions.get(terminal.id)
  if (!state || state.unavailable || state.session.instanceId !== terminal.instanceId)
    throw new Error('capacity-pair-native-instance')
  const info = await native.rendererInfo(terminal.id, {
    id: terminal.ownerId,
    generation: terminal.ownerGeneration,
  })
  const modes = (await win.webContents.executeJavaScript(
    `globalThis.__hvirCapacityPairStatus.modes`,
  )) as Array<{ viewId: string; mode: string }>
  const viewId = layout.viewId
  const observedModes = modes
    .filter((value) => value.viewId === viewId)
    .map((value) => value.mode)
  if (observedModes.includes('unavailable'))
    throw new Error('capacity-pair-presentation-lost')
  const mode = observedModes.includes('native-pixels')
    ? 'native-pixels'
    : observedModes.at(-1)
  if (mode !== 'native-gpu' && mode !== 'native-pixels')
    throw new Error('capacity-pair-presentation-unobserved')
  // available denotes the OpenGL/EGL diagnostic callback; Metal has no GL strings.
  if ((process.platform === 'linux' && !info.available) || !info.lastFrame)
    throw new Error('capacity-pair-native-renderer-unobserved')
  return { mode, rendererInfo: info, observedModes } as const
}

async function startCadence(win: BrowserWindow) {
  await win.webContents.executeJavaScript(`(()=>{
    const state={all:[],classes:{scroll:[],output:[],echo:[],resize:[],workbench:[]},kind:null,last:undefined,frame:0,truncated:false};
    const tick=now=>{if(state.last!==undefined){const gap=now-state.last;
      if(state.all.length>=131072)state.truncated=true;
      else {state.all.push(gap);if(state.kind)state.classes[state.kind].push(gap);}}
      state.last=now;state.frame=requestAnimationFrame(tick);};
    state.frame=requestAnimationFrame(tick);globalThis.__hvirCapacityPairCadence=state;return true;
  })()`)
}
async function setClass(win: BrowserWindow, kind: Workload) {
  await win.webContents.executeJavaScript(
    `globalThis.__hvirCapacityPairCadence.kind=${JSON.stringify(kind)};true`,
  )
}
async function stopCadence(
  win: BrowserWindow,
): Promise<{ all: number[]; classes: Record<Workload, number[]> }> {
  const result: unknown = await win.webContents
    .executeJavaScript(`(()=>{const s=globalThis.__hvirCapacityPairCadence;
    cancelAnimationFrame(s.frame);delete globalThis.__hvirCapacityPairCadence;
    if(s.truncated)throw new Error('capacity-pair-frame-bound');
    return {all:s.all,classes:s.classes};})()`)
  return result as { all: number[]; classes: Record<Workload, number[]> }
}
