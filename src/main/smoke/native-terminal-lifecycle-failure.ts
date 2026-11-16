import { app, type BrowserWindow } from 'electron'
import type { ManagedPty, PtySupervisor } from '../pty/pty-supervisor'
import type { NativeTerminalApplication } from '../terminal/native-terminal-application'
import type { RendererResourceScopes, RendererOwner } from '../renderer-resource-scopes'
import { verifyTerminalSplit } from './terminal-split'
import type {
  NativeTerminalViewGrant,
  NativeTerminalPresentationStatus,
} from '../../shared/native-terminal-presentation'
import { NativeTerminalAdmissionError } from '../../shared/native-terminal'
import { hostPathEquals } from '../../shared/host-path'
import {
  qualifyNativeReplacement,
  type NativeReplacementExpected,
  type NativeReplacementSnapshot,
} from './native-terminal-replacement-outcome'
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
  function actorReceipt(actor: ManagedPty) {
    return {
      id: actor.id,
      instanceId: actor.instanceId,
      pid: actor.pid,
      providerId: actor.providerId,
      profileId: actor.profileId ?? null,
      workspaceRoot: { ...actor.workspaceRoot },
    }
  }
  async function launchShell(stage: string): Promise<ManagedPty> {
    const before = new Set(ptys.list().map((actor) => actor.id))
    await evaluate(
      `const button=document.querySelector('button[aria-label="New terminal"]');if(!(button instanceof HTMLButtonElement)||button.disabled)throw new Error('native-lifecycle-shell-control');button.click();return true;`,
    )
    await wait(
      () =>
        evaluate(
          `return [...document.querySelectorAll('.terminal-new-menu strong')].some(node=>node.textContent?.trim()==='Shell');`,
        ),
      stage + '-choice',
    )
    await evaluate(
      `const choice=[...document.querySelectorAll('.terminal-new-menu button')].find(node=>node.querySelector('strong')?.textContent?.trim()==='Shell');if(!(choice instanceof HTMLButtonElement))throw new Error('native-lifecycle-shell-choice');choice.click();return true;`,
    )
    await wait(() => ptys.list().length === before.size + 1, stage + '-pty')
    const launched = ptys.list().filter((actor) => !before.has(actor.id))
    if (launched.length !== 1) throw new Error('native-lifecycle-shell-identity')
    return launched[0]!
  }
  async function parserProgress(
    actor: ManagedPty,
    owner: RendererOwner,
    marker: 'HVIR_LOSS_PARSER' | 'HVIR_QUARANTINE_PARSER',
    stage: string,
  ): Promise<void> {
    const octal = [...(marker + '\n')]
      .map((char) => '\\' + char.charCodeAt(0).toString(8).padStart(3, '0'))
      .join('')
    await ptys.writeConfirmed(actor.id, owner.id, `printf '${octal}'\r`, owner.generation)
    await wait(
      async () =>
        new TextDecoder()
          .decode(await native.readRetained(actor.id, owner))
          .includes(marker),
      stage,
    )
  }
  const oldState = native.sessions.get(seed.id)
  if (!oldState?.readonly || ptys.list().length !== 0)
    throw new Error('native-lifecycle-restart-not-readonly')
  await evaluate(
    `const restart=document.querySelector('.terminal-surface.active .terminal-restart');if(!(restart instanceof HTMLButtonElement)||restart.textContent?.trim()!=='Restart')throw new Error('native-lifecycle-restart-control');restart.click();return true;`,
  )
  await wait(() => ptys.list().length === 1, 'explicit-restart')
  let managed = ptys.list()[0]!
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
  let handle = native.sessions.get(managed.id)?.handle
  if (!handle) throw new Error('native-lifecycle-new-native-state')
  const replacementExpected: NativeReplacementExpected = {
    sessionId: managed.id,
    instanceId: managed.instanceId,
    pid: managed.pid,
    handle,
    ownerId: initialOwner.id,
    previousOwnerGeneration: initialOwner.generation,
    providerId: managed.providerId,
    profileId: managed.profileId ?? null,
    workspaceRoot: { ...managed.workspaceRoot },
  }
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
  const updateDescriptor = Object.getOwnPropertyDescriptor(native, 'update')
  const demandDescriptor = Object.getOwnPropertyDescriptor(native, 'demand')
  const createTarget = native.targets.create
  // Public method references are invoked solely through .apply with the caller's this.
  const update = Reflect.get<typeof native, 'update'>(native, 'update')
  const demand = Reflect.get<typeof native, 'demand'>(native, 'demand')
  const knownErrors = [
    'native-view-foreign',
    'native-session-foreign',
    'native-view-stale',
    'native-view-hidden',
    'native-state-foreign',
    'native-state-closed',
    'native-attachment-stale',
    'native-session-revoked',
    'native-producer-revoked',
    'native-host-lost',
    'native-host-closed',
    'native-command-bound',
    'native-admission-bound',
    'native-request-bound',
    'native-request-timeout',
    'native-operation-failed',
    'cancelled',
    'native-presentation-target-stale',
    'native-presentation-view-stale',
    'native-presentation-frame-stale',
    'native-presentation-grant-stale',
    'native-presentation-geometry-invalid',
    'native-presentation-serial-bound',
    'native-presentation-unavailable',
    'native-presentation-closed',
    'native-refit-revocation-failed',
    'native-geometry-stale',
    'native-geometry-failed',
    'native-geometry-superseded',
    'native-geometry-timeout',
    'native-scale-unacknowledged',
    'native-extent-invalid',
    'native-status-invalid',
    'native-visibility-invalid',
    'native-mode-invalid',
    'native-frame-bound',
    'native-frame-stale',
    'native-frame-invalid',
    'native-frame-state-unavailable',
    'native-pixel-bound',
    'native-pixel-receiver-rejected',
    'native-pixel-upload-bound',
    'native-pixel-upload-timeout',
    'native-pixel-upload-failed',
    'native-import-target-stale',
    'native-import-bound',
    'native-import-released',
    'native-import-presentation-invalid',
    'native-gpu-import-unavailable',
    'native-resource-kind',
    'native-resource-ticket',
    'native-resource-metadata',
    'native-resource-format',
    'native-resource-plane',
    'native-input-unavailable',
    'native-input-apply-timeout',
    'native-input-capacity-invalid',
    'native-view-unfocused',
    'native-focus-stale',
    'native-readonly-input-emitted',
    'pty-native-output-closed',
  ] as const
  type Observation = {
    operation: 'grant' | 'status' | 'update' | 'demand'
    state: 'started' | 'fulfilled' | 'rejected' | 'returned' | 'threw'
    viewId?: string
    ownerId?: number
    ownerGeneration?: number
    visible?: boolean
    result?: boolean
    error?: (typeof knownErrors)[number] | 'admission' | 'other'
    admission?: boolean
    target?: number
    frameCurrent?: boolean
    issued?: boolean
    refit?: boolean
    attachment?: number
    nativeEpoch?: string
    geometrySerial?: number
    mode?: NativeTerminalPresentationStatus['mode']
    reason?: NativeTerminalPresentationStatus['reason']
  }
  const observations: (Observation & { sequence: number })[] = []
  const demandSummary = { started: 0, fulfilled: 0, trueResults: 0, falseResults: 0 }
  let observationTotal = 0,
    truncated = false,
    observationReadFailed = false
  let observing = true,
    startedBeforeReload = false,
    targetCount = 0
  function observe(value: Observation): void {
    if (!observing) return
    try {
      observationTotal++
      // Routine frame polling cannot evict a causal failure or status transition.
      if (
        value.operation === 'demand' &&
        (value.state === 'started' || value.state === 'fulfilled')
      ) {
        if (value.state === 'started') demandSummary.started++
        else {
          demandSummary.fulfilled++
          if (value.result === true) demandSummary.trueResults++
          if (value.result === false) demandSummary.falseResults++
        }
        return
      }
      if (observations.length === 32) {
        observations.shift()
        truncated = true
      }
      observations.push({ ...value, sequence: observationTotal })
    } catch {
      observationReadFailed = true
    }
  }
  function observeMain(
    operation: 'update' | 'demand',
    state: Observation['state'],
    viewId: string,
    owner: Parameters<typeof demand>[1],
    layout?: { visible: boolean },
    result?: void | boolean,
    error?: unknown,
  ): void {
    try {
      observe({
        operation,
        state,
        viewId,
        ownerId: owner.id,
        ownerGeneration: owner.generation,
        visible: layout?.visible,
        ...(typeof result === 'boolean' ? { result } : {}),
        ...(state === 'rejected'
          ? {
              error:
                knownErrors.find(
                  (code) => error instanceof Error && error.message === code,
                ) ??
                (error instanceof NativeTerminalAdmissionError ? 'admission' : 'other'),
              admission: error instanceof NativeTerminalAdmissionError,
            }
          : {}),
      })
    } catch {
      observationReadFailed = true
    }
  }
  function observeCompletion(
    result: Promise<void | boolean>,
    operation: 'update' | 'demand',
    viewId: string,
    owner: Parameters<typeof demand>[1],
    layout?: { visible: boolean },
  ): void {
    try {
      const capturedOwner = { id: owner.id, generation: owner.generation }
      const capturedLayout = layout && { visible: layout.visible }
      // Side branches consume their own outcome; callers receive the original Promise.
      void result.then(
        (value) =>
          observeMain(
            operation,
            'fulfilled',
            viewId,
            capturedOwner,
            capturedLayout,
            value,
          ),
        (error) =>
          observeMain(
            operation,
            'rejected',
            viewId,
            capturedOwner,
            capturedLayout,
            undefined,
            error,
          ),
      )
    } catch {
      observationReadFailed = true
    }
  }
  let rejectRefit = false
  let granted: NativeTerminalViewGrant | undefined
  let grantedScope:
    { target: number; frame: Parameters<typeof createTarget>[0] } | undefined
  const currentGrant = (): NativeTerminalViewGrant | undefined => granted
  let replacementGrants = 0
  try {
    native.targets.create = function (...args) {
      const target = createTarget.apply(this, args)
      const ordinal = ++targetCount
      let targetViewId: string | undefined
      return {
        ...target,
        get ready() {
          return target.ready
        },
        publishGrant(grant, refit) {
          let state: 'returned' | 'threw' = 'threw'
          try {
            const result = target.publishGrant.call(this, grant, refit)
            state = 'returned'
            if (grant) {
              targetViewId = grant.viewId
              granted = grant
              grantedScope = { target: ordinal, frame: args[0] }
              replacementGrants++
            } else if (granted?.viewId === targetViewId) {
              granted = undefined
              grantedScope = undefined
            }
            if (!grant && refit && rejectRefit) {
              rejectRefit = false
              throw new Error('native-lifecycle-injected-refit-refusal')
            }
            return result
          } finally {
            try {
              if (grant) targetViewId = grant.viewId
              observe({
                operation: 'grant',
                state,
                viewId: targetViewId,
                target: ordinal,
                frameCurrent: args[0] === win.webContents.mainFrame,
                issued: !!grant,
                refit: !!refit,
                attachment: grant?.attachment ?? refit?.attachment,
                nativeEpoch: grant?.nativeEpoch ?? refit?.nativeEpoch,
                geometrySerial: grant?.geometrySerial,
              })
            } catch {
              observationReadFailed = true
            }
          }
        },
        publishStatus(status) {
          let state: 'returned' | 'threw' = 'threw'
          try {
            const result = target.publishStatus.call(this, status)
            state = 'returned'
            return result
          } finally {
            try {
              targetViewId = status.viewId
              observe({
                operation: 'status',
                state,
                viewId: status.viewId,
                target: ordinal,
                frameCurrent: args[0] === win.webContents.mainFrame,
                mode: status.mode,
                reason: status.reason,
              })
            } catch {
              observationReadFailed = true
            }
          }
        },
      }
    }
    native.update = function (...args) {
      observeMain('update', 'started', args[0], args[1], args[2])
      try {
        const result = update.apply(this, args)
        observeCompletion(result, 'update', args[0], args[1], args[2])
        return result
      } catch (error) {
        observeMain('update', 'rejected', args[0], args[1], args[2], undefined, error)
        throw error
      }
    }
    native.demand = function (...args) {
      observeMain('demand', 'started', args[0], args[1])
      try {
        const result = demand.apply(this, args)
        observeCompletion(result, 'demand', args[0], args[1])
        return result
      } catch (error) {
        observeMain('demand', 'rejected', args[0], args[1], undefined, undefined, error)
        throw error
      }
    }
    startedBeforeReload = true
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
    const replacementResult: {
      observed?: NativeReplacementSnapshot
      outcome?: 'drawn' | 'quarantined'
    } = {}
    try {
      await wait(async () => {
        const current = resources.currentOwner(initialOwner.id)
        if (
          current.generation <= initialOwner.generation ||
          !resources.isCurrent(current)
        )
          return false
        const frame = win.webContents.mainFrame
        const dom = await evaluate<NonNullable<NativeReplacementSnapshot['dom']>>(
          `const panes=[...document.querySelectorAll('.native-terminal-pane')];const canvases=document.querySelectorAll('.native-terminal-pane canvas');const dialog=document.querySelector('.terminal-recovery-dialog');const restore=dialog&&[...dialog.querySelectorAll('button')].find(node=>node.textContent?.trim()==='Restore selected');return {hasCanvas:canvases.length>0,canvasCount:Math.min(canvases.length,8),panes:panes.slice(0,8).map(pane=>{const surface=pane.querySelector('[id^="native-terminal-"]');const input=pane.querySelector('textarea');return {viewId:surface?.id.slice(0,100)??null,sessionId:pane.closest('[data-terminal-session]')?.getAttribute('data-terminal-session')?.slice(0,100)??null,connected:pane.isConnected,canvasPresent:!!surface?.querySelector('canvas'),paneUnavailable:pane.textContent?.includes('Native terminal unavailable')??false,surfaceUnavailable:surface?.querySelector('[role="status"]')?.textContent==='Terminal unavailable',inputDisabled:input instanceof HTMLTextAreaElement?input.disabled:null};}),dialogPresent:!!dialog,restorePresent:restore instanceof HTMLButtonElement,restoreDisabled:restore instanceof HTMLButtonElement?restore.disabled:null};`,
        )
        if (!resources.isCurrent(current) || frame !== win.webContents.mainFrame)
          return false
        const pane = dom.panes?.find(
          (pane) =>
            pane.sessionId === managed.id && pane.viewId?.startsWith('native-terminal-'),
        )
        const viewId = pane?.viewId?.slice('native-terminal-'.length)
        const drawn = viewId && native.targets.drawn(viewId, frame)
        const retained = ptys.get(managed.id)
        const state = native.sessions.get(managed.id)
        const replacementObservation: NativeReplacementSnapshot = {
          recoveryDecision,
          owner: { ...current },
          retained: retained && {
            id: retained.id,
            instanceId: retained.instanceId,
            pid: retained.pid,
            providerId: retained.providerId,
            profileId: retained.profileId ?? null,
            workspaceRoot: { ...retained.workspaceRoot },
            ownerId: retained.ownerId,
            ownerGeneration: retained.ownerGeneration,
          },
          native: state && {
            handle: state.handle,
            instanceId: state.session.instanceId,
            ownerId: state.session.ownerId,
            ownerGeneration: state.session.ownerGeneration,
            workspaceRoot: { ...state.session.workspaceRoot },
            retiring: state.retiring,
            unavailable: state.unavailable,
            inputUnavailable: state.inputUnavailable,
            inputClosed: state.inputClosed,
            readonly: state.readonly,
          },
          presentation: {
            viewId: viewId ?? null,
            issuedGrant:
              granted && granted.viewId === viewId && grantedScope
                ? {
                    viewId: granted.viewId,
                    target: grantedScope.target,
                    frameCurrent: grantedScope.frame === frame,
                    attachment: granted.attachment,
                    nativeEpoch: granted.nativeEpoch,
                    geometrySerial: granted.geometrySerial,
                  }
                : undefined,
            drawn: drawn
              ? { screen: drawn.screen, geometrySerial: drawn.geometrySerial }
              : null,
            observations: {
              startedBeforeReload,
              total: observationTotal,
              demandSummary: { ...demandSummary, scope: 'all-observed' },
              truncated,
              readFailed: observationReadFailed,
              currentView: observations.filter(
                (event) =>
                  event.viewId === viewId &&
                  event.frameCurrent !== false &&
                  (event.ownerId === undefined ||
                    (event.ownerId === current.id &&
                      event.ownerGeneration === current.generation)),
              ),
              mainSendIsNotReceiverDelivery: true,
              unboundRetained: observations.filter((event) => event.viewId === undefined)
                .length,
              otherViewRetained: observations.filter(
                (event) => event.viewId !== undefined && event.viewId !== viewId,
              ).length,
            },
          },
          dom,
        }
        replacementResult.observed = replacementObservation
        replacementResult.outcome = qualifyNativeReplacement(
          replacementExpected,
          replacementObservation,
        )
        return replacementResult.outcome !== undefined
      }, 'replacement-document')
    } catch (error) {
      console.error(
        'HVIR_NATIVE_REPLACEMENT_FAILURE',
        JSON.stringify(replacementResult.observed),
      )
      throw error
    }
    const { observed: replacementObserved, outcome: replacementOutcome } =
      replacementResult
    if (!replacementObserved || !replacementOutcome)
      throw new Error('native-lifecycle-replacement-unqualified')
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

    let newView = replacementObserved.presentation?.viewId
    if (!newView) throw new Error('native-lifecycle-replacement-view')
    let explicitRecovery: {
      uiClose: true
      uiNew: true
      newActors: 1
      original: ReturnType<typeof actorReceipt>
      actor: ReturnType<typeof actorReceipt>
      rootMatched: true
      providerOwned: true
    } | null = null
    if (replacementOutcome === 'quarantined') {
      await parserProgress(
        managed,
        owner,
        'HVIR_QUARANTINE_PARSER',
        'quarantine-parser-progress',
      )
      let inputRevoked = false
      try {
        await native.key(newView, owner, { key: 0, modifiers: 0, action: 1, text: 'x' })
      } catch (error) {
        if (error instanceof Error && error.message === 'native-presentation-unavailable')
          inputRevoked = true
        else throw error
      }
      if (
        !inputRevoked ||
        (await native.demand(newView, owner)) !== false ||
        native.targets.drawn(newView, win.webContents.mainFrame)
      )
        throw new Error('native-lifecycle-quarantine-authority')
      const original = actorReceipt(managed)
      await evaluate(
        `const close=document.querySelector('.terminal-list-row.active .terminal-close-button');if(!(close instanceof HTMLButtonElement))throw new Error('native-lifecycle-quarantine-close');close.click();return true;`,
      )
      await wait(
        () => ptys.list().length === 0 && !native.sessions.get(original.id),
        'quarantine-explicit-close',
      )
      await wait(
        () =>
          evaluate(
            `return document.querySelectorAll('.native-terminal-pane canvas').length===0;`,
          ),
        'quarantine-close-canvas',
      )
      // The old immutable GPU references remain quarantined; explicit New shell
      // uses the existing provider route and receives a different native state.
      managed = await launchShell('quarantine-recovery')
      const actor = actorReceipt(managed)
      if (
        actor.id === original.id ||
        actor.instanceId === original.instanceId ||
        actor.pid === original.pid ||
        actor.providerId !== original.providerId ||
        actor.profileId !== original.profileId ||
        !hostPathEquals(actor.workspaceRoot, original.workspaceRoot)
      )
        throw new Error('native-lifecycle-quarantine-recovery-identity')
      handle = native.sessions.get(managed.id)?.handle
      if (!handle || handle === replacementExpected.handle)
        throw new Error('native-lifecycle-quarantine-recovery-state')
      const recoveryView: { id?: string } = {}
      await wait(async () => {
        const id = await evaluate<string | null>(
          `const pane=document.querySelector('.terminal-surface.active .native-terminal-pane');if(pane?.closest('[data-terminal-session]')?.getAttribute('data-terminal-session')!==${JSON.stringify(managed.id)})return null;return pane.querySelector('[id^="native-terminal-"]')?.id.slice('native-terminal-'.length)??null;`,
        )
        const drawn = id && native.targets.drawn(id, win.webContents.mainFrame)
        const grant = currentGrant()
        if (
          !id ||
          !drawn ||
          grant?.viewId !== id ||
          drawn.geometrySerial !== grant.geometrySerial
        )
          return false
        recoveryView.id = id
        return true
      }, 'quarantine-recovery-drawn')
      if (!recoveryView.id) throw new Error('native-lifecycle-quarantine-recovery-view')
      newView = recoveryView.id
      explicitRecovery = {
        uiClose: true,
        uiNew: true,
        newActors: 1,
        original,
        actor,
        rootMatched: true,
        providerOwned: true,
      }
    }
    const replacement = {
      outcome: replacementOutcome,
      expected: replacementExpected,
      observed: replacementObserved,
      parserProgress: replacementOutcome === 'quarantined' ? true : null,
      presentationRevoked: replacementOutcome === 'quarantined' ? true : null,
      inputRevoked: replacementOutcome === 'quarantined' ? true : null,
      unknownPhysicalReferencesRetained:
        replacementOutcome === 'quarantined' ? true : null,
      preShutdownReclamationQualified: false,
      explicitRecovery,
    }
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
    const gpuPty = await launchShell('gpu-new')
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
      await parserProgress(
        gpuPty,
        owner,
        'HVIR_LOSS_PARSER',
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
      additionalLaunches: replacementOutcome === 'quarantined' ? 4 : 3,
      replacement,
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
    observing = false
    try {
      if (targetDescriptor)
        Object.defineProperty(native.targets, 'create', targetDescriptor)
      else delete (native.targets as Partial<typeof native.targets>).create
    } finally {
      try {
        if (updateDescriptor) Object.defineProperty(native, 'update', updateDescriptor)
        else delete (native as Partial<typeof native>).update
      } finally {
        if (demandDescriptor) Object.defineProperty(native, 'demand', demandDescriptor)
        else delete (native as Partial<typeof native>).demand
      }
    }
    try {
      console.log(
        'HVIR_NATIVE_REPLACEMENT_OBSERVERS_RESTORED',
        JSON.stringify({
          create:
            native.targets.create === createTarget &&
            Object.hasOwn(native.targets, 'create') === !!targetDescriptor,
          update:
            native.update === update &&
            Object.hasOwn(native, 'update') === !!updateDescriptor,
          demand:
            native.demand === demand &&
            Object.hasOwn(native, 'demand') === !!demandDescriptor,
        }),
      )
    } catch {
      // A diagnostic receipt cannot replace the original qualification outcome.
    }
  }
}
