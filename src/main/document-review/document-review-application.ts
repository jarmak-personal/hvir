import { localPath } from '../../shared'
import { applicationUserDataPath } from '../application-runtime'
import { harnessProviders } from '../harness/harness-provider'
import type { ProjectHost } from '../project-host'
import type { PtySupervisor } from '../pty/pty-supervisor'
import type { RendererResourceScopes } from '../renderer-resource-scopes'
import type { TerminalSessionStore } from '../terminal/session-registry'
import type { WorkbenchRuntime } from '../workbench-runtime'
import {
  createDocumentReviewRuntime,
  type DocumentReviewRuntime,
} from './document-review-runtime'

/** Feature-owned application composition for durable review and prepared delivery. */
export async function installApplicationDocumentReviewRuntime(
  runtime: Pick<WorkbenchRuntime, 'own'>,
  storageHost: ProjectHost,
  resources: RendererResourceScopes,
  ptys: PtySupervisor,
  sessions: TerminalSessionStore,
): Promise<DocumentReviewRuntime> {
  return runtime.own(
    'document review',
    await createDocumentReviewRuntime(
      storageHost,
      localPath(applicationUserDataPath('document-review-drafts.json')),
      resources,
      { ptys, sessions, providers: harnessProviders },
    ),
    (review) => review.dispose(),
  )
}
