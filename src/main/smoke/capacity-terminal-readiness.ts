import type { BrowserWindow } from 'electron'
import type { PtySupervisor } from '../pty/pty-supervisor'
import type { ManagedPty } from '../pty/pty-contract'
import {
  addCapacityTerminals,
  waitForCapacityTerminalCount,
  pauseCapacityTerminalReadiness as delay,
  withCapacityTerminalReadinessTimeout as withTimeout,
} from './capacity-terminals'

interface TerminalReadinessPhaseSample {
  readonly sample: number
  actionStartedAtMs?: number
  shellFoundAtMs?: number
  shellClickAtMs?: number
  domPidObservedAtMs?: number
  domPidLastUnsuccessfulPollAtMs?: number
  domPidSuccessfulPollAtMs?: number
  uiObservation?: 'matched' | 'missing' | 'ambiguous'
  launchObservation?: CapacityReadinessLaunchObservation
  addReturnedAtMs?: number
  supervisedAtMs?: number
  awaitingInputAtMs?: number
  focusInvocationStartedAtMs?: number
  rendererFocusEnteredAtMs?: number
  rendererAfterDomFocusAtMs?: number
  focusTargetPresent?: boolean
  focusCompletedAtMs?: number
  inputDispatchStartedAtMs?: number
  inputDispatchCompletedAtMs?: number
  sourceEchoAtMs?: number
  completedAtMs?: number
}

type ReadinessTerminal = Pick<
  ManagedPty,
  'id' | 'instanceId' | 'ownerId' | 'ownerGeneration' | 'startedAt'
>
type SpawnOwner = Pick<PtySupervisor, 'spawn' | 'observe'> & {
  list(): readonly ReadinessTerminal[]
}
type SpawnRequest = Parameters<SpawnOwner['spawn']>[0]
type Preparation = NonNullable<SpawnRequest['prepareTerminal']>
type Reservation = Parameters<Preparation>[0]
export interface CapacityReadinessLaunchObservation {
  readonly join: 'matched' | 'missing' | 'ambiguous'
  readonly truncated: boolean
  readonly spawnEnteredAtMs?: number
  readonly preparationEnteredAtMs?: number
  readonly preparation?: 'entered' | 'not-entered'
  readonly launchedAtMs?: number
  readonly registrationObservedAtMs?: number
  readonly registrationObservationFailed: boolean
}

