import type { BrowserWindow } from 'electron'
import type { ManagedPty, PtySupervisor } from '../pty/pty-supervisor'
import type { NativeTerminalApplication } from '../terminal/native-terminal-application'
import type { RendererOwner, RendererResourceScopes } from '../renderer-resource-scopes'
import type { NativeTerminalViewGrant } from '../../shared/native-terminal-presentation'
import { NATIVE_TERMINAL_LIMITS } from '../../shared/native-terminal'
import { hostPathEquals } from '../../shared/host-path'
import { NativeTerminalImportQuarantined } from '../terminal/native-terminal-import'
import { focusSmokeWindow } from './window-focus'

const BLOCK_ENTER = 'HVIR_QUARANTINE_RECOVERY_BLOCK_ENTER'
const SOURCE_MARKER = 'HVIR_QUARANTINE_RECOVERY_SOURCE'
const SEND_TIMEOUT =
  'transfer shared texture timed out after 1000ms, ensure you have registered receiver at renderer process.'

/** One owned receiver stall exercises actual send quarantine and automatic recovery.
 * This fault-only proof is separate from ordinary responsiveness qualification. */
export async function verifyNativeTerminalQuarantineRecovery({
  win,
  ptys,
  native,
  resources,
  managed,
  owner,
  viewId,
  handle,
  grant,
  eligible,
  wait,
}: {
  win: BrowserWindow
  ptys: PtySupervisor
  native: NativeTerminalApplication
  resources: RendererResourceScopes
  managed: ManagedPty
  owner: RendererOwner
  viewId: string
  handle: string
  grant(this: void): NativeTerminalViewGrant | undefined
  eligible: boolean
  wait(
    this: void,
    predicate: () => boolean | Promise<boolean>,
    stage: string,
  ): Promise<void>
}) {
  if (!eligible)
    return {
      qualified: false,
      faultOnly: false,
      presentationMode: 'native-pixels' as const,
    }
  const initialGrant = grant()
  const captured = initialGrant && { ...initialGrant }
  const frame = win.webContents.mainFrame
  const currentActor = (): boolean => {
    const actor = ptys.list().find((entry) => entry.id === managed.id)
    const session = native.sessions.get(managed.id)
    return (
      resources.isCurrent(owner) &&
      !!actor &&
      actor.instanceId === managed.instanceId &&
      actor.pid === managed.pid &&
      actor.providerId === managed.providerId &&
      actor.profileId === managed.profileId &&
      actor.ownerId === owner.id &&
      actor.ownerGeneration === owner.generation &&
      hostPathEquals(actor.workspaceRoot, managed.workspaceRoot) &&
      session?.handle === handle &&
      session.session.instanceId === managed.instanceId &&
      session.session.ownerId === owner.id &&
      session.session.ownerGeneration === owner.generation &&
      hostPathEquals(session.session.workspaceRoot, managed.workspaceRoot)
    )
  }
  if (
    !captured ||
    captured.viewId !== viewId ||
    !currentActor() ||
    frame.isDestroyed() ||
    frame.detached
  )
    throw new Error('native-quarantine-recovery-precondition')
  let entered = false
  const consoleMessage = (
    event: Electron.Event<Electron.WebContentsConsoleMessageEventParams>,
  ): void => {
    if (
      event.message === BLOCK_ENTER &&
      event.level === 'info' &&
      event.frame === frame &&
      !frame.isDestroyed() &&
      !frame.detached &&
      win.webContents.mainFrame === frame &&
      resources.isCurrent(owner)
    )
      entered = true
  }
  let stage = 'block-enter'
  let stall: Promise<unknown> | undefined
  let detach: ReturnType<PtySupervisor['attach']> | undefined
  win.webContents.on('console-message', consoleMessage)
  try {
    stall = win.webContents.executeJavaScript(`(() => {
      console.info(${JSON.stringify(BLOCK_ENTER)});
      const deadline = performance.now() + 1800;
      while (performance.now() < deadline) {}
      return true;
    })()`)
    // Retain the original promise and contain rejection until its owned await.
    void stall.catch(() => undefined)
    await wait(() => entered, stage)
    stage = 'source-output'
    const octal = [...(SOURCE_MARKER + '\n')]
      .map((char) => '\\' + char.charCodeAt(0).toString(8).padStart(3, '0'))
      .join('')
    await ptys.writeConfirmed(
      managed.id,
      owner.id,
      `printf '${octal}'\r`,
      owner.generation,
    )
    await wait(async () => {
      if (!currentActor()) throw new Error('native-quarantine-recovery-actor-changed')
      const bytes = await native.readRetained(managed.id, owner)
      if (bytes.byteLength > NATIVE_TERMINAL_LIMITS.responseBytes)
        throw new Error('native-quarantine-recovery-read-bound')
      return new TextDecoder().decode(bytes).includes(SOURCE_MARKER)
    }, stage)
    stage = 'actual-send-timeout'
    let sendTimeoutObserved = false
    await wait(async () => {
      try {
        await native.demand(viewId, owner)
      } catch (error) {
        if (
          !(error instanceof NativeTerminalImportQuarantined) ||
          !(error.cause instanceof Error) ||
          error.cause.message !== SEND_TIMEOUT
        )
          throw error
        sendTimeoutObserved = true
      }
      return sendTimeoutObserved
    }, stage)
    stage = 'block-return'
    if ((await stall) !== true) throw new Error('native-quarantine-recovery-block-result')
    stage = 'same-actor-current-draw'
    const currentDraw = (): boolean => {
      const current = grant()
      const drawn = native.targets.drawn(viewId, win.webContents.mainFrame)
      return (
        currentActor() &&
        !!current &&
        current.viewId === viewId &&
        current.nativeEpoch === captured.nativeEpoch &&
        current.geometrySerial > captured.geometrySerial &&
        !!drawn &&
        drawn.nativeEpoch === current.nativeEpoch &&
        drawn.geometrySerial === current.geometrySerial &&
        drawn.attachment === current.attachment
      )
    }
    const scope = `const surface=document.querySelector('.terminal-surface[data-terminal-session="'+CSS.escape(${JSON.stringify(managed.id)})+'"]');const pane=surface?.querySelector('.native-terminal-pane');const target=pane?.querySelector('[id^="native-terminal-"]');const input=pane?.querySelector('textarea');`
    const visible = (): Promise<boolean> =>
      win.webContents.executeJavaScript(`(() => {${scope}
        const appearance=pane?.__hvirNativeTerminalAppearance,canvas=target?.querySelector('canvas');
        return !!surface?.classList.contains('visible')&&!!pane?.isConnected&&
          target?.id===${JSON.stringify('native-terminal-' + viewId)}&&
          canvas instanceof HTMLCanvasElement&&canvas.width>0&&canvas.height>0&&
          target.querySelector('[role="status"]')?.textContent!=='Terminal unavailable'&&
          pane.getAttribute('aria-readonly')!=='true'&&appearance?.applied===true&&
          input instanceof HTMLTextAreaElement&&!input.disabled&&!input.readOnly;
      })()`)
    await wait(async () => currentDraw() && (await visible()), stage)
    stage = 'post-recovery-selection-authority'
    await win.webContents
      .executeJavaScript(`window.hvir.invoke('native-terminal:selection',
      {viewId:${JSON.stringify(viewId)},action:'state'})`)
    stage = 'keyboard-input'
    await focusSmokeWindow(win, 'window')
    const focused: unknown = await win.webContents.executeJavaScript(`(() => {${scope}
      if(!(input instanceof HTMLTextAreaElement))return false;
      input.focus();return document.activeElement===input;
    })()`)
    if (focused !== true) throw new Error('native-quarantine-recovery-input-focus')
    let output = ''
    detach = ptys.attach(
      managed.id,
      owner.id,
      {
        onData: (data) => {
          output = (output + data).slice(-4096)
        },
      },
      owner.generation,
    )
    // Ignore attach replay: only real keyboard input below may satisfy this proof.
    output = ''
    const keys = [...'echo q']
      .map((key) => (key === ' ' ? 'Space' : key.toUpperCase()))
      .concat('Enter')
    for (const keyCode of keys) {
      win.webContents.sendInputEvent({ type: 'keyDown', keyCode })
      win.webContents.sendInputEvent({ type: 'keyUp', keyCode })
    }
    await wait(() => output.includes('\r\nq\r\n'), stage)
    stage = 'final-current-state'
    if (!currentDraw() || !(await visible()))
      throw new Error('native-quarantine-recovery-final-state')
    return {
      qualified: true,
      faultOnly: true,
      sendTimeoutObserved,
      samePTY: true,
      sameNativeHandle: true,
      sameEpoch: true,
      currentDraw: true,
      inputEcho: true,
      visible: true,
    }
  } catch (cause) {
    throw new Error('native-quarantine-recovery:' + stage, { cause })
  } finally {
    try {
      win.webContents.removeListener('console-message', consoleMessage)
    } catch {
      /* Cleanup must still await the owned stall and preserve the original cause. */
    }
    try {
      await detach?.()
    } catch {
      /* A retired source subscription cannot replace the qualification failure. */
    }
    await stall?.catch(() => undefined)
  }
}
