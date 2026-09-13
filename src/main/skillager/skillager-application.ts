import { createSkillagerFolderPicker } from './electron-skillager-folder-picker'
import {
  skillagerDestinationAvailable,
  skillagerWorkspaceAvailable,
} from './skillager-destination'
import { SkillagerDeploymentStore } from './skillager-deployment-store'
import { SkillagerRemoteExposures } from './skillager-remote-exposures'
import type { HtmlPreviewProtocol } from '../html-preview-protocol'
import { hostPathEquals, localPath } from '../../shared/host-path'
import { applicationUserDataPath } from '../application-runtime'
import type { ProjectRegistry } from '../project-registry'
import type { ProjectHost } from '../project-host/project-host'
import type { RendererResourceScopes } from '../renderer-resource-scopes'
import type { WorkbenchRuntime } from '../workbench-runtime'
import { SkillagerCapability } from './skillager-capability'
import { SkillagerCli } from './skillager-cli'
import { createSkillagerProjectTerminal } from './skillager-project-terminal'

/** Thin application composition; all feature state belongs to the capability. */
export function installSkillager(
  runtime: Pick<WorkbenchRuntime, 'own'>,
  host: ProjectHost,
  resources: RendererResourceScopes,
  projects: Pick<
    ProjectRegistry,
    'active' | 'registeredWorkspaceRoot' | 'state' | 'authorityForPath'
  >,
  previews: Pick<HtmlPreviewProtocol, 'create' | 'release'>,
  terminal?: Omit<
    Parameters<typeof createSkillagerProjectTerminal>[1],
    'rendererResources'
  >,
): SkillagerCapability {
  const cli = runtime.own(
    'Skillager CLI',
    new SkillagerCli(host, localPath(applicationUserDataPath('.'))),
    (owned) => owned.dispose(),
  )
  const store = runtime.own(
    'Skillager deployment records',
    new SkillagerDeploymentStore(
      host,
      localPath(applicationUserDataPath('skillager-deployments.json')),
    ),
    (owned) => owned.dispose(),
  )
  const exposure = runtime.own(
    'Skillager SSH deliveries',
    new SkillagerRemoteExposures(cli, store, (root) =>
      projects.registeredWorkspaceRoot(root) &&
      skillagerWorkspaceAvailable(projects.state(), root)
        ? projects.authorityForPath(root.hostId, root.path)?.host
        : undefined,
    ),
    (owned) => owned.dispose(),
  )
  return runtime.own(
    'Skillager capability',
    new SkillagerCapability(
      cli,
      resources,
      (root) =>
        Boolean(projects.registeredWorkspaceRoot(root)) &&
        hostPathEquals(projects.active.root, root),
      {
        cli,
        previews: {
          create: (content, root) => previews.create(content, undefined, root),
          release: (id) => previews.release(id),
        },
      },
      {
        cli: exposure,
        observe: (selection, request, source, signal) =>
          exposure.observe(selection, request, source, signal),
        destinationAvailable: (destination) =>
          skillagerDestinationAvailable(projects.state(), destination),
      },
      { cli, picker: createSkillagerFolderPicker(host) },
      terminal
        ? {
            cli,
            terminal: createSkillagerProjectTerminal(host, {
              ...terminal,
              rendererResources: resources,
            }),
          }
        : undefined,
    ),
    (owned) => owned.dispose(),
  )
}
