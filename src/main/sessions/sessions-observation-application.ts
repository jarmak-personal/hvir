import { harnessProviders } from '../harness/harness-provider'
import type { ProjectState, ProjectHostOption } from '../../shared'
import type { Disposer } from '../project-host/project-host'
import type { PtyObservationSource } from '../pty/pty-supervisor'
import type { RendererEventPublisher } from '../renderer-event-publisher'
import type { TerminalSessionObservationSource } from '../terminal/session-registry'
import type { LiveSessionMetadataSources } from '../terminal/live-session-metadata'
import type { WorkbenchRuntime } from '../workbench-runtime'
import { SessionsObservationPort } from './sessions-observation-port'

export interface ApplicationSessionsObservation {
  readonly context: LiveSessionMetadataSources
  readonly observation: SessionsObservationPort
}

/** Feature-owned application composition for demand-scoped Sessions observation. */
export function installApplicationSessionsObservation(
  runtime: Pick<WorkbenchRuntime, 'own'>,
  projects: { state(): ProjectState; observe(listener: () => void): Disposer },
  hosts: { listHosts(): readonly ProjectHostOption[] },
  sessions: TerminalSessionObservationSource,
  ptys: PtyObservationSource,
  events: Pick<RendererEventPublisher, 'toRenderer'>,
): ApplicationSessionsObservation {
  const observation = runtime.own(
    'Sessions observation port',
    new SessionsObservationPort({
      projectState: () => projects.state(),
      hosts: () => hosts.listHosts(),
      providers: () =>
        harnessProviders.all().map((provider) => ({
          id: provider.manifest.id,
          displayName: provider.manifest.displayName,
          telemetrySupported: Boolean(provider.telemetry),
          usageSupported: Boolean(provider.usageTelemetry),
          sessionKind: provider.manifest.sessionKind,
          contextPressure: provider.manifest.contextPressure,
        })),
      sessions,
      ptys,
      observeProjects: (listener) => projects.observe(listener),
      emit: (owner, change) => events.toRenderer(owner, 'sessions:changed', change),
    }),
    (observation) => observation.dispose(),
  )
  return { observation, context: observation.context }
}
