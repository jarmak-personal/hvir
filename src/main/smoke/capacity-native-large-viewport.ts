import { app, screen, type BrowserWindow } from 'electron'
import { localPath, type HostPath } from '../../shared/host-path'
import type { LocalHost } from '../project-host'
import type { PtySupervisor } from '../pty/pty-supervisor'
import type { NativeTerminalApplication } from '../terminal/native-terminal-application'
import { createCapacityTerminalFixture } from './capacity-terminal-fixture'
import {
  CapacityTerminalLayoutPending,
  readCapacityTerminalLayout,
} from './capacity-terminal-compositor'
import { CAPACITY_PERFORMANCE_BUDGETS } from './capacity-performance'
import { sampleElectronProcessMetrics } from './electron-process-metrics'
import { observeNativeTerminalUtilities } from './native-terminal-utility-observation'

const PROFILE = 'compatibility-large-viewport'
const DEADLINE_MS = 120_000
const OPERATION_BOUND_MS = 15_000
const TARGETS = [
  { width: 3840, height: 2160 },
  { width: 5120, height: 2880 },
] as const

type Extent = { width: number; height: number }
export function capacityLargeViewportSelected(
  environment: NodeJS.ProcessEnv,
  platform: string,
): boolean {
  if (environment['HVIR_CAPACITY_OBSERVATION'] !== PROFILE) return false
  if (
    platform !== 'darwin' ||
    !environment['HVIR_CAPACITY_DIAGNOSTIC_OUTPUT']?.startsWith('/') ||
    environment['HVIR_SMOKE_SCENARIO'] !== 'capacity' ||
    environment['HVIR_CAPACITY_PERFORMANCE_GATE'] !== undefined ||
    Object.keys(environment).some((key) => key.startsWith('HVIR_CAPACITY_COMPARISON_')) ||
    [
      'HVIR_NATIVE_IMPORT_DIAGNOSTICS',
      'HVIR_NATIVE_IMPORT_DIAGNOSTIC_WINDOW',
      'HVIR_NATIVE_TERMINAL_PRESENTATION',
      'HVIR_NATIVE_TERMINAL_TRACE_CONFIG',
    ].some((key) => environment[key] !== undefined)
  )
    throw new Error('capacity-large-viewport-invocation')
  return true
}

/** Correct the real window content extent using its current production mount. */
export function capacityLargeViewportWindowSize(
  content: Extent,
  mount: Extent,
  target: Extent,
  dpr: number,
): Extent {
  if (
    ![
      content.width,
      content.height,
      mount.width,
      mount.height,
      target.width,
      target.height,
      dpr,
    ].every((value) => Number.isFinite(value) && value > 0) ||
    target.width > 8192 ||
    target.height > 8192
  )
    throw new Error('capacity-large-viewport-geometry')
  return {
    width: Math.round(content.width + target.width / dpr - mount.width),
    height: Math.round(content.height + target.height / dpr - mount.height),
  }
}

