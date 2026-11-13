/**
 * Preload bridge — the ONLY module permitted to touch `ipcRenderer` (enforced
 * by lint). It exposes a single typed surface, `window.hvir`, validated against
 * the shared IPC contract. The renderer never sees `ipcRenderer` and can only
 * reach channels declared in `INVOKE_CHANNELS`.
 */

import { contextBridge, ipcRenderer, sharedTexture, webUtils } from 'electron'
import { NativeTerminalPresentationReceiver } from './native-terminal-presentation'
import { createNativeTerminalCanvas } from './native-terminal-canvas'
import { NATIVE_TERMINAL_PRESENTATION as nativePresentation } from '../shared/native-terminal-presentation'

const nativeReceiver = new NativeTerminalPresentationReceiver(
  createNativeTerminalCanvas,
  (grant) =>
    ipcRenderer.send(nativePresentation.acknowledgementChannel, {
      kind: 'renderer-failure',
      grant,
    }),
)
ipcRenderer.on(
  nativePresentation.grantChannel,
  (_event, value: { viewId: string; grant?: unknown }) => nativeReceiver.grant(value),
)
ipcRenderer.on(
  nativePresentation.statusChannel,
  (
    _event,
    value: import('../shared/native-terminal-presentation').NativeTerminalPresentationStatus,
  ) => nativeReceiver.status(value),
)
ipcRenderer.on(
  nativePresentation.pixelsChannel,
  (
    _event,
    value: {
      ticket: string
      frame: import('../shared/native-terminal-presentation').NativeTerminalPixelFrame
    },
  ) => {
    if (!value || typeof value.ticket !== 'string') return
    const accepted = nativeReceiver.pixels(value.frame)
    ipcRenderer.send(nativePresentation.acknowledgementChannel, {
      kind: 'pixels',
      ticket: value.ticket,
      accepted,
    })
  },
)
sharedTexture.setSharedTextureReceiver(({ importedSharedTexture }, metadata: unknown) =>
  Promise.resolve().then(() => nativeReceiver.receive(importedSharedTexture, metadata)),
)

import {
  EVENT_CHANNELS,
  MAX_EXTERNAL_FILE_SOURCES,
  RENDERER_INVOKE_CHANNELS,
  SEND_CHANNELS,
  isRendererDiagnosticSession,
  type HvirApi,
  type IpcEventChannel,
  type IpcEventPayload,
  type RendererIpcInvokeChannel,
  type IpcRequest,
  type IpcResponse,
  type IpcSendChannel,
  type IpcSendPayload,
} from '../shared'
import { RendererDiagnosticsAdapter } from './renderer-diagnostics'
import { terminalClipboardFilePasteText } from './terminal-clipboard-file-paste'

const rendererDiagnostics = new RendererDiagnosticsAdapter({
  send: (batch) => ipcRenderer.send('diagnostics:render-containment', batch),
})

let readyGeneration: number | undefined
let readyRequested = false
let readySent = false
const signalRendererReady = (): void => {
  if (!readyRequested || readySent || readyGeneration === undefined) return
  readySent = true
  ipcRenderer.send('app:renderer-ready', { ownerGeneration: readyGeneration })
}

ipcRenderer.on('diagnostics:session', (_event, session: unknown) => {
  rendererDiagnostics.activate(session)
  if (isRendererDiagnosticSession(session)) {
    readyGeneration = session.ownerGeneration
    signalRendererReady()
  }
})

const api: HvirApi = {
  nativeTerminalPresentation: {
    mount: (viewId, elementId) => nativeReceiver.mount(viewId, elementId),
    unmount: (viewId) => nativeReceiver.unmount(viewId),
    onStatus: (listener) => nativeReceiver.onStatus(listener),
  },
  rendererReady: () => {
    readyRequested = true
    signalRendererReady()
  },
  resolveTerminalClipboardFilePaste: (file) =>
    terminalClipboardFilePasteText(file, (candidate) =>
      webUtils.getPathForFile(candidate),
    ),
  diagnostics: {
    processSandboxed: process.sandboxed,
    contextIsolated: process.contextIsolated,
    recordRenderContainment: (occurrenceId) =>
      rendererDiagnostics.recordRenderContainment(occurrenceId),
  },
  externalFiles: {
    acquireDropped: (files) => {
      if (files.length > MAX_EXTERNAL_FILE_SOURCES) {
        return Promise.reject(
          new Error(
            `The external file list exceeds ${MAX_EXTERNAL_FILE_SOURCES} entries`,
          ),
        )
      }
      const paths = files.map((file) => webUtils.getPathForFile(file))
      return ipcRenderer.invoke('fs:acquire-dropped-files', { paths })
    },
  },
  invoke<C extends RendererIpcInvokeChannel>(
    channel: C,
    request: IpcRequest<C>,
  ): Promise<IpcResponse<C>> {
    if (!RENDERER_INVOKE_CHANNELS.includes(channel)) {
      return Promise.reject(
        new Error(`hvir: blocked non-contract IPC channel '${channel}'`),
      )
    }
    return ipcRenderer.invoke(channel, request) as Promise<IpcResponse<C>>
  },
  send<C extends IpcSendChannel>(channel: C, payload: IpcSendPayload<C>): void {
    if (!SEND_CHANNELS.includes(channel)) {
      throw new Error(`hvir: blocked non-contract IPC channel '${channel}'`)
    }
    ipcRenderer.send(channel, payload)
  },
  on<E extends IpcEventChannel>(
    channel: E,
    callback: (payload: IpcEventPayload<E>) => void,
  ) {
    if (!EVENT_CHANNELS.includes(channel)) {
      throw new Error(`hvir: blocked non-contract IPC channel '${channel}'`)
    }
    const listener = (_event: Electron.IpcRendererEvent, payload: unknown): void => {
      callback(payload as IpcEventPayload<E>)
    }
    ipcRenderer.on(channel, listener)
    return () => {
      ipcRenderer.off(channel, listener)
    }
  },
}

contextBridge.exposeInMainWorld('hvir', api)
