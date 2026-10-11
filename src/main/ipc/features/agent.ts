import type { AgentApplicationRuntime } from '../../agent/agent-application'
import type { IpcRegistrar } from '../authority-router'

export function registerAgentIpc(
  ipc: IpcRegistrar,
  agents?: AgentApplicationRuntime,
): void {
  const runtime = (): AgentApplicationRuntime => {
    if (!agents) throw new Error('Agent access is unavailable')
    return agents
  }
  ipc.handle('agent:access', (_req, context) => {
    context.owner()
    return runtime().snapshot()
  })
  ipc.handle('agent:configure', async (req, context) => {
    context.owner()
    await runtime().configure(req)
    context.owner()
    return runtime().snapshot()
  })
  ipc.handle('agent:extension-configure', async (req, context) => {
    context.owner()
    await runtime().configureExtension(req.installation, req.enabled)
    context.owner()
    return runtime().snapshot()
  })
  ipc.handle('agent:forward-grant', (req, context) => {
    context.owner()
    runtime().configureForward(req.grant, req.enabled)
    return runtime().snapshot()
  })
  ipc.handle('agent:decide', (req, context) => {
    context.owner()
    runtime().access.decide(req.id, req.accept)
  })
  ipc.handle('agent:reports', (_req, context) => {
    context.owner()
    return runtime().reports.snapshot()
  })
  ipc.handle('agent:report-read', (req, context) => {
    context.owner()
    return runtime().reports.read(req.id)
  })
  ipc.handle('agent:report-viewed', (req, context) => {
    context.owner()
    runtime().reports.viewed(req.id, req.version)
  })
  ipc.handle('agent:report-close', (req, context) => {
    context.owner()
    runtime().reports.close(req.id)
  })
}
