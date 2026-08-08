import type { HostPath } from '../../shared'
import type { ProjectHost } from '../project-host'
import type { PtySupervisor } from '../pty/pty-supervisor'
import type { RendererResourceScopes } from '../renderer-resource-scopes'
import type { TerminalSessionStore } from '../terminal/session-registry'
import type { HarnessProviderRegistry } from '../harness/harness-provider'
import type { HarnessProfileStoreContract } from '../harness/harness-profile-store'
import { DocumentReviewCoordinator } from './document-review-coordinator'
import { DocumentReviewDeliveryCoordinator } from './document-review-delivery-coordinator'
import { DocumentReviewStore } from './document-review-store'
import { DOCUMENT_REVIEW_RETENTION_SWEEP_MS } from './document-review-retention'

export interface DocumentReviewRuntime {
  readonly coordinator: DocumentReviewCoordinator
  readonly delivery: DocumentReviewDeliveryCoordinator
  readonly flush: () => Promise<void>
  readonly dispose: () => Promise<void>
}

/** Composes the specialized store and revocable effect owner as one runtime resource. */
export async function createDocumentReviewRuntime(
  host: ProjectHost,
  file: HostPath,
  resources: RendererResourceScopes,
  delivery: {
    readonly ptys: Pick<PtySupervisor, 'get' | 'list' | 'write' | 'writeConfirmed'>
    readonly sessions: Pick<TerminalSessionStore, 'get'>
    readonly providers: Pick<HarnessProviderRegistry, 'get'>
    readonly profiles: Pick<HarnessProfileStoreContract, 'get'>
  },
): Promise<DocumentReviewRuntime> {
  const store = await DocumentReviewStore.load(host, file)
  const coordinator = new DocumentReviewCoordinator({ store, resources })
  const retentionSweep = setInterval(() => {
    void coordinator.sweepInactiveDrafts().catch(() => undefined)
  }, DOCUMENT_REVIEW_RETENTION_SWEEP_MS)
  retentionSweep.unref()
  const reviewDelivery = new DocumentReviewDeliveryCoordinator({
    workspace: coordinator,
    resources,
    ...delivery,
  })
  return {
    coordinator,
    delivery: reviewDelivery,
    flush: () => store.flush(),
    dispose: async () => {
      clearInterval(retentionSweep)
      reviewDelivery.dispose()
      coordinator.dispose()
      await store.dispose()
    },
  }
}
