import type { SkillagerRequest } from '../../shared/skillager'
import type {
  SkillagerContentRequest,
  SkillagerContentFileRequest,
} from '../../shared/skillager-content'
import type { RendererOwner } from '../renderer-resource-scopes'
import type { SkillagerReviewGrant, SkillagerReviewOwner } from './skillager-review-owner'
import type {
  SkillagerDocumentCliPort,
  SkillagerProjectDocumentAccess,
} from './skillager-document-read'
import { result } from './skillager-result'

/** Delegation only: ordinary leases and approval snapshots keep separate identities. */
export function skillagerDocumentPort(
  documents: SkillagerReviewOwner,
  cli: SkillagerDocumentCliPort,
  grant: (owner: RendererOwner, request: SkillagerRequest) => SkillagerReviewGrant,
) {
  return {
    open: (
      owner: RendererOwner,
      request: SkillagerContentRequest,
      project: SkillagerProjectDocumentAccess,
    ) =>
      result(async () =>
        documents.openDocument(owner, request, grant(owner, request), cli, project),
      ),
    read: (owner: RendererOwner, request: SkillagerContentFileRequest) =>
      result(async () => {
        grant(owner, request).assertCurrent()
        return documents.documentContent(owner, request)
      }),
    release: (owner: RendererOwner, contentId: string) =>
      documents.releaseDocument(owner, contentId),
    cancel: (owner: RendererOwner, requestId: number) =>
      documents.cancelDocument(owner, requestId),
  }
}
