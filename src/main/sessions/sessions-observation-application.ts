import { harnessProviders } from '../harness/harness-provider'
import { HarnessUsageDemandController } from '../harness/harness-usage-demand-controller'
import type { ProjectRegistry } from '../project-registry'
import type {
  PtyObservationSource,
  PtyUsageObservationSource,
} from '../pty/pty-supervisor'
import type { RendererEventPublisher } from '../renderer-event-publisher'
import type { TerminalSessionObservationSource } from '../terminal/session-registry'
import type { WorkbenchRuntime } from '../workbench-runtime'
import { SessionsObservationPort } from './sessions-observation-port'
import { SessionsUsageObservationPort } from './sessions-usage-observation-port'

export interface ApplicationSessionsObservation {
  readonly observation: SessionsObservationPort
  readonly usage: SessionsUsageObservationPort
}

/** Feature-owned application composition for demand-scoped Sessions observation. */
export function installApplicationSessionsObservation(
  runtime: Pick<WorkbenchRuntime, 'own'>,
  projects: Pick<ProjectRegistry, 'state' | 'listHosts' | 'observe'>,
  sessions: TerminalSessionObservationSource,
  ptys: PtyObservationSource & PtyUsageObservationSource,
  events: Pick<RendererEventPublisher, 'toRenderer'>,
): ApplicationSessionsObservation {
  const observation = runtime.own(
    'Sessions observation port',
    new SessionsObservationPort({
      projectState: () => projects.state(),
      hosts: () => projects.listHosts(),
      providers: () =>
        harnessProviders.all().map((provider) => ({
          id: provider.manifest.id,
          displayName: provider.manifest.displayName,
          telemetrySupported: Boolean(provider.telemetry),
          usageSupported: Boolean(provider.usageTelemetry),
          sessionKind: provider.manifest.sessionKind,
        })),
      sessions,
      ptys,
      observeProjects: (listener) => projects.observe(listener),
      emit: (owner, change) => events.toRenderer(owner, 'sessions:changed', change),
    }),
    (observation) => observation.dispose(),
  )
  const demand = runtime.own(
    'Harness usage demand controller',
    new HarnessUsageDemandController(harnessProviders),
    (controller) => controller.dispose(),
  )
  const usage = runtime.own(
    'Sessions usage observation port',
    new SessionsUsageObservationPort({
      sessions: observation,
      ptys,
      usage: demand,
      emit: (owner, change) => events.toRenderer(owner, 'sessions:usage-changed', change),
    }),
    (port) => port.dispose(),
  )
  return { observation, usage }
}
