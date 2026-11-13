import { PtySupervisor } from '../pty/pty-supervisor'
import type { RuntimeDiagnostics } from '../diagnostics/runtime-diagnostics'
import type { TerminalSessionRegistry } from './session-registry'
import type { WorkbenchRuntime } from '../workbench-runtime'
import type { RendererResourceScopes } from '../renderer-resource-scopes'
import { installNativeTerminalApplication } from './native-terminal-application'

/** Constructs the existing supervised terminal lifetime and its selected engine.
 * Session/launch/presentation policy stays behind their domain ports. */
export async function installTerminalApplication(
  runtime: Pick<WorkbenchRuntime, 'own'>,
  diagnostics: Pick<RuntimeDiagnostics, 'recordPty'>,
  sessions: Pick<
    TerminalSessionRegistry,
    'recordIdentity' | 'cancelIdentityRegistration'
  >,
  scopes: Pick<RendererResourceScopes, 'isCurrent'>,
) {
  const ptySupervisor = runtime.own(
    'PTY supervisor',
    new PtySupervisor({
      onDiagnostic: (event) => diagnostics.recordPty(event),
      registerSessionIdentity: (id, harnessSessionId) =>
        sessions.recordIdentity(id, harnessSessionId),
      cancelSessionIdentityRegistration: (id) => sessions.cancelIdentityRegistration(id),
    }),
    (supervisor) => supervisor.disposeAllAndWait(),
  )
  return {
    ptySupervisor,
    ...(await installNativeTerminalApplication(runtime, ptySupervisor, scopes)),
  }
}
