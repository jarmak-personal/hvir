import type { IpcRegistrar } from '../authority-router'
import type { IpcDeps } from '../deps'
import { isTerminalId } from '../terminal-validation'

type AssistantOutputIpcDeps = Pick<IpcDeps, 'ptySupervisor'>

export function registerAssistantOutputIpc(
  ipc: IpcRegistrar,
  deps: AssistantOutputIpcDeps,
): void {
  ipc.handle('pty:set-assistant-output-mode', (req, context) => {
    if (!isTerminalId(req.id) || typeof req.enabled !== 'boolean') return false
    const owner = context.owner()
    if (!deps.ptySupervisor.isOwnedBy(req.id, owner.id, owner.generation)) return false
    return deps.ptySupervisor.setAssistantOutputMode(
      req.id,
      owner.id,
      req.enabled,
      owner.generation,
    )
  })
}