/** One bounded smoke launch observation. Original promises are never chained. */
export function observeCapacityReadinessSpawn(supervisor: SpawnOwner) {
  const original = supervisor.spawn
  const descriptor = Object.getOwnPropertyDescriptor(supervisor, 'spawn')
  const rows: Array<{
    request: SpawnRequest
    spawnEnteredAtMs: number
    preparationEnteredAtMs?: number
    registrationObservedAtMs?: number
    reservation?: Pick<
      Reservation,
      'sessionId' | 'instanceId' | 'ownerId' | 'ownerGeneration'
    >
  }> = []
  let disposed = false,
    truncated = false,
    registrationObservationFailed = false
  const matches = (
    { request, reservation }: (typeof rows)[number],
    terminal: ReadinessTerminal,
  ) => {
    const identity = reservation ?? {
      sessionId: request.sessionId,
      ownerId: request.ownerId,
      ownerGeneration: request.ownerGeneration ?? 0,
    }
    return (
      identity.sessionId === terminal.id &&
      identity.ownerId === terminal.ownerId &&
      identity.ownerGeneration === terminal.ownerGeneration &&
      (!reservation || reservation.instanceId === terminal.instanceId)
    )
  }
  const wrapped: SpawnOwner['spawn'] = function (this: SpawnOwner, request) {
    const row =
      !disposed && rows.length < 10
        ? ({ request, spawnEnteredAtMs: Date.now() } as (typeof rows)[number])
        : undefined
    if (row) rows.push(row)
    else if (!disposed) truncated = true
    if (!row) return original.call(this, request)
    // The terminal IPC supplies a plain request with arrow callbacks.
    const prepare = request.prepareTerminal
    const observed: SpawnRequest = prepare
      ? {
          ...request,
          prepareTerminal: function (...args) {
            if (!disposed) {
              row.preparationEnteredAtMs = Date.now()
              const reservation = args[0]
              row.reservation = {
                sessionId: reservation.sessionId,
                instanceId: reservation.instanceId,
                ownerId: reservation.ownerId,
                ownerGeneration: reservation.ownerGeneration,
              }
            }
            return prepare.apply(request, args)
          },
        }
      : request
    return original.call(this, observed)
  }
  const stopRegistration = supervisor.observe(() => {
    if (disposed || !rows.length) return
    try {
      const observedAtMs = Date.now()
      const terminals = supervisor.list()
      for (const row of rows) {
        if (row.registrationObservedAtMs !== undefined) continue
        const found = terminals.filter(
          (terminal) =>
            matches(row, terminal) && terminal.startedAt >= row.spawnEnteredAtMs,
        )
        if (found.length === 1) row.registrationObservedAtMs = observedAtMs
      }
    } catch {
      registrationObservationFailed = true
    }
  })
  try {
    Object.defineProperty(
      supervisor,
      'spawn',
      descriptor && 'value' in descriptor
        ? { ...descriptor, value: wrapped }
        : {
            configurable: true,
            writable: true,
            enumerable: descriptor?.enumerable ?? false,
            value: wrapped,
          },
    )
  } catch (error) {
    void stopRegistration()
    throw error
  }
  return {
    read(terminal: ReadinessTerminal): CapacityReadinessLaunchObservation {
      const matching = rows.filter((row) => matches(row, terminal))
      const row = matching.length === 1 ? matching[0] : undefined
      return {
        join: !matching.length ? 'missing' : row ? 'matched' : 'ambiguous',
        truncated,
        registrationObservationFailed,
        launchedAtMs: terminal.startedAt,
        ...(row
          ? {
              spawnEnteredAtMs: row.spawnEnteredAtMs,
              preparationEnteredAtMs: row.preparationEnteredAtMs,
              registrationObservedAtMs: row.registrationObservedAtMs,
              preparation: row.reservation
                ? ('entered' as const)
                : ('not-entered' as const),
            }
          : {}),
      }
    },
    dispose() {
      if (disposed) return
      disposed = true
      rows.length = 0
      void stopRegistration()
      if (Object.getOwnPropertyDescriptor(supervisor, 'spawn')?.value !== wrapped) return
      if (descriptor) Object.defineProperty(supervisor, 'spawn', descriptor)
      else delete (supervisor as Partial<SpawnOwner>).spawn
    },
  }
}

export interface TerminalReadinessSampleReport {
  readonly phaseSamples?: readonly TerminalReadinessPhaseSample[]
  readonly durationsMs: readonly number[]
  readonly p95Ms: number
  readonly maxMs: number
  readonly inputResponse: {
    readonly durationsMs: readonly number[]
    readonly p50Ms: number
    readonly p95Ms: number
    readonly maxMs: number
  }
}

