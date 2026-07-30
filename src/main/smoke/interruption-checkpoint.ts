import { isSmokeInterruptionUuid } from './interruption-identity.mts'

const CHECKPOINT_VARIABLE = 'HVIR_SMOKE_ISOLATION_CHECKPOINT'
const ACTION_VARIABLE = 'HVIR_SMOKE_ISOLATION_ACTION'
const RUN_TOKEN_VARIABLE = 'HVIR_SMOKE_ISOLATION_RUN'
const PREDECESSOR_TOKEN_VARIABLE = 'HVIR_SMOKE_ISOLATION_PREDECESSOR'
const PREDECESSOR_PANE_VARIABLE = 'HVIR_SMOKE_ISOLATION_PREDECESSOR_PANE'
const SUPPORTED_SIGNALS = ['SIGHUP', 'SIGINT', 'SIGTERM'] as const

export const SMOKE_INTERRUPTION_CHECKPOINTS = [
  'profile-pty-ready',
  'renderer-watch-ready',
  'web-route-ready',
] as const

export type SmokeInterruptionCheckpointName =
  (typeof SMOKE_INTERRUPTION_CHECKPOINTS)[number]

export type SmokeInterruptionCheckpointEvidence =
  | {
      readonly name: 'profile-pty-ready'
      readonly profileCount: number
      readonly ptyCount: number
      readonly predecessorProfileObserved: boolean
    }
  | {
      readonly name: 'renderer-watch-ready'
      readonly ownerGeneration: number
      readonly watcherActive: boolean
      readonly predecessorSelectionObserved: boolean
    }
  | {
      readonly name: 'web-route-ready'
      readonly ownerGeneration: number
      readonly ptyCount: number
      readonly routeOpen: boolean
      readonly paneId: string
      readonly loopbackPort: number
      readonly predecessorRouteObserved: boolean
      readonly predecessorSelectionObserved: boolean
    }

type SmokeInterruptionAction = 'observe' | 'fail' | 'pause'
type SupportedSignal = (typeof SUPPORTED_SIGNALS)[number]

interface SmokeInterruptionConfiguration {
  readonly checkpoint: SmokeInterruptionCheckpointName
  readonly action: SmokeInterruptionAction
  readonly runToken: string
  readonly predecessorToken?: string
  readonly predecessorPaneId?: string
}

/**
 * A narrow observation point over production-composed smoke owners.
 * It never creates resources or substitutes authority for the scenario.
 */
export class SmokeInterruptionCheckpoint {
  private reached = false
  private interruptedSignal: SupportedSignal | undefined
  private rejectPause: ((error: Error) => void) | undefined
  private readonly signalHandlers = new Map<SupportedSignal, () => void>()

  private constructor(
    private readonly configuration: SmokeInterruptionConfiguration | undefined,
    private readonly output: (line: string) => void,
  ) {
    if (configuration?.action !== 'pause') return
    for (const signal of SUPPORTED_SIGNALS) {
      const handler = (): void => this.interrupt(signal)
      this.signalHandlers.set(signal, handler)
      process.on(signal, handler)
    }
  }

  static fromEnvironment(
    environment: NodeJS.ProcessEnv = process.env,
    output: (line: string) => void = console.log,
  ): SmokeInterruptionCheckpoint {
    return new SmokeInterruptionCheckpoint(parseConfiguration(environment), output)
  }

  get active(): boolean {
    return this.configuration !== undefined
  }

  get runToken(): string | undefined {
    return this.configuration?.runToken
  }

  get predecessorToken(): string | undefined {
    return this.configuration?.predecessorToken
  }

  get predecessorPaneId(): string | undefined {
    return this.configuration?.predecessorPaneId
  }

  async reach(evidence: SmokeInterruptionCheckpointEvidence): Promise<void> {
    const configuration = this.configuration
    if (!configuration || configuration.checkpoint !== evidence.name) return
    if (this.reached)
      throw new Error(`Smoke checkpoint ${evidence.name} was reached twice`)
    this.reached = true
    this.output(
      `[smoke:isolation:checkpoint] ${JSON.stringify({
        schema: 1,
        runToken: configuration.runToken,
        ...evidence,
      })}`,
    )
    if (configuration.action === 'observe') return
    if (configuration.action === 'fail') {
      throw new Error(`Controlled smoke failure at checkpoint ${evidence.name}`)
    }
    if (this.interruptedSignal) throw interruptedError(this.interruptedSignal)
    await new Promise<never>((_resolve, reject) => {
      this.rejectPause = reject
    })
  }

  disposed(resource: string): void {
    const runToken = this.configuration?.runToken
    if (!runToken) return
    this.output(
      `[smoke:isolation:disposed] ${JSON.stringify({
        schema: 1,
        runToken,
        resource: resource.slice(0, 80),
      })}`,
    )
  }

  dispose(): void {
    for (const [signal, handler] of this.signalHandlers) {
      process.off(signal, handler)
    }
    this.signalHandlers.clear()
    this.rejectPause = undefined
  }

  private interrupt(signal: SupportedSignal): void {
    if (this.interruptedSignal) return
    this.interruptedSignal = signal
    const runToken = this.configuration?.runToken
    if (runToken) {
      this.output(
        `[smoke:isolation:interrupted] ${JSON.stringify({
          schema: 1,
          runToken,
          signal,
        })}`,
      )
    }
    this.rejectPause?.(interruptedError(signal))
  }
}

function parseConfiguration(
  environment: NodeJS.ProcessEnv,
): SmokeInterruptionConfiguration | undefined {
  const checkpoint = environment[CHECKPOINT_VARIABLE]
  const action = environment[ACTION_VARIABLE]
  const runToken = environment[RUN_TOKEN_VARIABLE]
  const predecessorToken = environment[PREDECESSOR_TOKEN_VARIABLE]
  const predecessorPaneId = environment[PREDECESSOR_PANE_VARIABLE]
  if (
    checkpoint === undefined &&
    action === undefined &&
    runToken === undefined &&
    predecessorToken === undefined &&
    predecessorPaneId === undefined
  ) {
    return undefined
  }
  if (!(SMOKE_INTERRUPTION_CHECKPOINTS as readonly string[]).includes(checkpoint ?? '')) {
    throw new Error(
      `${CHECKPOINT_VARIABLE} must be one of ${SMOKE_INTERRUPTION_CHECKPOINTS.join(', ')}`,
    )
  }
  if (action !== 'observe' && action !== 'fail' && action !== 'pause') {
    throw new Error(`${ACTION_VARIABLE} must be observe, fail, or pause`)
  }
  if (!isSmokeInterruptionUuid(runToken)) {
    throw new Error(`${RUN_TOKEN_VARIABLE} must be a UUID`)
  }
  if (
    predecessorToken !== undefined &&
    !isSmokeInterruptionUuid(predecessorToken)
  ) {
    throw new Error(`${PREDECESSOR_TOKEN_VARIABLE} must be a UUID`)
  }
  if (
    predecessorPaneId !== undefined &&
    !isSmokeInterruptionUuid(predecessorPaneId)
  ) {
    throw new Error(`${PREDECESSOR_PANE_VARIABLE} must be a UUID`)
  }
  return {
    checkpoint: checkpoint as SmokeInterruptionCheckpointName,
    action,
    runToken,
    ...(predecessorToken === undefined ? {} : { predecessorToken }),
    ...(predecessorPaneId === undefined ? {} : { predecessorPaneId }),
  }
}

function interruptedError(signal: SupportedSignal): Error {
  return new Error(`Smoke interrupted by ${signal}`)
}
