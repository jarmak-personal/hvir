import type { LiveSessionMetadataSources } from './terminal/live-session-metadata'
import type { ProjectHostCatalog } from './project-host/project-host-catalog'
import type { PtySupervisor } from './pty/pty-supervisor'
import { localPath } from '../shared/host-path'
import type { WorkbenchRuntime } from './workbench-runtime'
import type { RendererResourceScopes } from './renderer-resource-scopes'
import type { RendererEventPublisher } from './renderer-event-publisher'
import { ExtensionApplicationRuntime } from './extensions/extension-application'
import { AgentApplicationRuntime } from './agent/agent-application'

import { HtmlPreviewProtocol } from './html-preview-protocol'
import { applicationRuntime } from './application-runtime'

/** Application composition for document surfaces and their local agent adapter. */
export function installDocumentSurfaces(
  runtime: WorkbenchRuntime,
  scopes: RendererResourceScopes,
  events: RendererEventPublisher,
): {
  htmlPreviews: HtmlPreviewProtocol
  extensions: ExtensionApplicationRuntime
  agents: AgentApplicationRuntime
  start: (
    sources: LiveSessionMetadataSources,
    hosts: ProjectHostCatalog,
    ptys: PtySupervisor,
  ) => Promise<void>
} {
  const htmlPreviews = runtime.own(
    'HTML preview protocol',
    new HtmlPreviewProtocol(),
    (previews) => previews.dispose(),
  )
  const extensions = runtime.own(
    'extensions',
    new ExtensionApplicationRuntime(
      scopes,
      events,
      localPath(applicationRuntime.userDataRoot),
    ),
    (extensions) => extensions.dispose(),
  )
  const agents = runtime.own(
    'agent access',
    new AgentApplicationRuntime(
      scopes,
      events,
      localPath(applicationRuntime.userDataRoot),
      extensions,
    ),
    (agents) => agents.dispose(),
  )
  return {
    htmlPreviews,
    extensions,
    agents,
    start: async (sources, hosts, ptys) => {
      await Promise.all([
        extensions.start(hosts.local, sources, hosts),
        agents.start(hosts.local, sources, hosts, ptys),
      ])
    },
  }
}
