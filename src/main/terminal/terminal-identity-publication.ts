import type { PtySupervisor } from '../pty/pty-supervisor'
import type { RendererEventPublisher } from '../renderer-event-publisher'
import type { WorkbenchRuntime } from '../workbench-runtime'

/** Publish safe terminal identity status while the PTY supervisor owns observation. */
export function installTerminalIdentityPublication(
  runtime: Pick<WorkbenchRuntime, 'own'>,
  ptys: Pick<PtySupervisor, 'onSessionIdentity'>,
  events: Pick<RendererEventPublisher, 'toRenderer'>,
): void {
  runtime.own(
    'terminal identity publication',
    ptys.onSessionIdentity((info) => {
      events.toRenderer(
        { id: info.ownerId, generation: info.ownerGeneration },
        'pty:identity',
        {
          id: info.id,
          harnessSessionId: info.harnessSessionId,
          identityStatus: info.identityStatus,
          ...(info.identityDiverged ? { identityDiverged: true as const } : {}),
        },
      )
    }),
    (dispose) => dispose(),
  )
}
