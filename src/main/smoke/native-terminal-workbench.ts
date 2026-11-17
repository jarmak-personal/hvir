import { verifyNativeTerminalAppearance } from './native-terminal-appearance'
import { createNativeTerminalSshLifecycleFixture } from '../../../test/fixtures/native-terminal-ssh-lifecycle'
import { createRemoteProjectFileSmokeHost } from './project-file-operations'
import { verifyNativeTerminalLifetimes } from './native-terminal-lifecycle'
import { verifyNativeTerminalFailureLifetimes } from './native-terminal-lifecycle-failure'
import { observeNativeTerminalUtilities } from './native-terminal-utility-observation'
import {
  verifyNativeTerminalSelection,
  verifyNativeReadonlySelection,
  NATIVE_SELECTION_RETENTION_MARKER,
  NATIVE_READONLY_SELECTION,
} from './native-terminal-selection'
import {
  NativeEffectsClipboardObservation,
  verifyNativeTerminalEffects,
} from './native-terminal-effects'
import { verifyNativeTerminalPaste } from './native-terminal-paste'
import {
  verifyNativeTerminalQuery,
  verifyNativeReadonlyQuery,
} from './native-terminal-query'
import {
  verifyNativeTerminalInput,
  verifyNativeReadonlyInput,
} from './native-terminal-input'
import { app, type BrowserWindow } from 'electron'
import { nativeTerminalLinuxOptionsFromEnvironment } from '../../shared/native-terminal-linux'
import { nativeTerminalDiagnostics } from '../terminal/native-terminal-diagnostics'
import type { ManagedPty, PtySupervisor } from '../pty/pty-supervisor'
import {
  createNativeTerminalApplication,
  type NativeTerminalApplication,
} from '../terminal/native-terminal-application'
import type { ElectronSmokeDependencies } from './bootstrap-contract'
import type { SmokeCleanup } from './cleanup'
import type { RendererResourceScopes } from '../renderer-resource-scopes'
import { ensureExplicitBareShellLaunch } from './terminal-explicit-launch'
import type { ProjectHost } from '../project-host'
import { asHostId, hostPath, type ProjectState } from '../../shared'
import type { NativeTerminalGeometry } from '../../shared/native-terminal'
import { UI_RESPONSIVENESS_BUDGET } from '../../shared/ui-responsiveness-budget'
import { nativeWorkbenchPerformanceMode } from './native-terminal-performance'
import { nativeWorkbenchGeometryReadiness } from './native-terminal-workbench-geometry'
import {
  createObservedNativeFrameImports,
  observeNativeReceiverDiagnostic,
} from './native-terminal-import-diagnostic'

/** Format the qualification receipt; the runner keeps stdout separate from diagnostics. */
export function nativeWorkbenchReceiptLine(
  receipt: Readonly<Record<string, unknown>>,
): string {
  return 'HVIR_NATIVE_WORKBENCH_OK ' + JSON.stringify(receipt)
}