export async function measureAdditionalTerminalReadiness(
  win: BrowserWindow,
  supervisor: PtySupervisor,
  label: string,
  sampleCount: number,
): Promise<TerminalReadinessSampleReport> {
  const baseCount = supervisor.list().length
  const durationsMs: number[] = []
  const inputResponseDurationsMs: number[] = []
  const phaseSamples: TerminalReadinessPhaseSample[] = []

  for (let index = 0; index < sampleCount; index += 1) {
    const phases: TerminalReadinessPhaseSample = {
      sample: index + 1,
      uiObservation: 'missing',
      launchObservation: {
        join: 'missing',
        truncated: false,
        registrationObservationFailed: false,
      },
    }
    if (phaseSamples.length < 10) phaseSamples.push(phases)
    const launchObservation = observeCapacityReadinessSpawn(supervisor)
    try {
      const existingIds = new Set(supervisor.list().map((terminal) => terminal.id))
      const [actionStartedAtMs] = await addCapacityTerminals(
        win,
        baseCount + 1,
        (observations) => {
          phases.uiObservation =
            observations.length === 1
              ? 'matched'
              : observations.length
                ? 'ambiguous'
                : 'missing'
          if (observations.length === 1) Object.assign(phases, observations[0])
        },
      )
      phases.addReturnedAtMs = Date.now()
      phases.actionStartedAtMs = actionStartedAtMs
      if (actionStartedAtMs === undefined) {
        throw new Error(`${label} terminal ${index + 1} action time was not recorded`)
      }
      await waitFor(
        () => supervisor.list().length === baseCount + 1,
        `${label} terminal ${index + 1} was not supervised`,
      )
      const terminal = supervisor
        .list()
        .find((candidate) => !existingIds.has(candidate.id))
      if (!terminal)
        throw new Error(`${label} terminal ${index + 1} identity was not registered`)

      phases.supervisedAtMs = Date.now()
      phases.launchObservation = launchObservation.read(terminal)
      launchObservation.dispose()
      const input = `${label}${String.fromCharCode(97 + index)}`
      const awaitingInputMarker = `ready-awaiting-input:${input}`
      const marker = `ready-input:${input}`
      let output = ''
      let inputStartedAt: number | undefined
      let inputResponseMs: number | undefined
      const detach = supervisor.attach(terminal.id, terminal.ownerId, {
        onData: (data) => {
          output = (output + data).slice(-16_384)
          if (
            phases.awaitingInputAtMs === undefined &&
            output.includes(awaitingInputMarker)
          )
            phases.awaitingInputAtMs = Date.now()
          if (
            inputStartedAt !== undefined &&
            inputResponseMs === undefined &&
            output.includes(marker)
          ) {
            const observedAtMs = Date.now()
            phases.sourceEchoAtMs = observedAtMs
            inputResponseMs = observedAtMs - inputStartedAt
          }
        },
      })
      try {
        supervisor.write(
          terminal.id,
          terminal.ownerId,
          `stty -echo; printf '\\r\\nready-awaiting-input:%s\\r\\n' ${JSON.stringify(input)}; IFS= read -r hvir_input; stty echo; printf '\\r\\nready-input:%s\\r\\n' "$hvir_input"\n`,
        )
        await waitFor(
          () => output.includes(awaitingInputMarker),
          `${label} terminal ${index + 1} did not become input-ready: ${JSON.stringify(output)}`,
        )
        phases.focusInvocationStartedAtMs = Date.now()
        const focusObservation = (await win.webContents.executeJavaScript(`
        (() => {
          const rendererFocusEnteredAtMs = Date.now();
          const sessionId = ${JSON.stringify(terminal.id)};
          const surface = document.querySelector(
            '.terminal-surface[data-terminal-session="' + CSS.escape(sessionId) + '"]'
          );
          const input = surface?.querySelector('.native-terminal-pane textarea')
            ?? surface?.querySelector('.terminal-engine-host');
          input?.focus();
          return {rendererFocusEnteredAtMs,rendererAfterDomFocusAtMs:Date.now(),focusTargetPresent:!!input};
        })()
      `)) as {
          rendererFocusEnteredAtMs: number
          rendererAfterDomFocusAtMs: number
          focusTargetPresent: boolean
        }
        inputStartedAt = Date.now()
        phases.focusCompletedAtMs = inputStartedAt
        phases.inputDispatchStartedAtMs = inputStartedAt
        for (const keyCode of input.toUpperCase()) {
          win.webContents.sendInputEvent({ type: 'keyDown', keyCode })
          win.webContents.sendInputEvent({ type: 'keyUp', keyCode })
        }
        win.webContents.sendInputEvent({ type: 'keyDown', keyCode: 'Enter' })
        win.webContents.sendInputEvent({ type: 'keyUp', keyCode: 'Enter' })
        phases.inputDispatchCompletedAtMs = Date.now()
        Object.assign(phases, focusObservation)
        await waitFor(
          () => output.includes(marker),
          `${label} terminal ${index + 1} input was not echoed: ${JSON.stringify(output)}`,
        )
        const completedAtMs = Date.now()
        const durationMs = completedAtMs - actionStartedAtMs
        phases.completedAtMs = completedAtMs
        durationsMs.push(durationMs)
        if (inputResponseMs === undefined)
          throw new Error('capacity input response was not timed')
        inputResponseDurationsMs.push(inputResponseMs)
        await delay(250)
        if (countOccurrences(output, marker) !== 1) {
          throw new Error(
            `${label} terminal ${index + 1} input was duplicated: ${JSON.stringify(output)}`,
          )
        }
        console.log(
          `[smoke:performance:sample:readiness] ${label} ${index + 1}/${sampleCount} ` +
            `${durationMs.toFixed(1)}ms`,
        )
      } catch (error) {
        try {
          const windowFocused = win.isFocused()
          const state: unknown = await withTimeout(
            win.webContents.executeJavaScript(`(() => {
          const surface=document.querySelector('.terminal-surface[data-terminal-session="'+CSS.escape(${JSON.stringify(terminal.id)})+'"]');
          const pane=surface?.querySelector('.native-terminal-pane'),input=pane?.querySelector('textarea'),active=document.activeElement;
          const appearance=pane?.__hvirNativeTerminalAppearance;
          const notice=pane?.querySelector(':scope > [role="status"]')?.textContent??'';
          return {sessionPresent:!!surface,nativePanePresent:!!pane,documentFocused:document.hasFocus(),
            activeElement:!active?'none':['TEXTAREA','INPUT','BUTTON','BODY'].includes(active.tagName)?active.tagName.toLowerCase():'other',
            activeInSession:!!surface?.contains(active),activeIsInput:!!input&&active===input,
            inputPresent:input instanceof HTMLTextAreaElement,
            inputDisabled:input instanceof HTMLTextAreaElement?input.disabled:null,
            inputReadOnly:input instanceof HTMLTextAreaElement?input.readOnly:null,
            paneReadOnly:pane?.getAttribute('aria-readonly')==='true',
            appearancePresent:!!appearance,appliedInputReady:appearance?appearance.applied===true:null,
            surfaceUnavailable:pane?.querySelector('[id^="native-terminal-"] [role="status"]')?.textContent==='Terminal unavailable',
            refusal:notice==='Native terminal input capacity reached; retry the gesture'?'input-capacity':notice?'other-notice':'none'};
        })()`),
            'capacity input failure observation timed out',
            1000,
          )
          console.error(
            'HVIR_CAPACITY_READINESS_FAILURE ' +
              JSON.stringify({
                schema: 1,
                sessionId: terminal.id,
                sample: index + 1,
                inputLength: input.length,
                phases,
                windowFocused,
                state,
              }),
          )
        } catch {
          /* Observation failure must preserve the original error and cleanup. */
        }
        throw error
      } finally {
        void detach()
        await closeTerminal(win, terminal.id)
        await waitFor(
          () => supervisor.list().length === baseCount,
          `${label} terminal ${index + 1} did not leave the supervisor`,
        )
        await waitForCapacityTerminalCount(win, baseCount)
      }
    } finally {
      launchObservation.dispose()
      if (index < 10) {
        try {
          console.log('HVIR_CAPACITY_READINESS_PHASES ' + JSON.stringify(phases))
        } catch {
          /* Phase observation must preserve the original error and cleanup. */
        }
      }
    }
  }

  return {
    phaseSamples,
    durationsMs,
    p95Ms: percentile(durationsMs, 0.95),
    maxMs: Math.max(0, ...durationsMs),
    inputResponse: {
      durationsMs: inputResponseDurationsMs,
      p50Ms: percentile(inputResponseDurationsMs, 0.5),
      p95Ms: percentile(inputResponseDurationsMs, 0.95),
      maxMs: Math.max(0, ...inputResponseDurationsMs),
    },
  }
}

async function closeTerminal(win: BrowserWindow, sessionId: string): Promise<void> {
  await win.webContents.executeJavaScript(`
    (() => {
      const sessionId = ${JSON.stringify(sessionId)};
      const button = document.querySelector(
        '.terminal-list-main[data-terminal-session="' + CSS.escape(sessionId) + '"]'
      );
      button?.closest('.terminal-list-row')?.querySelector('.terminal-close-button')?.click();
    })()
  `)
}

async function waitFor(
  predicate: () => boolean,
  message: string,
  timeoutMs = 5_000,
): Promise<void> {
  const deadline = Date.now() + timeoutMs
  while (!predicate()) {
    if (Date.now() > deadline) throw new Error(message)
    await delay(25)
  }
}

function countOccurrences(value: string, target: string): number {
  return value.split(target).length - 1
}

function percentile(values: readonly number[], fraction: number): number {
  if (values.length === 0) return 0
  const sorted = [...values].sort((left, right) => left - right)
  return sorted[Math.min(sorted.length - 1, Math.ceil(sorted.length * fraction) - 1)]!
}
