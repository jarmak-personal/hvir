import type { Disposer } from '../../shared'
import type { PtyStreamHandlers } from '../pty/pty-supervisor'

const CAPACITY_TERMINAL_COUNT = 12
const SHUTDOWN_TIMEOUT_MS = 10_000
const STOP_MARKER_PREFIX = '__HVIR_CAPACITY_OUTPUT_STOPPED_'

interface CapacityOutputTerminal {
  readonly id: string
  readonly ownerId: number
  readonly ownerGeneration: number
}

export interface CapacityOutputFixtureSupervisor {
  list(): readonly CapacityOutputTerminal[]
  attach(
    id: string,
    ownerId: number,
    handlers: PtyStreamHandlers,
    ownerGeneration?: number,
  ): Disposer
  write(id: string, ownerId: number, data: string, ownerGeneration?: number): void
}

export interface CapacityOutputFixtures {
  /** Stop every owned producer and await its terminal shutdown acknowledgement. */
  stop(): Promise<void>
}

/** Start the real-PTY output load and retain ownership of its bounded shutdown lifecycle. */
export function startCapacityOutputFixtures(
  supervisor: CapacityOutputFixtureSupervisor,
): CapacityOutputFixtures {
  const terminals = supervisor.list()
  if (terminals.length !== CAPACITY_TERMINAL_COUNT) {
    throw new Error(
      `capacity fixtures expected ${CAPACITY_TERMINAL_COUNT} terminals, found ${terminals.length}`,
    )
  }

  const semanticFixture =
    `i=0; while [ "$i" -lt 300 ]; do ` +
    `printf '\\033]133;A\\007p\\r\\n\\033]133;B\\007c\\r\\n` +
    `\\033]133;C\\007o\\r\\n\\033]133;D;0\\007'; ` +
    `i=$((i+1)); done\n`
  for (const terminal of terminals) {
    supervisor.write(
      terminal.id,
      terminal.ownerId,
      semanticFixture,
      terminal.ownerGeneration,
    )
  }

  const cycles = [
    `printf 'plain-visible-%06d abcdefghijklmnopqrstuvwxyz\\r\\n' "$i"; i=$((i+1)); sleep 0.01`,
    `printf 'plain-hidden-%06d abcdefghijklmnopqrstuvwxyz\\r\\n' "$i"; i=$((i+1)); sleep 0.01`,
    `printf '\\r\\033[2K\\033[36mThinking %04d…\\033[0m' "$i"; i=$((i+1)); sleep 0.01`,
    ...Array.from(
      { length: 9 },
      () =>
        `printf '\\033[?2026h\\033[33msync-%04d\\033[0m\\r\\nline-a\\r\\nline-b' "$i"; i=$((i+1)); sleep 0.2`,
    ),
  ]
  const producers = terminals.map((terminal, index) => ({
    terminal,
    marker: `${STOP_MARKER_PREFIX}${String(index).padStart(2, '0')}__`,
  }))
  producers.forEach(({ terminal, marker }, index) => {
    const script =
      `hvir_capacity_running=1; ` +
      `trap 'hvir_capacity_running=0' INT; ` +
      `i=0; while [ "$hvir_capacity_running" -eq 1 ]; do ${cycles[index]!}; done; ` +
      `trap - INT; printf '\\r\\n${marker}\\r\\n'`
    supervisor.write(
      terminal.id,
      terminal.ownerId,
      `sh -c ${shellQuote(script)}\n`,
      terminal.ownerGeneration,
    )
  })

  return new CapacityOutputFixtureLifecycle(supervisor, producers)
}

class CapacityOutputFixtureLifecycle implements CapacityOutputFixtures {
  private stopPromise: Promise<void> | undefined

  constructor(
    private readonly supervisor: CapacityOutputFixtureSupervisor,
    private readonly producers: readonly {
      readonly terminal: CapacityOutputTerminal
      readonly marker: string
    }[],
  ) {}

  stop(): Promise<void> {
    this.stopPromise ??= this.stopOnce()
    return this.stopPromise
  }

