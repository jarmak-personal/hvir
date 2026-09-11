import { hostPathEquals, localPath } from '../../shared/host-path'
import { applicationUserDataPath } from '../application-runtime'
import type { ProjectRegistry } from '../project-registry'
import type { ProjectHost } from '../project-host/project-host'
import type { RendererResourceScopes } from '../renderer-resource-scopes'
import type { WorkbenchRuntime } from '../workbench-runtime'
import { SkillagerCapability } from './skillager-capability'
import { SkillagerCli } from './skillager-cli'

/** Thin application composition; all feature state belongs to the capability. */
export function installSkillager(
  runtime: Pick<WorkbenchRuntime, 'own'>,
  host: ProjectHost,
  resources: RendererResourceScopes,
  projects: Pick<ProjectRegistry, 'active' | 'registeredWorkspaceRoot'>,
): SkillagerCapability {
  const cli = runtime.own(
    'Skillager CLI',
    new SkillagerCli(host, localPath(applicationUserDataPath('.'))),
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
    ),
    (owned) => owned.dispose(),
  )
}
