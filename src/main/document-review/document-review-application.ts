import { localPath } from '../../shared'
import { applicationUserDataPath } from '../application-runtime'
import type { HarnessProviderRegistry } from '../harness/harness-provider-registry'
import type { HarnessProfileStoreContract } from '../harness/harness-profile-store'
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
  providers: HarnessProviderRegistry,
  profiles: HarnessProfileStoreContract,
): Promise<DocumentReviewRuntime> {
  return runtime.own(
    'document review',
    await createDocumentReviewRuntime(
      storageHost,
      localPath(applicationUserDataPath('document-review-drafts.json')),
      resources,
      { ptys, sessions, providers, profiles },
    ),
    (review) => review.dispose(),
  )
}