  private async stopOnce(): Promise<void> {
    const observations = this.producers.map(
      ({ marker }) => new CapacityShutdownObservation(marker),
    )
    const disposers: Disposer[] = []
    let acknowledged = 0
    let exited = 0
    let settled = false
    let resolveShutdown: () => void = () => undefined
    let rejectShutdown: (reason: Error) => void = () => undefined
    const shutdown = new Promise<void>((resolve, reject) => {
      resolveShutdown = resolve
      rejectShutdown = reject
    })
    let interrupts = 0
    let primaryFailure: Error | undefined

    try {
      for (const [index, producer] of this.producers.entries()) {
        const observation = observations[index]!
        disposers.push(
          this.supervisor.attach(
            producer.terminal.id,
            producer.terminal.ownerId,
            {
              onData: (data) => {
                if (!observation.consume(data)) return
                acknowledged++
                if (acknowledged === this.producers.length && !settled) {
                  settled = true
                  resolveShutdown()
                }
              },
              onExit: () => {
                if (observation.exited || observation.acknowledged) return
                observation.exited = true
                exited++
                if (!settled) {
                  settled = true
                  rejectShutdown(
                    new Error(
                      `capacity output producer exited before shutdown acknowledgement ` +
                        this.status(observations, acknowledged, exited, interrupts),
                    ),
                  )
                }
              },
            },
            producer.terminal.ownerGeneration,
          ),
        )
      }

      for (const { terminal } of this.producers) {
        this.supervisor.write(
          terminal.id,
          terminal.ownerId,
          '\u0003',
          terminal.ownerGeneration,
        )
        interrupts++
      }

      await withShutdownTimeout(
        shutdown,
        () =>
          `capacity output producers did not acknowledge shutdown ` +
          this.status(observations, acknowledged, exited, interrupts),
      )
    } catch (reason) {
      primaryFailure =
        reason instanceof Error
          ? reason
          : new Error(
              `capacity output shutdown failed ` +
                this.status(observations, acknowledged, exited, interrupts),
            )
    }

    let cleanupFailures = 0
    for (const dispose of disposers.reverse()) {
      try {
        await dispose()
      } catch {
        cleanupFailures++
      }
    }

    if (primaryFailure) {
      if (cleanupFailures === 0) throw primaryFailure
      throw new Error(`${primaryFailure.message}; cleanupFailures=${cleanupFailures}`)
    }
    if (cleanupFailures > 0) {
      throw new Error(
        `capacity output shutdown subscription cleanup failed ` +
          `(cleanupFailures=${cleanupFailures}, subscriptions=${disposers.length})`,
      )
    }
  }

  private status(
    observations: readonly CapacityShutdownObservation[],
    acknowledged: number,
    exited: number,
    interrupts: number,
  ): string {
    return (
      `(acknowledged=${acknowledged}/${this.producers.length}, ` +
      `dataCallbacks=${observations.filter((observation) => observation.sawData).length}, ` +
      `exited=${exited}, interrupts=${interrupts}/${this.producers.length})`
    )
  }
}

class CapacityShutdownObservation {
  private tail = ''
  acknowledged = false
  exited = false
  sawData = false

  constructor(private readonly marker: string) {}

  consume(data: string): boolean {
    if (this.acknowledged) return false
    this.sawData = true
    const candidate = this.tail + data
    if (candidate.includes(this.marker)) {
      this.acknowledged = true
      this.tail = ''
      return true
    }
    this.tail = candidate.slice(-(this.marker.length - 1))
    return false
  }
}

async function withShutdownTimeout(
  shutdown: Promise<void>,
  timeoutMessage: () => string,
): Promise<void> {
  let timeout: ReturnType<typeof setTimeout> | undefined
  try {
    await Promise.race([
      shutdown,
      new Promise<never>((_resolve, reject) => {
        timeout = setTimeout(
          () => reject(new Error(timeoutMessage())),
          SHUTDOWN_TIMEOUT_MS,
        )
      }),
    ])
  } finally {
    if (timeout) clearTimeout(timeout)
  }
}

function shellQuote(value: string): string {
  return `'${value.replaceAll("'", `'"'"'`)}'`
}
