import type { HostPath } from '../../shared'
import type { ProjectHost } from '../project-host'
import type { RendererResourceScopes } from '../renderer-resource-scopes'
import { DocumentReviewCoordinator } from './document-review-coordinator'
import { DocumentReviewStore } from './document-review-store'

export interface DocumentReviewRuntime {
  readonly coordinator: DocumentReviewCoordinator
  readonly flush: () => Promise<void>
  readonly dispose: () => Promise<void>
}

/** Composes the specialized store and revocable effect owner as one runtime resource. */
export async function createDocumentReviewRuntime(
  host: ProjectHost,
  file: HostPath,
  resources: RendererResourceScopes,
): Promise<DocumentReviewRuntime> {
  const store = await DocumentReviewStore.load(host, file)
  const coordinator = new DocumentReviewCoordinator({ store, resources })
  return {
    coordinator,
    flush: () => store.flush(),
    dispose: async () => {
      coordinator.dispose()
      await store.dispose()
    },
  }
}
