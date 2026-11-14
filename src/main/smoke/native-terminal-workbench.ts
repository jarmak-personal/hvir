import { verifyNativeTerminalPaste } from './native-terminal-paste'
import {
  verifyNativeTerminalInput,
  verifyNativeReadonlyInput,
} from './native-terminal-input'
import { app, type BrowserWindow } from 'electron'
import { nativeTerminalLinuxOptionsFromEnvironment } from '../../shared/native-terminal-linux'
import { nativeTerminalDiagnostics } from '../terminal/native-terminal-diagnostics'
import type { PtySupervisor } from '../pty/pty-supervisor'
import {
  createNativeTerminalApplication,
  type NativeTerminalApplication,
} from '../terminal/native-terminal-application'
import type { ElectronSmokeDependencies } from './bootstrap-contract'
import type { SmokeCleanup } from './cleanup'
import type { RendererResourceScopes } from '../renderer-resource-scopes'
import { ensureExplicitBareShellLaunch } from './terminal-explicit-launch'

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
  }: Pick<ElectronSmokeDependencies, 'mode' | 'rendererResources'>,
  supervisor: PtySupervisor,
  cleanup: SmokeCleanup,
) {
  const nativeTerminals =
    mode === 'native-terminal-workbench'
      ? await createNativeTerminalApplication(supervisor, (owner) =>
          rendererResources.isCurrent(owner),
        )
      : undefined
  if (nativeTerminals)
    cleanup.defer('native development terminals', () => nativeTerminals.dispose())
  return {
    ipc: { nativeTerminals, nativeTerminalPresentation: nativeTerminals?.targets },
    async run(win: BrowserWindow): Promise<boolean> {
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
): Promise<void> {
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
  const largePaste = await verifyNativeTerminalPaste(win, ptys, native, managed)
  const initialGeometry = (await native.inspectRetained(managed.id, owner)).geometry
  await win.webContents.executeJavaScript(`(() => {
    const control = [...document.querySelectorAll('button[aria-label="Collapse terminal rail"],button[aria-label="Restore terminal rail"]')]
      .find(button => button instanceof HTMLButtonElement && !button.closest('[hidden]') && button.getBoundingClientRect().width > 0);
    if (!(control instanceof HTMLButtonElement)) throw new Error('Native pane width control missing');
    control.click();
    return true;
  })()`)
  await waitFor(async () => {
    const geometry = (await native.inspectRetained(managed.id, owner)).geometry
    return (
      geometry.serial > initialGeometry.serial &&
      geometry.columns !== initialGeometry.columns
    )
  })
  const geometry = (await native.inspectRetained(managed.id, owner)).geometry
  await ptys.writeConfirmed(
    managed.id,
    owner.id,
    "printf 'HVIR_NATIVE_SIZE='; stty size\r",
    owner.generation,
  )
  await waitFor(async () =>
    (await text()).includes('HVIR_NATIVE_SIZE=' + geometry.rows + ' ' + geometry.columns),
  )
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
  if (!before.includes('HVIR_NATIVE_WORKBENCH_READY'))
    throw new Error('native-workbench-marker')
  await ptys.writeConfirmed(
    managed.id,
    owner.id,
    "printf '\\033[?25lHVIR_NATIVE_FINAL_TAIL\\n'; exit\r",
    owner.generation,
  )
  await waitFor(() => Promise.resolve(native.sessions.get(managed.id)?.readonly === true))
  if (!(await text()).includes('HVIR_NATIVE_FINAL_TAIL'))
    throw new Error('native-workbench-exit-tail')
  if (ptys.list().length) throw new Error('native-workbench-exit-live-pty')
  console.log('[native-workbench] retained-exit-tail')
  const readonlyInput = await verifyNativeReadonlyInput(win, native, managed)
  await native.remove(managed.id, managed.instanceId)
  if (native.sessions.get(managed.id)) throw new Error('native-workbench-removed-state')
  console.log(
    nativeWorkbenchReceiptLine({
      platform: process.platform,
      arch: process.arch,
      actualWorkbench: true,
      sourceCommit: process.env['HVIR_SMOKE_SOURCE_COMMIT'] ?? null,
      sourceDirty: process.env['HVIR_SMOKE_SOURCE_DIRTY'] === '1',
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
