import { harnessProviders } from '../harness/harness-provider'
import type { ProjectRegistry } from '../project-registry'
import type { PtyObservationSource } from '../pty/pty-supervisor'
import type { RendererEventPublisher } from '../renderer-event-publisher'
import type { TerminalSessionObservationSource } from '../terminal/session-registry'
import type { WorkbenchRuntime } from '../workbench-runtime'
import { SessionsObservationPort } from './sessions-observation-port'

/** Feature-owned application composition for demand-scoped Sessions observation. */
export function installApplicationSessionsObservation(
  runtime: Pick<WorkbenchRuntime, 'own'>,
  projects: Pick<ProjectRegistry, 'state' | 'listHosts' | 'observe'>,
  sessions: TerminalSessionObservationSource,
  ptys: PtyObservationSource,
  events: Pick<RendererEventPublisher, 'toRenderer'>,
): SessionsObservationPort {
  return runtime.own(
    'Sessions observation port',
    new SessionsObservationPort({
      projectState: () => projects.state(),
      hosts: () => projects.listHosts(),
      providers: () =>
        harnessProviders.all().map((provider) => ({
          id: provider.manifest.id,
          displayName: provider.manifest.displayName,
          telemetrySupported: Boolean(provider.telemetry),
          sessionKind: provider.manifest.sessionKind,
        })),
      sessions,
      ptys,
      observeProjects: (listener) => projects.observe(listener),
      emit: (owner, change) => events.toRenderer(owner, 'sessions:changed', change),
    }),
    (observation) => observation.dispose(),
  )
}
