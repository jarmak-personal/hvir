import {
  validNativeTerminalAppearance,
  type NativeTerminalAppearance,
} from '../../shared/native-terminal-appearance'
import {
  NativeTerminalAdmissionError,
  type NativeTerminalCommand,
  type NativeTerminalStatus,
} from '../../shared/native-terminal'

interface AppearanceContext {
  readonly binding: { state: string; abort: AbortController; requestedAppearance: number }
  readonly port: {
    request(command: NativeTerminalCommand, signal?: AbortSignal): Promise<unknown>
  }
  readonly serial: number
  readonly appearance: NativeTerminalAppearance
  current(this: void): void
  inspect(this: void): Promise<NativeTerminalStatus>
}

/** Appearance acknowledgement is independent of feed freshness and geometry acknowledgement. */
export async function applyNativeTerminalAppearance({
  binding,
  port,
  serial,
  appearance,
  current,
  inspect,
}: AppearanceContext): Promise<NativeTerminalStatus> {
  if (!validNativeTerminalAppearance(appearance))
    throw new Error('native-appearance-invalid')
  if (!Number.isSafeInteger(serial) || serial <= binding.requestedAppearance)
    throw new Error('native-appearance-stale')
  binding.requestedAppearance = serial
  const deadline = Date.now() + 10000
  const command: NativeTerminalCommand = {
    kind: 'appearance',
    state: binding.state,
    serial,
    appearance: structuredClone(appearance),
  }
  for (;;) {
    current()
    if (binding.requestedAppearance !== serial)
      throw new Error('native-appearance-superseded')
    try {
      await port.request(command, binding.abort.signal)
      break
    } catch (error) {
      // This class guarantees the command never reached native. A normal native
      // failure may follow mutation and must never be replayed.
      if (!(error instanceof NativeTerminalAdmissionError) || Date.now() >= deadline)
        throw error
      await new Promise<void>((resolve) => setTimeout(resolve, 16))
    }
  }
  for (;;) {
    current()
    if (binding.requestedAppearance !== serial)
      throw new Error('native-appearance-superseded')
    let status: NativeTerminalStatus
    try {
      status = await inspect()
    } catch (error) {
      // The appearance command is already admitted. Retry only this unsent read.
      if (!(error instanceof NativeTerminalAdmissionError) || Date.now() >= deadline)
        throw error
      await new Promise<void>((resolve) => setTimeout(resolve, 16))
      continue
    }
    current()
    if (binding.requestedAppearance !== serial)
      throw new Error('native-appearance-superseded')
    if (status.appearanceFailureSerial === serial || status.failure)
      throw new Error('native-appearance-failed')
    if (status.appliedAppearanceSerial === serial) return status
    if (Date.now() >= deadline) throw new Error('native-appearance-timeout')
    await new Promise<void>((resolve) => setTimeout(resolve, 1))
  }
}
