import { localPath } from '../../shared/host-path'
import { applicationRuntime } from '../application-runtime'
import type { WorkbenchRuntime } from '../workbench-runtime'
import type { RendererResourceScopes } from '../renderer-resource-scopes'
import type { RendererEventPublisher } from '../renderer-event-publisher'
import { ExtensionApplicationRuntime } from './extension-application'

export function installExtensions(
  runtime: WorkbenchRuntime,
  scopes: RendererResourceScopes,
  events: RendererEventPublisher,
): ExtensionApplicationRuntime {
  return runtime.own(
    'extensions',
    new ExtensionApplicationRuntime(
      scopes,
      events,
      localPath(applicationRuntime.userDataRoot),
    ),
    (extensions) => extensions.dispose(),
  )
}
