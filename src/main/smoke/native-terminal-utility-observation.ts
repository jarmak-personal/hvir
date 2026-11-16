import { utilityProcess, type UtilityProcess } from 'electron'

/** Read-only immediate-adapter observation, confined to this disposable smoke.
 * Original performance/pixel cases never wrap the child's message sender. */
export function observeNativeTerminalUtilities() {
  const original = Reflect.get(utilityProcess, 'fork')
  const descriptor = Object.getOwnPropertyDescriptor(utilityProcess, 'fork')
  const captured: Array<{ child: UtilityProcess; epoch?: string; stop(): void }> = []
  const wrapped: typeof original = function (this: typeof utilityProcess, ...args) {
    const child: UtilityProcess = Reflect.apply(original, this, args)
    if (args[2]?.serviceName === 'hvir-native-terminal') {
      const entry = {
        child,
        epoch: undefined as string | undefined,
        stop: () => child.removeListener('message', ready),
      }
      const ready = (value: unknown) => {
        const message = value as
          { kind?: unknown; epoch?: unknown; pid?: unknown } | undefined
        if (
          message?.kind === 'ready' &&
          typeof message.epoch === 'string' &&
          message.pid === child.pid
        ) {
          entry.epoch = message.epoch
          entry.stop()
        }
      }
      child.on('message', ready)
      captured.push(entry)
    }
    return child
  }
  utilityProcess.fork = wrapped
  return {
    current(pids: readonly number[]) {
      const matches = captured.filter(
        (value) => typeof value.child.pid === 'number' && pids.includes(value.child.pid),
      )
      if (matches.length !== 1 || !matches[0]?.epoch)
        throw new Error('native-lifecycle-unobserved-utility')
      return matches[0] as { child: UtilityProcess; epoch: string; stop(): void }
    },
    dispose() {
      if (utilityProcess.fork === wrapped) {
        if (descriptor) Object.defineProperty(utilityProcess, 'fork', descriptor)
        else delete (utilityProcess as Partial<typeof utilityProcess>).fork
      }
      for (const entry of captured) entry.stop()
    },
  }
}

/** Observe one successfully sent physical input request, without copying/logging
 * its input body. Caller installs this only for the final destructive phase. */
export function observeNativeInputSend(child: UtilityProcess, epoch: string) {
  const original = Reflect.get(child, 'postMessage')
  const descriptor = Object.getOwnPropertyDescriptor(child, 'postMessage')
  let sent: { id: number; epoch: string } | undefined
  const wrapped: typeof original = function (this: UtilityProcess, ...args) {
    const result: ReturnType<typeof original> = Reflect.apply(original, this, args)
    const message = args[0] as
      | {
          kind?: unknown
          epoch?: unknown
          id?: unknown
          command?: { kind?: unknown; input?: { kind?: unknown } }
        }
      | undefined
    if (
      message?.kind === 'request' &&
      message.epoch === epoch &&
      Number.isSafeInteger(message.id) &&
      message.command?.kind === 'input' &&
      message.command.input?.kind === 'paste'
    )
      sent = { id: message.id as number, epoch }
    return result
  }
  child.postMessage = wrapped
  return {
    sent: () => sent,
    dispose() {
      if (child.postMessage === wrapped) {
        if (descriptor) Object.defineProperty(child, 'postMessage', descriptor)
        else delete (child as Partial<UtilityProcess>).postMessage
      }
    },
  }
}