/** Separate deterministic CPU workbench profile; never a canonical comparison row. */
export async function qualifyCapacityNativeLargeViewport(
  win: BrowserWindow,
  supervisor: PtySupervisor,
  host: LocalHost,
  path: HostPath,
  native: NativeTerminalApplication | undefined,
): Promise<void> {
  if (!capacityLargeViewportSelected(process.env, process.platform) || !native)
    throw new Error('capacity-large-viewport-native-required')
  const destination = localPath(process.env['HVIR_CAPACITY_DIAGNOSTIC_OUTPUT']!)
  await host.createFileExclusive(destination, { mode: 0o600 })
  await host.writeFile(
    destination,
    JSON.stringify({ profile: PROFILE, status: 'started' }) + '\n',
  )
  const startedAtMs = performance.now(),
    deadlineAtMs = startedAtMs + DEADLINE_MS
  const featureStatus: Record<string, unknown> = { ...app.getGPUFeatureStatus() }
  const featureValues = [
    'enabled',
    'enabled_on',
    'disabled_off',
    'disabled_off_ok',
    'disabled_software',
    'unavailable_off',
    'unavailable_software',
  ]
  const gpuFeatures = Object.fromEntries(
    [
      '2d_canvas',
      'gpu_compositing',
      'multiple_raster_threads',
      'opengl',
      'rasterization',
      'raw_draw',
      'skia_graphite',
      'video_decode',
      'video_encode',
      'vulkan',
      'webgl',
      'webgl2',
      'webgpu',
    ].map((key) => {
      const value = featureStatus[key]
      return [
        key,
        typeof value === 'string' && featureValues.includes(value)
          ? value
          : 'other-or-unavailable',
      ]
    }),
  )
  const receipt: Record<string, unknown> = {
    schema: 1,
    profile: PROFILE,
    runtime: {
      platform: process.platform,
      arch: process.arch,
      electron: process.versions.electron,
      chrome: process.versions.chrome,
      node: process.versions.node,
      launchFlags: process.argv.filter(
        (value) =>
          value === '--disable-gpu' ||
          value === '--no-sandbox' ||
          /^--ozone-platform=(x11|wayland)$/.test(value),
      ),
      gpuFeatures,
    },
    productionOsSandboxQualified: false,
    installedPackageQualified: false,
    clock: 'main performance.now',
    startedAtMs,
    profileDeadlineMs: DEADLINE_MS,
    operationBoundMs: OPERATION_BOUND_MS,
    roundsPerExtent: 20,
    operationsPerExtent: 80,
    memoryLimitKiB: CAPACITY_PERFORMANCE_BUDGETS.workingSetGrowthKiB,
    targets: TARGETS,
    oversizedWindowRequested: true,
    terminalLayout: 'maximized-via-visible-control',
    completed: false,
    wheelMode: 'content-rows-pixel-wheel',
    tagProfile: 'large-viewport-16-bit-geometry-35-cells',
    coldDiagnosticIsAcceptanceGate: false,
    physicalPresentationQualified: false,
    uiResponsivenessQualified: false,
    canonicalCapacityQualified: false,
    cpuAveragesQualified: false,
    cpuSamplingConfounder:
      'Overlapping memory intervals and milestone getAppMetrics calls reset CPU intervals',
    latencyCoverage: 'fixture-operation-and-compositor-capture-only',
  }
  const samples: unknown[] = [],
    geometry: unknown[] = [],
    cleanup: unknown[] = []
  receipt.samples = samples
  receipt.geometry = geometry
  receipt.cleanup = cleanup
  const processMemorySnapshots: unknown[] = []
  receipt.processMemorySnapshots = processMemorySnapshots
  const memorySnapshot = (stage: string) => {
    try {
      const rows = app.getAppMetrics()
      processMemorySnapshots.push({
        stage,
        atMs: performance.now(),
        truncated: rows.length > 32,
        processes: rows.slice(0, 32).map((metric) => ({
          pid: metric.pid,
          type: metric.type,
          workingSetKiB: metric.memory.workingSetSize,
        })),
      })
    } catch {
      processMemorySnapshots.push({ stage, unavailable: true })
    }
  }
  const utilities = observeNativeTerminalUtilities()
  const abort = new AbortController()
  // Before first fixture/terminal/native utility allocation; never rebase.
  let metricsError: unknown
  const metrics = sampleElectronProcessMetrics(
    win.webContents.getOSProcessId(),
    DEADLINE_MS,
    1000,
    abort.signal,
  ).catch((error: unknown) => {
    metricsError = error
    return undefined
  })
  memorySnapshot('cold-start')
  let fixture: Awaited<ReturnType<typeof createCapacityTerminalFixture>> | undefined
  let originalError: unknown, cleanupError: unknown
  let initializedMetrics: ReturnType<typeof sampleElectronProcessMetrics> | undefined
  let initializedMetricsError: unknown
  let retainedMemoryError: Error | undefined
  let utilityExit: Promise<number> | undefined
  let utilityExited = false
  let sequence = 0
  const views = new Set<string>()
  const checkDeadline = () => {
    if (performance.now() >= deadlineAtMs)
      throw new Error('capacity-large-viewport-deadline')
  }
  const operation = async <T>(read: () => Promise<T>): Promise<T> => {
    checkDeadline()
    const result = await read() // Existing owner settles; never abandon a raced operation.
    checkDeadline()
    return result
  }
  const evaluate = <T>(body: string): Promise<T> =>
    win.webContents.executeJavaScript(`(()=>{${body}})()`)
  const wait = async (read: () => Promise<boolean>, stage: string, admitted = true) => {
    const until = performance.now() + OPERATION_BOUND_MS
    do {
      if (admitted) checkDeadline()
      if (await read()) return
      await new Promise((resolve) => setTimeout(resolve, 25))
    } while (performance.now() < until)
    throw new Error('capacity-large-viewport-timeout:' + stage)
  }
  const click = (selector: string) =>
    evaluate(`const button=document.querySelector(${JSON.stringify(selector)});
    if(!(button instanceof HTMLButtonElement)||button.disabled)throw new Error('capacity-large-viewport-control');button.click();`)
  try {
    if (win.webContents.getZoomFactor() !== 1)
      throw new Error('capacity-large-viewport-zoom')
    await operation(() =>
      evaluate(`const modes=new Map();const stop=window.hvir.nativeTerminalPresentation.onStatus(value=>{
      if(modes.size>=32&&!modes.has(value.viewId))throw new Error('capacity-large-viewport-status-bound');
      modes.set(value.viewId,value.mode);});globalThis.__hvirLargeViewport={modes,stop};`),
    )
    // Use the ordinary exposed layout control. Restored split rows divide
    // vertical window growth between viewer and terminal, unlike this profile's
    // predeclared full-height terminal sizing.
    await operation(() => click('.terminal-focus-toggle[aria-label="Maximize terminal"]'))
    await wait(
      () => evaluate(`return !!document.querySelector('.workbench.terminal-focused');`),
      'maximized-layout',
    )
    fixture = await operation(() =>
      createCapacityTerminalFixture(win, supervisor, host, path, native, {
        profile: 'large-viewport',
      }),
    )
    const active = fixture,
      managed = active.terminal
    const owner = { id: managed.ownerId, generation: managed.ownerGeneration }
    const initial = native.sessions.get(managed.id)
    if (!initial) throw new Error('capacity-large-viewport-state')
    const small = {
      width: active.initialFrame.layout.canvasWidth,
      height: active.initialFrame.layout.canvasHeight,
    }
    if (small.width >= TARGETS[1].width || small.height >= TARGETS[1].height)
      throw new Error('capacity-large-viewport-baseline-not-smaller')
    receipt.smallViewport = small
    const handle = initial.handle
    receipt.actor = {
      sessionId: managed.id,
      instanceId: managed.instanceId,
      pid: managed.pid,
      handle,
      owner,
    }
    const utility = utilities.current(app.getAppMetrics().map((metric) => metric.pid))
    receipt.utility = { pid: utility.child.pid, epoch: utility.epoch }
    utilityExit = new Promise((resolve) =>
      utility.child.once('exit', (code) => {
        utilityExited = true
        resolve(code)
      }),
    )
    const identity = () => {
      const live = supervisor.get(managed.id),
        state = native.sessions.get(managed.id)
      if (
        supervisor.list().length !== 1 ||
        !live ||
        live.instanceId !== managed.instanceId ||
        live.pid !== managed.pid ||
        live.ownerId !== managed.ownerId ||
        live.ownerGeneration !== managed.ownerGeneration ||
        state?.handle !== handle ||
        state.session.instanceId !== managed.instanceId ||
        state.unavailable ||
        state.retiring
      )
        throw new Error('capacity-large-viewport-actor')
    }
    const applied = async (target?: Extent) => {
      const until = performance.now() + OPERATION_BOUND_MS
      do {
        checkDeadline()
        identity()
        let layout
        try {
          layout = await readCapacityTerminalLayout(win, managed, native)
        } catch (error) {
          if (!(error instanceof CapacityTerminalLayoutPending)) throw error
          await new Promise((resolve) => setTimeout(resolve, 25))
          continue
        }
        identity()
        const viewId = layout.viewId
        if (
          !viewId ||
          layout.engine !== 'native' ||
          win.webContents.getZoomFactor() !== 1
        )
          throw new Error('capacity-large-viewport-layout')
        views.add(viewId)
        const mount = await evaluate<{
          width: number
          height: number
          dpr: number
          innerWidth: number
          innerHeight: number
        }>(`
        const surface=[...document.querySelectorAll('.terminal-surface')].find(node=>node.getAttribute('data-terminal-session')===${JSON.stringify(managed.id)});
        const mount=surface?.querySelector('[id^="native-terminal-"]');if(!(mount instanceof HTMLElement))throw new Error('capacity-large-viewport-mount');
        const b=mount.getBoundingClientRect();return {width:b.width,height:b.height,dpr:devicePixelRatio,innerWidth,innerHeight};`)
        const content = win.getContentBounds()
        if (
          mount.innerWidth !== content.width ||
          mount.innerHeight !== content.height ||
          Math.round(mount.width * mount.dpr) !== layout.canvasWidth ||
          Math.round(mount.height * mount.dpr) !== layout.canvasHeight ||
          (target &&
            (layout.canvasWidth !== target.width ||
              layout.canvasHeight !== target.height))
        ) {
          await new Promise((resolve) => setTimeout(resolve, 25))
          continue
        }
        const mode = await evaluate<string | undefined>(
          `return globalThis.__hvirLargeViewport.modes.get(${JSON.stringify(viewId)});`,
        )
        if (mode === undefined) {
          await new Promise((resolve) => setTimeout(resolve, 25))
          continue
        }
        if (mode !== 'native-pixels')
          throw new Error('capacity-large-viewport-not-pixels')
        const status = await native.inspectRetained(managed.id, owner)
        const drawn = native.targets.drawn(viewId, win.webContents.mainFrame)
        if (
          !drawn ||
          drawn.geometrySerial !== status.geometry.serial ||
          status.geometry.width !== layout.canvasWidth ||
          status.geometry.height !== layout.canvasHeight ||
          status.failure ||
          status.presentationFailure ||
          status.rendererHealth !== 0
        )
          throw new Error('capacity-large-viewport-drawn-state')
        return { layout, status, drawn, mode }
      } while (performance.now() < until)
      throw new Error('capacity-large-viewport-applied-timeout')
    }
    const size = async (target: Extent) => {
      for (let correction = 0; correction < 3; correction++) {
        checkDeadline()
        identity()
        const mount = await evaluate<{ width: number; height: number; dpr: number }>(`
          const surface=[...document.querySelectorAll('.terminal-surface')].find(node=>node.getAttribute('data-terminal-session')===${JSON.stringify(managed.id)});
          const mount=surface?.querySelector('[id^="native-terminal-"]');if(!(mount instanceof HTMLElement))throw new Error('capacity-large-viewport-mount');
          const b=mount.getBoundingClientRect();return {width:b.width,height:b.height,dpr:devicePixelRatio};`)
        const content = win.getContentBounds()
        const requested = capacityLargeViewportWindowSize(
          content,
          mount,
          target,
          mount.dpr,
        )
        win.setContentSize(requested.width, requested.height)
        const attempt: Record<string, unknown> = {
          target,
          correction,
          mount,
          requested,
          actualContent: win.getContentBounds(),
          stage: 'requested',
        }
        geometry.push(attempt)
        const current = await operation(() => applied())
        const layout = current.layout
        const display = screen.getDisplayMatching(win.getBounds())
        Object.assign(attempt, {
          stage: 'applied',
          actualContent: win.getContentBounds(),
          display: {
            bounds: display.bounds,
            workArea: display.workArea,
            scaleFactor: display.scaleFactor,
          },
          applied: {
            width: layout.canvasWidth,
            height: layout.canvasHeight,
            scale: layout.scale,
            columns: layout.columns,
            rows: layout.rows,
          },
          status: current.status,
          drawn: current.drawn,
        })
        if (layout.canvasWidth === target.width && layout.canvasHeight === target.height)
          return operation(() => applied(target))
      }
      throw new Error('capacity-large-viewport-unavailable')
    }
    const sample = async (
      kind: 'output' | 'echo' | 'up' | 'down',
      label: string,
      target?: Extent,
    ) => {
      receipt.activeOperation = { label, kind, requestedAtMs: performance.now() }
      const result = await operation(() =>
        kind === 'up' || kind === 'down'
          ? active.scroll(kind)
          : active.command(kind, ++sequence),
      )
      samples.push({ label, kind, ...result })
      receipt.activeOperation = undefined
      const current = await operation(() => applied(target))
      return { result, current }
    }
    // Keep cold accounting while separately measuring an initialized terminal.
    // No large allocation has occurred and neither baseline will move again.
    const initializedSmall = await operation(() => applied(small))
    receipt.initializedSmallViewport = {
      atMs: performance.now(),
      geometry: initializedSmall.status.geometry,
      drawn: initializedSmall.drawn,
      mode: initializedSmall.mode,
    }
    initializedMetrics = sampleElectronProcessMetrics(
      win.webContents.getOSProcessId(),
      Math.max(0, deadlineAtMs - performance.now()),
      1000,
      abort.signal,
    )
    void initializedMetrics.catch((error: unknown) => {
      initializedMetricsError = error
    })
    memorySnapshot('initialized-small-viewport')
    for (const target of TARGETS) {
      const before = await size(target)
      for (let round = 0; round < 20; round++) {
        for (const kind of ['output', 'echo', 'up', 'down'] as const) {
          const observed = await sample(
            kind,
            `${target.width}x${target.height}:${round}`,
            target,
          )
          if (round === 0 && kind === 'output') {
            memorySnapshot('first-matching-output-' + target.width + 'x' + target.height)
            geometry.push({
              target,
              stage: 'first-existing-output',
              status: observed.current.status,
              drawn: observed.current.drawn,
              capturedAtMs: observed.result.captured.completedAtMs,
            })
          }
        }
      }
      const after = await operation(() => applied(target))
      if (
        after.status.frameCopies <= before.status.frameCopies ||
        after.status.appliedSequence <= before.status.appliedSequence
      )
        throw new Error('capacity-large-viewport-progress')
      geometry.push({
        target,
        mode: after.mode,
        beforeCopies: before.status.frameCopies,
        afterCopies: after.status.frameCopies,
        beforeSequence: before.status.appliedSequence,
        afterSequence: after.status.appliedSequence,
      })
      memorySnapshot('completed-' + target.width + 'x' + target.height)
    }
    const largeVisible = await operation(() => applied(TARGETS[1]))
    receipt.memoryEndpoint = {
      largeVisible: true,
      mode: largeVisible.mode,
      atMs: performance.now(),
      geometry: largeVisible.status.geometry,
      drawn: largeVisible.drawn,
    }
    memorySnapshot('large-visible-endpoint')
    abort.abort()
    const memory = await metrics
    if (!memory)
      throw metricsError instanceof Error
        ? metricsError
        : new Error('capacity-large-viewport-metrics', { cause: metricsError })
    receipt.memory = memory
    receipt.coldStartMemory = memory
    const initializedMemory = await initializedMetrics
    receipt.initializedSmallViewportMemory = initializedMemory
    receipt.memoryLimitKiB = CAPACITY_PERFORMANCE_BUDGETS.workingSetGrowthKiB
    const memoryViolations = [
      { scope: 'initialized-small-viewport-loaded', memory: initializedMemory },
    ]
      .filter(
        ({ memory: value }) =>
          value.memoryGrowthKiB > CAPACITY_PERFORMANCE_BUDGETS.workingSetGrowthKiB,
      )
      .map(({ scope, memory: value }) => ({
        scope,
        actualKiB: value.memoryGrowthKiB,
        limitKiB: CAPACITY_PERFORMANCE_BUDGETS.workingSetGrowthKiB,
      }))
    receipt.memoryViolations = memoryViolations
    if (memoryViolations.length)
      retainedMemoryError = new Error('capacity-large-viewport-memory-growth')
    // Actual window shrink must work before an explicit destination hide/reveal.
    await size(small)
    await sample('output', 'ordinary-window-shrink', small)
    await sample('echo', 'ordinary-window-shrink', small)
    memorySnapshot('ordinary-window-shrink')
    receipt.ordinaryWindowShrink = { passed: true, failureRecoveryQualified: false }
    await size(TARGETS[1])
    await sample('output', 'window-reenlarge', TARGETS[1])
    memorySnapshot('window-reenlarge')
    for (let cycle = 0; cycle < 2; cycle++) {
      const previous = await operation(() => applied())
      await operation(() => click('.sessions-destination'))
      await wait(
        () =>
          evaluate(
            `return !!document.querySelector('.sessions-overview')&&document.querySelectorAll('.native-terminal-pane canvas').length===0;`,
          ),
        'hidden',
      )
      if (native.targets.drawn(previous.layout.viewId!, win.webContents.mainFrame))
        throw new Error('capacity-large-viewport-hidden-grant')
      memorySnapshot('sessions-hidden-' + cycle)
      await operation(() => click('.project-tab-main'))
      await operation(() => applied())
      await size(TARGETS[1])
      await sample('output', `sessions-reveal:${cycle}`, TARGETS[1])
      await sample('echo', `sessions-reveal:${cycle}`, TARGETS[1])
      memorySnapshot('sessions-revealed-' + cycle)
    }
    receipt.workloadAndRecoveryCompleted = true
    if (retainedMemoryError) throw retainedMemoryError
    receipt.completed = true
  } catch (error) {
    memorySnapshot('failure-before-cleanup')
    if (fixture) {
      const managed = fixture.terminal
      const state = native.sessions.get(managed.id)
      receipt.failureOwner = {
        supervised: supervisor.get(managed.id)?.instanceId === managed.instanceId,
        nativePresent: !!state,
        unavailable: state?.unavailable,
        inputClosed: state?.inputClosed,
        inputUnavailable: state?.inputUnavailable,
        readonly: state?.readonly,
        retiring: state?.retiring,
      }
    }
    originalError = retainedMemoryError ?? error
    if (retainedMemoryError && error !== retainedMemoryError)
      receipt.subsequentError =
        error instanceof Error
          ? { name: error.name, message: error.message }
          : { name: 'unknown' }
    receipt.error =
      originalError instanceof Error
        ? { name: originalError.name, message: originalError.message }
        : { name: 'unknown' }
  } finally {
    abort.abort()
    const coldMemory = await metrics
    receipt.memory ??= coldMemory
    receipt.coldStartMemory ??= receipt.memory
    receipt.coldDiagnosticCeilingExceeded = coldMemory
      ? coldMemory.memoryGrowthKiB > CAPACITY_PERFORMANCE_BUDGETS.workingSetGrowthKiB
      : null
    receipt.memoryEndpointCompleted = receipt.memoryEndpoint !== undefined
    if (initializedMetrics) {
      try {
        receipt.initializedSmallViewportMemory ??= await initializedMetrics
      } catch (error) {
        initializedMetricsError ??= error
      }
    }
    if (initializedMetricsError) {
      cleanupError ??= initializedMetricsError
      receipt.initializedMetricsError = true
    }
    if (metricsError) {
      cleanupError ??= metricsError
      receipt.metricsError = true
    }
    receipt.deadlineCrossed = performance.now() >= deadlineAtMs
    const clean = async (label: string, action: () => unknown) => {
      try {
        await action()
        cleanup.push({ label, passed: true })
      } catch (error) {
        cleanupError ??= error
        cleanup.push({ label, passed: false })
      }
    }
    if (fixture) {
      const terminal = fixture.terminal
      await clean('fixture-source', () => fixture!.dispose())
      await clean('terminal-close', async () => {
        await click('.terminal-close-button')
        await wait(
          async () =>
            supervisor.list().length === 0 &&
            !native.sessions.get(terminal.id) &&
            [...views].every(
              (view) => !native.targets.drawn(view, win.webContents.mainFrame),
            ) &&
            (await evaluate<boolean>(
              `return document.querySelectorAll('.native-terminal-pane canvas').length===0;`,
            )),
          'terminal-close',
          false,
        )
      })
    }
    if (!fixture && supervisor.list().length)
      await clean('partial-fixture-terminal-close', async () => {
        await click('.terminal-close-button')
        await wait(
          () => Promise.resolve(supervisor.list().length === 0),
          'partial-terminal-close',
          false,
        )
      })
    if (supervisor.list().length) {
      supervisor.disposeSessions()
      cleanupError ??= new Error('capacity-large-viewport-forced-pty-cleanup')
    }
    if (!utilityExit) {
      try {
        const child = utilities.current(
          app.getAppMetrics().map((metric) => metric.pid),
        ).child
        utilityExit = new Promise((resolve) =>
          child.once('exit', (code) => {
            utilityExited = true
            resolve(code)
          }),
        )
      } catch {
        const liveNativeUtilities = app
          .getAppMetrics()
          .filter((metric) => metric.name === 'hvir-native-terminal').length
        cleanup.push({ label: 'utility-observation', liveNativeUtilities })
        if (liveNativeUtilities)
          cleanupError ??= new Error('capacity-large-viewport-unobserved-utility')
      }
    }
    await clean('native-dispose-request', () => {
      native.dispose()
    })
    if (utilityExit)
      await clean('utility-exit', async () => {
        await wait(() => Promise.resolve(utilityExited), 'utility-exit', false)
        cleanup.push({ utilityExitCode: await utilityExit })
      })
    await clean('status-observer', () =>
      evaluate(
        `globalThis.__hvirLargeViewport?.stop();delete globalThis.__hvirLargeViewport;`,
      ),
    )
    await clean('utility-observer', () => {
      utilities.dispose()
    })
    receipt.finishedAtMs = performance.now()
    receipt.cleanupPassed = cleanupError === undefined
    memorySnapshot('cleanup-settled')
    const status = originalError || cleanupError ? 'failed' : 'completed'
    let receiptPersisted = false
    try {
      await host.writeFile(destination, JSON.stringify({ ...receipt, status }) + '\n')
      receiptPersisted = true
    } catch (error) {
      cleanupError ??= error
    }
    try {
      console.log(
        '[smoke:capacity:large-viewport] ' +
          JSON.stringify({
            profile: PROFILE,
            status: originalError || cleanupError ? 'failed' : 'completed',
            receiptFile: destination.path,
            receiptPersisted,
            completed: receipt.completed,
            samples: samples.length,
            error: receipt.error,
            cleanupPassed: receipt.cleanupPassed,
          }),
      )
    } catch (error) {
      cleanupError ??= error
    }
  }
  // Preserve the original thrown value even when a dependency violates Error typing.
  // eslint-disable-next-line @typescript-eslint/only-throw-error
  if (originalError) throw originalError
  // eslint-disable-next-line @typescript-eslint/only-throw-error
  if (cleanupError) throw cleanupError
}
