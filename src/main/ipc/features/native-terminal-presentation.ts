import type { NativeTerminalPresentationTargets } from '../../terminal/native-terminal-presentation-target'
import type { IpcRegistrar } from '../authority-router'

export function registerNativeTerminalPresentationIpc(
  ipc: IpcRegistrar,
  targets?: Pick<NativeTerminalPresentationTargets, 'acknowledge'>,
): void {
  ipc.handleSend('native-terminal:presentation-ack', (payload, context) => {
    context.owner()
    targets?.acknowledge(context.sender.mainFrame, payload)
  })
}