/** Composition and dispatch for this opt-in scenario stay with its native owner. */
export async function createNativeWorkbench(
  {
    mode,
    rendererResources,
    projectRoot,
    localHost,
  }: Pick<ElectronSmokeDependencies, 'mode' | 'rendererResources' | 'projectRoot'> & {
    readonly localHost: ProjectHost
  },
  supervisor: PtySupervisor,
  cleanup: SmokeCleanup,
) {
  const utilities =
    mode === 'native-terminal-workbench' ? observeNativeTerminalUtilities() : undefined
  if (utilities) cleanup.defer('native utility observation', () => utilities.dispose())
  const systemClipboard =
    mode === 'native-terminal-workbench'
      ? new NativeEffectsClipboardObservation()
      : undefined
  const nativeTerminals =
    mode === 'native-terminal-workbench' || mode === 'capacity'
      ? await createNativeTerminalApplication(
          supervisor,
          (owner) => rendererResources.isCurrent(owner),
          systemClipboard,
          createObservedNativeFrameImports,
        )
      : undefined
  if (nativeTerminals)
    cleanup.defer('native development terminals', () => nativeTerminals.dispose())
  const nativeSsh =
    mode === 'native-terminal-workbench'
      ? await createNativeTerminalSshLifecycleFixture(localHost, projectRoot)
      : undefined
  if (nativeSsh) cleanup.defer('native SSH lifecycle fixture', () => nativeSsh.dispose())
  const smokeRemoteRoot =
    nativeSsh?.root ?? hostPath(asHostId('smoke-remote'), '/srv/hvir')
  const smokeRemoteHost =
    nativeSsh?.host ??
    createRemoteProjectFileSmokeHost({
      localHost,
      localRoot: projectRoot,
      remoteRoot: smokeRemoteRoot,
    })
  return {
    systemClipboard,
    smokeRemoteRoot,
    smokeRemoteHost,
    ipc: { nativeTerminals, nativeTerminalPresentation: nativeTerminals?.targets },
    async run(
      win: BrowserWindow,
      project: { get(): ProjectState; remoteFiles(): ProjectState },
      publishProject: (state: ProjectState) => void,
    ): Promise<boolean> {
      if (mode !== 'native-terminal-workbench') return false
      if (!nativeTerminals)
        throw new Error(
          'Select HVIR_NATIVE_TERMINAL_LIBRARY for native workbench qualification',
        )
      await verifyNativeTerminalWorkbench(
        win,
        supervisor,
        nativeTerminals,
        rendererResources,
        systemClipboard,
        utilities,
        nativeSsh &&
          ((application, managed) =>
            nativeSsh.verify(win, supervisor, application, managed, {
              get: () => project.get(),
              remote: () => project.remoteFiles(),
              publish: publishProject,
            })),
      )
      console.log('HVIR_SMOKE_OK')
      return true
    },
  }
}

/** Actual production renderer/IPC/supervisor/ProjectHost/native engine composition.
 * Selected explicitly; this is not the hosted hardware/performance acceptance. */
