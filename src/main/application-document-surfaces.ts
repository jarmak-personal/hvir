import { localPath } from '../shared/host-path'
import type { WorkbenchRuntime } from './workbench-runtime'
import type { RendererResourceScopes } from './renderer-resource-scopes'
import type { RendererEventPublisher } from './renderer-event-publisher'
import { ExtensionApplicationRuntime } from './extensions/extension-application'

import { HtmlPreviewProtocol } from './html-preview-protocol'
import { applicationRuntime } from './application-runtime'

/** Application lifetime composition for the two independently isolated document surfaces. */
export function installDocumentSurfaces(
  runtime: WorkbenchRuntime,
  scopes: RendererResourceScopes,
  events: RendererEventPublisher,
): { htmlPreviews: HtmlPreviewProtocol; extensions: ExtensionApplicationRuntime } {
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
  return { htmlPreviews, extensions }
}
