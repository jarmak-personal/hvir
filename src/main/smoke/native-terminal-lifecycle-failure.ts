import { app, type BrowserWindow } from 'electron'
import type { ManagedPty, PtySupervisor } from '../pty/pty-supervisor'
import type { NativeTerminalApplication } from '../terminal/native-terminal-application'
import type { RendererResourceScopes } from '../renderer-resource-scopes'
import { verifyTerminalSplit } from './terminal-split'
import type { NativeTerminalViewGrant } from '../../shared/native-terminal-presentation'
import {
  observeNativeInputSend,
  type observeNativeTerminalUtilities,
} from './native-terminal-utility-observation'

/** Destructive qualification follows all seed-session input/query/pixel proofs.
 * Process metrics select only the uniquely named native utility owned by this app. */
export async function verifyNativeTerminalFailureLifetimes(
  win: BrowserWindow,
  ptys: PtySupervisor,
  native: NativeTerminalApplication,
  resources: RendererResourceScopes,
  utilityObservation: ReturnType<typeof observeNativeTerminalUtilities>,
  seed: ManagedPty,
) {
  const evaluate = <T>(source: string): Promise<T> =>
    win.webContents.executeJavaScript(`(()=>{${source}})()`)
  const wait = async (read: () => boolean | Promise<boolean>, stage: string) => {
    const deadline = Date.now() + 15000
    do {
      if (await read()) return
      await new Promise<void>((resolve) => setTimeout(resolve, 25))
    } while (Date.now() < deadline)
    throw new Error('native-lifecycle-failure-timeout:' + stage)
  }
  const oldState = native.sessions.get(seed.id)
  if (!oldState?.readonly || ptys.list().length !== 0)
    throw new Error('native-lifecycle-restart-not-readonly')
  await evaluate(
    `const restart=document.querySelector('.terminal-surface.active .terminal-restart');if(!(restart instanceof HTMLButtonElement)||restart.textContent?.trim()!=='Restart')throw new Error('native-lifecycle-restart-control');restart.click();return true;`,
  )
  await wait(() => ptys.list().length === 1, 'explicit-restart')
  const managed = ptys.list()[0]!
  const restartedState = native.sessions.get(managed.id)
  if (
    managed.instanceId === seed.instanceId ||
    managed.pid === seed.pid ||
    managed.providerId !== seed.providerId ||
    managed.profileId !== seed.profileId ||
    !restartedState ||
    restartedState.handle === oldState.handle ||
    restartedState.session.instanceId !== managed.instanceId ||
    native.sessions.get(seed.id)?.session.instanceId === seed.instanceId
  )
    throw new Error('native-lifecycle-restart-identity')
  const initialOwner = { id: managed.ownerId, generation: managed.ownerGeneration }
  const handle = native.sessions.get(managed.id)?.handle
  if (!handle) throw new Error('native-lifecycle-new-native-state')
  await wait(
    () => evaluate(`return !!document.querySelector('.native-terminal-pane canvas');`),
    'fresh-canvas',
  )
  await verifyTerminalSplit(win)
  await wait(() => ptys.list().length === 1, 'split-close')
  if (
    ptys.get(managed.id)?.instanceId !== managed.instanceId ||
    native.sessions.get(managed.id)?.handle !== handle
  )
    throw new Error('native-lifecycle-split-replaced-seed')

  const oldView = await evaluate<string>(
    `return document.querySelector('.native-terminal-pane [id^="native-terminal-"]').id.slice('native-terminal-'.length);`,
  )
  // Fault only the immediate presentation-target edge. The real presenter,
  // native resize, IPC, isolated receiver, and browser canvas remain in use.
  const targetDescriptor = Object.getOwnPropertyDescriptor(native.targets, 'create')
  const createTarget = native.targets.create.bind(native.targets)
  let rejectRefit = false
  let granted: NativeTerminalViewGrant | undefined
  const currentGrant = (): NativeTerminalViewGrant | undefined => granted
  let replacementGrants = 0
  native.targets.create = (...args) => {
    const target = createTarget(...args)
    return {
      ...target,
      publishGrant(grant, refit) {
        target.publishGrant(grant, refit)
        granted = grant
        if (grant) replacementGrants++
        if (!grant && refit && rejectRefit) {
          rejectRefit = false
          throw new Error('native-lifecycle-injected-refit-refusal')
        }
      },
    }
  }
  try {
    const loaded = new Promise<void>((resolve) =>
      win.webContents.once('did-finish-load', () => resolve()),
    )
    win.webContents.reload()
    await loaded
    await wait(
      () =>
        evaluate(
          `return !!document.querySelector('.terminal-recovery-dialog')||!!document.querySelector('.native-terminal-pane canvas');`,
        ),
      'replacement-recovery-decision',
    )
    const recoveryDecision = await evaluate<boolean>(
      `const dialog=document.querySelector('.terminal-recovery-dialog');if(!dialog)return false;const restore=[...dialog.querySelectorAll('button')].find(node=>node.textContent?.trim()==='Restore selected');if(!(restore instanceof HTMLButtonElement)||restore.disabled)throw new Error('native-lifecycle-recovery-control');restore.click();return true;`,
    )
    let replacementObservation: unknown
    try {
      await wait(async () => {
        const current = resources.currentOwner(initialOwner.id)
        if (
          current.generation <= initialOwner.generation ||
          !resources.isCurrent(current)
        )
          return false
        const dom = await evaluate<{
          hasCanvas: boolean
          panes: { viewId: string | null; sessionId: string | null }[]
        }>(
          `const panes=[...document.querySelectorAll('.native-terminal-pane')];const canvases=document.querySelectorAll('.native-terminal-pane canvas');const dialog=document.querySelector('.terminal-recovery-dialog');const restore=dialog&&[...dialog.querySelectorAll('button')].find(node=>node.textContent?.trim()==='Restore selected');return {hasCanvas:canvases.length>0,canvasCount:Math.min(canvases.length,8),panes:panes.slice(0,8).map(pane=>{const surface=pane.querySelector('[id^="native-terminal-"]');const input=pane.querySelector('textarea');return {viewId:surface?.id.slice(0,100)??null,sessionId:pane.closest('[data-terminal-session]')?.getAttribute('data-terminal-session')?.slice(0,100)??null,connected:pane.isConnected,paneUnavailable:pane.textContent?.includes('Native terminal unavailable')??false,surfaceUnavailable:surface?.querySelector('[role="status"]')?.textContent==='Terminal unavailable',inputDisabled:input instanceof HTMLTextAreaElement?input.disabled:null};}),dialogPresent:!!dialog,restorePresent:restore instanceof HTMLButtonElement,restoreDisabled:restore instanceof HTMLButtonElement?restore.disabled:null};`,
        )
        const pane = dom.panes.find(
          (pane) =>
            pane.sessionId === managed.id && pane.viewId?.startsWith('native-terminal-'),
        )
        const viewId = pane?.viewId?.slice('native-terminal-'.length)
        const drawn = viewId && native.targets.drawn(viewId, win.webContents.mainFrame)
        const retained = ptys.get(managed.id)
        const state = native.sessions.get(managed.id)
        replacementObservation = {
          recoveryDecision,
          owner: { ...current },
          retained: retained && {
            id: retained.id,
            instanceId: retained.instanceId,
            pid: retained.pid,
            ownerId: retained.ownerId,
            ownerGeneration: retained.ownerGeneration,
          },
          native: state && {
            handle: state.handle,
            instanceId: state.session.instanceId,
            ownerId: state.session.ownerId,
            ownerGeneration: state.session.ownerGeneration,
            retiring: state.retiring,
            unavailable: state.unavailable,
          },
          presentation: {
            viewId: viewId ?? null,
            drawn: drawn
              ? { screen: drawn.screen, geometrySerial: drawn.geometrySerial }
              : null,
          },
          dom,
        }
        return dom.hasCanvas
      }, 'replacement-document')
    } catch (error) {
      console.error(
        'HVIR_NATIVE_REPLACEMENT_FAILURE',
        JSON.stringify(replacementObservation),
      )
      throw error
    }
    const owner = resources.currentOwner(initialOwner.id)
    const retained = ptys.get(managed.id),
      state = native.sessions.get(managed.id)
    if (
      !retained ||
      retained.instanceId !== managed.instanceId ||
      retained.pid !== managed.pid ||
      retained.ownerGeneration !== owner.generation ||
      state?.handle !== handle ||
      state.session.instanceId !== managed.instanceId
    )
      throw new Error('native-lifecycle-rollover-replaced-state')
    let oldOwnerRejected = false
    try {
      await native.key(oldView, initialOwner, {
        key: 0,
        modifiers: 0,
        action: 1,
        text: 'x',
      })
    } catch {
      oldOwnerRejected = true
    }
    if (!oldOwnerRejected) throw new Error('native-lifecycle-rollover-old-input')

    const newView = await evaluate<string>(
      `return document.querySelector('.native-terminal-pane [id^="native-terminal-"]').id.slice('native-terminal-'.length);`,
    )
    if (!granted || granted.viewId !== newView)
      throw new Error('native-lifecycle-replacement-grant')
    const beforeRejectedRefit = granted
    const extent = await evaluate<{
      width: number
      height: number
      backingScale: number
    }>(
      `const bounds=document.querySelector('.native-terminal-pane [id^="native-terminal-"]').getBoundingClientRect();return {width:bounds.width,height:bounds.height,backingScale:devicePixelRatio};`,
    )
    const grantsBeforeRefusal = replacementGrants
    rejectRefit = true
    let rejectedRefit = false
    try {
      await native.update(newView, owner, {
        ...extent,
        width: extent.width + 2,
        visible: true,
      })
    } catch (error) {
      if (
        error instanceof Error &&
        error.message === 'native-lifecycle-injected-refit-refusal'
      )
        rejectedRefit = true
      else throw error
    }
    if (
      !rejectedRefit ||
      replacementGrants !== grantsBeforeRefusal ||
      granted ||
      native.targets.drawn(newView, win.webContents.mainFrame)
    )
      throw new Error('native-lifecycle-rejected-refit-authority')
    await wait(
      () =>
        evaluate(
          `return document.querySelectorAll('.native-terminal-pane canvas').length===0;`,
        ),
      'refit-refusal-release',
    )
    // Main unavailability releases resources without latching a healthy receiver.
    await native.update(newView, owner, { ...extent, visible: true })
    await wait(async () => {
      await native.demand(newView, owner)
      return !!native.targets.drawn(newView, win.webContents.mainFrame)
    }, 'refit-resume-drawn')
    const resumedGrant = currentGrant()
    if (
      !resumedGrant ||
      resumedGrant.geometrySerial <= beforeRejectedRefit.geometrySerial
    )
      throw new Error('native-lifecycle-refit-resume-old-geometry')
    native.targets.acknowledge(win.webContents.mainFrame, {
      kind: 'renderer-failure',
      grant: beforeRejectedRefit,
    })
    if (!native.targets.drawn(newView, win.webContents.mainFrame))
      throw new Error('native-lifecycle-stale-failure-poisoned-resume')

    // Context loss belongs to a separate disposable view so the original live
    // attachment can still exercise a physically pending native input afterward.
    await evaluate(
      `document.querySelector('button[aria-label="New terminal"]').click();return true;`,
    )
    await wait(
      () =>
        evaluate(
          `return [...document.querySelectorAll('.terminal-new-menu strong')].some(node=>node.textContent?.trim()==='Shell');`,
        ),
      'gpu-new-choice',
    )
    await evaluate(
      `const choice=[...document.querySelectorAll('.terminal-new-menu button')].find(node=>node.querySelector('strong')?.textContent?.trim()==='Shell');if(!(choice instanceof HTMLButtonElement))throw new Error('native-lifecycle-gpu-choice');choice.click();return true;`,
    )
    await wait(() => ptys.list().length === 2, 'gpu-new-pty')
    const gpuPty = ptys.list().find((value) => value.id !== managed.id)!
    const gpuHandle = native.sessions.get(gpuPty.id)?.handle
    await wait(
      () =>
        evaluate(
          `return !!document.querySelector('.terminal-surface.active .native-terminal-pane canvas');`,
        ),
      'gpu-new-canvas',
    )
    const contextLoss = await evaluate<boolean>(
      `const canvas=document.querySelector('.terminal-surface.active .native-terminal-pane canvas'),gl=canvas?.getContext('webgl2'),loss=gl?.getExtension('WEBGL_lose_context');if(!loss)return false;window.nativeLifecycleLostCanvas=canvas;loss.loseContext();return true;`,
    )
    if (contextLoss) {
      await wait(
        () =>
          evaluate(
            `return !window.nativeLifecycleLostCanvas.isConnected&&[...document.querySelectorAll('.native-terminal-pane [role="status"]')].some(value=>value.textContent?.includes('unavailable'));`,
          ),
        'context-loss-visible',
      )
      await ptys.writeConfirmed(
        gpuPty.id,
        owner.id,
        "printf '\\110\\126\\111\\122\\137\\114\\117\\123\\123\\137\\120\\101\\122\\123\\105\\122\\n'\r",
        owner.generation,
      )
      await wait(
        async () =>
          new TextDecoder()
            .decode(await native.readRetained(gpuPty.id, owner))
            .includes('HVIR_LOSS_PARSER'),
        'context-loss-parser-progress',
      )
      if (
        ptys.get(gpuPty.id)?.instanceId !== gpuPty.instanceId ||
        native.sessions.get(gpuPty.id)?.handle !== gpuHandle
      )
        throw new Error('native-lifecycle-context-loss-replaced-state')
      await evaluate(`delete window.nativeLifecycleLostCanvas;return true;`)
    }
    await evaluate(
      `document.querySelector('.terminal-list-row.active .terminal-close-button').click();return true;`,
    )
    await wait(
      () => ptys.list().length === 1 && !native.sessions.get(gpuPty.id),
      'gpu-close',
    )
    await wait(
      () =>
        evaluate(
          `return !!document.querySelector('.terminal-surface.active .native-terminal-pane canvas');`,
        ),
      'original-return',
    )

    // Electron's metrics serviceName is Chromium's service type on some hosts;
    // the fork option selects our child. Intersect that exact captured child and
    // ready epoch with the application's actual live Utility PID inventory.
    const capturedUtility = utilityObservation.current(
      app
        .getAppMetrics()
        .filter((metric) => metric.type === 'Utility')
        .map((metric) => metric.pid),
    )
    const utilityPid = capturedUtility.child.pid
    if (!utilityPid || utilityPid <= 0 || utilityPid === process.pid)
      throw new Error('native-lifecycle-ambiguous-utility')
    await native.input(newView, owner, { kind: 'focus', focused: true })
    const sent = observeNativeInputSend(capturedUtility.child, capturedUtility.epoch)
    let pendingRejected = false
    let pending: Promise<unknown> | undefined
    let killFailure: unknown
    try {
      process.kill(utilityPid, 'SIGSTOP')
      pending = native.input(newView, owner, {
        kind: 'paste',
        text: 'p'.repeat(33 * 1024 * 1024),
      })
      void pending.catch(() => undefined)
      await wait(() => !!sent.sent(), 'physical-native-input-sent')
      process.kill(utilityPid, 'SIGKILL')
      try {
        await pending
      } catch {
        pendingRejected = true
      }
      if (!pendingRejected)
        throw new Error('native-lifecycle-pending-input-completed-after-loss')
    } finally {
      sent.dispose()
      // A failed setup must not leave a stopped task-owned native utility behind.
      if (app.getAppMetrics().some((metric) => metric.pid === utilityPid)) {
        try {
          process.kill(utilityPid, 'SIGKILL')
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code !== 'ESRCH') killFailure = error
        }
      }
      if (pending) await Promise.allSettled([pending])
    }
    if (killFailure)
      throw killFailure instanceof Error
        ? killFailure
        : new Error('native-lifecycle-utility-kill-failed', { cause: killFailure })
    await wait(
      () => !app.getAppMetrics().some((metric) => metric.pid === utilityPid),
      'native-utility-exit',
    )
    let lostReadRejected = false
    try {
      await native.readRetained(managed.id, owner)
    } catch {
      lostReadRejected = true
    }
    if (
      !lostReadRejected ||
      ptys.get(managed.id)?.instanceId !== managed.instanceId ||
      ptys.get(managed.id)?.pid !== managed.pid
    )
      throw new Error('native-lifecycle-host-loss-silent-replacement')
    await ptys.writeConfirmed(
      managed.id,
      owner.id,
      "printf '\\110\\126\\111\\122\\137\\114\\117\\123\\124\\n'\r",
      owner.generation,
    )
    await wait(() => native.sessions.get(managed.id)?.unavailable === true, 'lost-state')
    await wait(
      () =>
        evaluate(
          `return [...document.querySelectorAll('.native-terminal-pane [role="status"]')].some(value=>value.textContent?.includes('unavailable'));`,
        ),
      'host-loss-visible',
    )
    await evaluate(
      `const close=document.querySelector('.terminal-close-button');if(!(close instanceof HTMLButtonElement))throw new Error('native-lifecycle-lost-close');close.click();return true;`,
    )
    await wait(
      () => ptys.list().length === 0 && !native.sessions.get(managed.id),
      'explicit-close',
    )
    await wait(
      () =>
        evaluate(
          `return document.querySelectorAll('.native-terminal-pane canvas').length===0;`,
        ),
      'closed-canvas',
    )
    return {
      additionalLaunches: 3,
      explicitRestart: true,
      readonlyInstanceRetired: true,
      splitClosed: true,
      documentReplacement: true,
      explicitRecoveryDecision: recoveryDecision,
      rejectedRefit: true,
      noReplacementGrantOnRefusal: true,
      mainUnavailableCanResume: true,
      staleFailureIgnored: true,
      oldOwnerRejected,
      samePtyOnDocumentReplacement: true,
      contextLoss: { eligible: contextLoss, parserPreserved: contextLoss },
      nativeHostLoss: true,
      pendingNativeInputLoss: {
        sent: !!sent.sent(),
        rejected: pendingRejected,
        observedEpoch: capturedUtility.epoch === sent.sent()?.epoch,
      },
      lostReadRejected,
      silentRelaunches: 0,
      explicitClose: true,
      final: {
        livePtys: ptys.list().length,
        nativeSessionPresent: !!native.sessions.get(managed.id),
        canvases: await evaluate<number>(
          `return document.querySelectorAll('.native-terminal-pane canvas').length;`,
        ),
      },
      realHostQualified: false,
      hardwareQualified: false,
    }
  } finally {
    if (targetDescriptor)
      Object.defineProperty(native.targets, 'create', targetDescriptor)
    else delete (native.targets as Partial<typeof native.targets>).create
  }
}