export async function verifyNativeTerminalWorkbench(
  win: BrowserWindow,
  ptys: PtySupervisor,
  native: NativeTerminalApplication,
  resources: RendererResourceScopes,
  clipboard?: NativeEffectsClipboardObservation,
  utilities?: ReturnType<typeof observeNativeTerminalUtilities>,
  qualifySsh?: (
    application: NativeTerminalApplication,
    managed: ManagedPty,
  ) => Promise<unknown>,
): Promise<void> {
  const performanceMode = nativeWorkbenchPerformanceMode()
  const rendererSandboxed = (await win.webContents.executeJavaScript(
    'window.hvir.diagnostics.processSandboxed',
  )) as unknown
  if (
    rendererSandboxed !== true ||
    (await win.webContents.executeJavaScript(
      'window.hvir.diagnostics.contextIsolated',
    )) !== true
  )
    throw new Error('native-workbench-renderer-isolation')
  await win.webContents.executeJavaScript(
    `window.nativeQualificationModes=[];window.hvir.nativeTerminalPresentation.onStatus(value=>{window.nativeQualificationModes.push(value.mode);window.nativeQualificationModes=window.nativeQualificationModes.slice(-8)});true`,
  )
  // Pixel qualification needs room beside the visible Find bar, including
  // history reveals at viewport top. Establish the fixture before any Surface.
  const initialBounds = win.getContentBounds()
  if (initialBounds.width < 1280) {
    win.setContentSize(1280, initialBounds.height)
    await win.webContents.executeJavaScript(
      'new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve)))',
    )
  }
  console.log('[native-workbench] launch')
  await ensureExplicitBareShellLaunch(win, ptys)
  const managed = ptys.list()[0]
  if (!managed || ptys.list().length !== 1)
    throw new Error('native-workbench-spawn-count')
  const owner = { id: managed.ownerId, generation: managed.ownerGeneration }
  resources.assertCurrent(owner)
  const record = native.sessions.get(managed.id)
  if (!record || record.session.instanceId !== managed.instanceId)
    throw new Error('native-workbench-instance-identity')
  const waitFor = async (check: () => Promise<boolean>): Promise<void> => {
    const deadline = Date.now() + 15000
    do {
      if (await check()) return
      await new Promise<void>((resolve) => setTimeout(resolve, 25))
    } while (Date.now() < deadline)
    throw new Error('native-workbench-observation-timeout')
  }
  const text = async () =>
    new TextDecoder().decode(await native.readRetained(managed.id, owner))
  // M10's destructive fixture precedes M9's original-ready/retention lifetime.
  const nativeQuery = await verifyNativeTerminalQuery(
    win,
    ptys,
    native,
    managed,
    performanceMode,
  )
  await ptys.writeConfirmed(
    managed.id,
    owner.id,
    "printf '\\033[41mHVIR_NATIVE_WORKBENCH_READY\\033[0m\\n'\r",
    owner.generation,
  )
  await waitFor(async () => (await text()).includes('HVIR_NATIVE_WORKBENCH_READY'))
  await waitFor(
    async () =>
      win.webContents.executeJavaScript(
        `Boolean(document.querySelector('[id^="native-terminal-"] canvas'))`,
      ) as Promise<boolean>,
  )
  console.log('[native-workbench] parser-marker')
  let redPixels = 0
  await waitFor(async () => {
    const bounds = (await win.webContents.executeJavaScript(`(() => {
      const canvas=document.querySelector('[id^="native-terminal-"] canvas');
      if (!canvas) return;
      const b=canvas.getBoundingClientRect();
      return {x:Math.ceil(b.x),y:Math.ceil(b.y),width:Math.floor(b.width),height:Math.floor(b.height)};
    })()`)) as { x: number; y: number; width: number; height: number } | undefined
    if (!bounds || bounds.width < 32 || bounds.height < 32) return false
    const image = await win.webContents.capturePage(bounds)
    const bitmap = image.toBitmap()
    redPixels = 0
    for (let offset = 0; offset < bitmap.length; offset += 4) {
      const blue = bitmap[offset]!,
        green = bitmap[offset + 1]!,
        red = bitmap[offset + 2]!
      if (red > 120 && red > green * 1.4 && red > blue * 1.3) redPixels++
    }
    return redPixels >= 500
  })
  console.log('[native-workbench] rendered-marker')
  await win.webContents.executeJavaScript(
    `(() => {const input=document.querySelector('.native-terminal-pane textarea');if(!(input instanceof HTMLTextAreaElement))throw new Error('Native textarea missing');input.focus({preventScroll:true});return true;})()`,
  )
  await win.webContents.insertText("printf '\\116\\113\\105\\131\\067\\n'")
  win.webContents.sendInputEvent({ type: 'keyDown', keyCode: 'Enter' })
  win.webContents.sendInputEvent({ type: 'keyUp', keyCode: 'Enter' })
  await waitFor(async () => (await text()).includes('NKEY7'))
  console.log('[native-workbench] encoded-keyboard')
  const nativeInput = await verifyNativeTerminalInput(win, ptys, native, managed)
  if (!clipboard) throw new Error('native-effects-clipboard-port-missing')
  const nativeEffects = await verifyNativeTerminalEffects(
    win,
    ptys,
    native,
    managed,
    clipboard,
    performanceMode,
  )
  const nativeSelection = await verifyNativeTerminalSelection(
    win,
    ptys,
    native,
    managed,
    performanceMode,
  )
  const largePaste = await verifyNativeTerminalPaste(
    win,
    ptys,
    native,
    managed,
    performanceMode,
  )
  const nativeAppearance = await verifyNativeTerminalAppearance(
    win,
    ptys,
    native,
    managed,
  )
  const nativeLifetimes = await verifyNativeTerminalLifetimes(win, ptys, native, managed)
  const readGeometry = nativeWorkbenchGeometryReadiness(win, ptys, native, managed)
  let initialGeometry!: NativeTerminalGeometry
  await waitFor(async () => {
    const current = await readGeometry()
    if (!current) return false
    initialGeometry = current
    return true
  })
  await win.webContents.executeJavaScript(`(() => {
    const control = [...document.querySelectorAll('button[aria-label="Collapse terminal rail"],button[aria-label="Restore terminal rail"]')]
      .find(button => button instanceof HTMLButtonElement && !button.closest('[hidden]') && button.getBoundingClientRect().width > 0);
    if (!(control instanceof HTMLButtonElement)) throw new Error('Native pane width control missing');
    control.click();
    return true;
  })()`)
  let geometry!: NativeTerminalGeometry
  await waitFor(async () => {
    const current = await readGeometry()
    if (
      !current ||
      current.serial <= initialGeometry.serial ||
      current.columns === initialGeometry.columns
    )
      return false
    geometry = current
    return true
  })
  await ptys.writeConfirmed(
    managed.id,
    owner.id,
    "printf 'HVIR_NATIVE_SIZE='; stty size\r",
    owner.generation,
  )
  let resizeObservation: unknown
  try {
    await waitFor(async () => {
      const retained = await text()
      const marker = retained.lastIndexOf('HVIR_NATIVE_SIZE=')
      const size =
        marker < 0
          ? null
          : /^HVIR_NATIVE_SIZE=(\d{1,6}) (\d{1,6})/.exec(
              retained.slice(marker, marker + 50),
            )
      resizeObservation = {
        expectedRows: geometry.rows,
        expectedColumns: geometry.columns,
        expectedSerial: geometry.serial,
        markerPresent: marker >= 0,
        observedRows: size ? Number(size[1]) : undefined,
        observedColumns: size ? Number(size[2]) : undefined,
      }
      return retained.includes(
        'HVIR_NATIVE_SIZE=' + geometry.rows + ' ' + geometry.columns,
      )
    })
  } catch (error) {
    console.error('HVIR_NATIVE_RESIZE_FAILURE', JSON.stringify(resizeObservation))
    throw error
  }
  console.log('[native-workbench] resized-stty')
  const nativeRenderer = await native.rendererInfo(managed.id, owner)
  const linuxOptions =
    process.platform === 'linux'
      ? nativeTerminalLinuxOptionsFromEnvironment(process.env)
      : undefined
  const stack = await nativeTerminalDiagnostics(app, process.env)
  const observedModes: unknown = await win.webContents.executeJavaScript(
    'window.nativeQualificationModes',
  )
  const before = await text()
  if (!before.includes(NATIVE_SELECTION_RETENTION_MARKER))
    throw new Error('native-workbench-marker')
  await ptys.writeConfirmed(
    managed.id,
    owner.id,
    `hvir_native_row=0; while [ "$hvir_native_row" -lt 180 ]; do printf '\\033[44m native readonly row %s \\033[0m\\n' "$hvir_native_row"; hvir_native_row=$((hvir_native_row+1)); done; unset hvir_native_row; printf '\\033[?25lHVIR_NATIVE_FINAL_TAIL\\n\\033[H${NATIVE_READONLY_SELECTION}'; exit\r`,
    owner.generation,
  )
  await waitFor(() => Promise.resolve(native.sessions.get(managed.id)?.readonly === true))
  if (
    !(await text()).includes('HVIR_NATIVE_FINAL_TAIL') ||
    !(await text()).includes(NATIVE_SELECTION_RETENTION_MARKER)
  )
    throw new Error('native-workbench-exit-tail')
  if (ptys.list().length) throw new Error('native-workbench-exit-live-pty')
  console.log('[native-workbench] retained-exit-tail')
  const readonlyInput = await verifyNativeReadonlyInput(win, native, managed)
  const readonlySelection = await verifyNativeReadonlySelection(
    win,
    ptys,
    native,
    managed,
    performanceMode,
  )
  const readonlyQuery = await verifyNativeReadonlyQuery(
    win,
    native,
    managed,
    performanceMode,
  )
  if (ptys.list().length) throw new Error('native-query-readonly-revived-pty')
  if (!qualifySsh) throw new Error('native-lifecycle-ssh-fixture-missing')
  const nativeSshLifetimes = await qualifySsh(native, managed)
  console.log('HVIR_NATIVE_SSH_LIFECYCLE_OK ' + JSON.stringify(nativeSshLifetimes))
  if (!utilities) throw new Error('native-lifecycle-utility-observation-missing')
  const previousImportDiagnostic = process.env['HVIR_NATIVE_IMPORT_DIAGNOSTICS']
  const stopImportDiagnostic =
    process.env['HVIR_NATIVE_IMPORT_DIAGNOSTIC_WINDOW'] === '1'
      ? observeNativeReceiverDiagnostic(win, resources)
      : undefined
  let nativeFailureLifetimes
  try {
    // Select only the real replacement/failure window, keeping the earlier
    // query/capture workload out of this bounded diagnostic population.
    if (process.env['HVIR_NATIVE_IMPORT_DIAGNOSTIC_WINDOW'] === '1')
      process.env['HVIR_NATIVE_IMPORT_DIAGNOSTICS'] = '1'
    nativeFailureLifetimes = await verifyNativeTerminalFailureLifetimes(
      win,
      ptys,
      native,
      resources,
      utilities,
      managed,
    )
  } finally {
    stopImportDiagnostic?.()
    if (previousImportDiagnostic === undefined)
      delete process.env['HVIR_NATIVE_IMPORT_DIAGNOSTICS']
    else process.env['HVIR_NATIVE_IMPORT_DIAGNOSTICS'] = previousImportDiagnostic
  }
  console.log(
    nativeWorkbenchReceiptLine({
      platform: process.platform,
      arch: process.arch,
      actualWorkbench: true,
      sourceCommit: process.env['HVIR_SMOKE_SOURCE_COMMIT'] ?? null,
      sourceDirty: process.env['HVIR_SMOKE_SOURCE_DIRTY'] === '1',
      performance: {
        mode: performanceMode,
        maximumInclusiveMs: UI_RESPONSIVENESS_BUDGET.responsivenessMaxMs,
        controlledCapacityQualified: false,
        phases: [
          nativeQuery.performance,
          nativeEffects.performance,
          nativeSelection.performance,
          ...largePaste.cases.map((fixture) => fixture.performance),
          readonlySelection.performance,
          readonlyQuery.performance,
        ],
      },
      rendererSandboxed: true,
      rendererContextIsolated: true,
      supervisorSpawns: 1,
      nativeInstanceMatched: true,
      parserMarker: true,
      retainedExitTail: true,
      rendererCanvas: true,
      capturedAnsiRedPixels: redPixels,
      nativeEncodedKeyboard: true,
      nativeInput,
      nativeEffects,
      nativeSelection,
      nativeQuery,
      nativeAppearance,
      nativeLifetimes,
      nativeFailureLifetimes,
      nativeSshLifetimes,
      readonlySelection,
      readonlyQuery,
      largePaste,
      readonlyInput,
      resizeControl: 'terminal-rail',
      resizeAcknowledgedByStty: { rows: geometry.rows, columns: geometry.columns },
      development: true,
      hardwareQualified: false,
      stack,
      requestedPresentation: linuxOptions?.presentationMode ?? 'auto',
      selectedDevice: linuxOptions?.device ?? null,
      nativeRenderer,
      producerCompletion:
        process.platform === 'linux'
          ? 'gl-finish-before-export'
          : 'metal-command-buffer-completed',
      backingScale: geometry.backingScale,
      observedModes,
    }),
  )
}
