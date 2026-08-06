import {
  DOCUMENT_REVIEW_LIMITS,
  asHostId,
  hostPath,
  type DocumentReviewAnchor,
  type DocumentReviewBatch,
  type DocumentReviewComment,
  type DocumentReviewModel,
  type ReviewAnchorLocation,
  type ReviewAnchorState,
  type ReviewDocumentSnapshot,
  type ReviewSourceRange,
  type ReviewWorkspaceIdentity,
} from '../../shared'
import {
  documentReviewWorkspaceEquals,
  isDocumentReviewDocument,
  isDocumentReviewRecord,
} from './document-review-policy'

export const DOCUMENT_REVIEW_FILE_VERSION = 1
export const MAX_STORED_REVIEW_WORKSPACES = 64

export interface StoredReviewWorkspace {
  readonly revision: number
  readonly model: DocumentReviewModel
}

export interface StoredReviewFile {
  readonly version: typeof DOCUMENT_REVIEW_FILE_VERSION
  readonly workspaces: readonly StoredReviewWorkspace[]
}

export function parseStoredReviewFile(value: unknown): StoredReviewFile | undefined {
  if (
    !isDocumentReviewRecord(value) ||
    value['version'] !== DOCUMENT_REVIEW_FILE_VERSION ||
    !Array.isArray(value['workspaces']) ||
    value['workspaces'].length > MAX_STORED_REVIEW_WORKSPACES
  ) {
    return undefined
  }
  const workspaces: StoredReviewWorkspace[] = []
  const keys = new Set<string>()
  for (const raw of value['workspaces']) {
    if (
      !isDocumentReviewRecord(raw) ||
      !Number.isSafeInteger(raw['revision']) ||
      (raw['revision'] as number) < 1
    ) {
      return undefined
    }
    const model = parseReviewModel(raw['model'])
    if (!model) return undefined
    const key = reviewWorkspaceKey(model.workspace)
    if (keys.has(key)) return undefined
    keys.add(key)
    workspaces.push({ revision: raw['revision'] as number, model })
  }
  return { version: DOCUMENT_REVIEW_FILE_VERSION, workspaces }
}

export function parseReviewModel(value: unknown): DocumentReviewModel | undefined {
  if (!isDocumentReviewRecord(value)) return undefined
  const workspace = parseWorkspace(value['workspace'])
  const rawComments = value['comments']
  const rawBatches = value['batches']
  if (
    !workspace ||
    !Array.isArray(rawComments) ||
    rawComments.length > DOCUMENT_REVIEW_LIMITS.commentsPerWorkspace ||
    !Array.isArray(rawBatches) ||
    rawBatches.length > DOCUMENT_REVIEW_LIMITS.batchesPerWorkspace ||
    utf8Bytes(JSON.stringify(value)) > DOCUMENT_REVIEW_LIMITS.storedWorkspaceBytes
  ) {
    return undefined
  }
  const comments: DocumentReviewComment[] = []
  const commentIds = new Set<string>()
  const documentCounts = new Map<string, number>()
  for (const raw of rawComments) {
    const comment = parseComment(raw, workspace)
    if (!comment || commentIds.has(comment.id)) return undefined
    const documentKey = `${comment.document.hostId}:${comment.document.path}`
    const documentCount = (documentCounts.get(documentKey) ?? 0) + 1
    if (documentCount > DOCUMENT_REVIEW_LIMITS.commentsPerDocument) return undefined
    documentCounts.set(documentKey, documentCount)
    commentIds.add(comment.id)
    comments.push(comment)
  }
  const batches: DocumentReviewBatch[] = []
  const batchIds = new Set<string>()
  for (const raw of rawBatches) {
    const batch = parseBatch(raw, workspace, commentIds)
    if (!batch || batchIds.has(batch.id)) return undefined
    batchIds.add(batch.id)
    batches.push(batch)
  }
  return { workspace, comments, batches }
}

function parseComment(
  value: unknown,
  workspace: ReviewWorkspaceIdentity,
): DocumentReviewComment | undefined {
  if (!isDocumentReviewRecord(value)) return undefined
  const storedWorkspace = parseWorkspace(value['workspace'])
  const document = parsePath(value['document'])
  const anchor = parseAnchor(value['anchor'])
  const id = value['id']
  const body = value['body']
  const lifecycle = value['lifecycle']
  if (
    !storedWorkspace ||
    !documentReviewWorkspaceEquals(storedWorkspace, workspace) ||
    !document ||
    !isDocumentReviewDocument(workspace, document) ||
    !validId(id, DOCUMENT_REVIEW_LIMITS.idBytes) ||
    typeof body !== 'string' ||
    body.trim().length === 0 ||
    utf8Bytes(body) > DOCUMENT_REVIEW_LIMITS.commentBytes ||
    !anchor ||
    (lifecycle !== 'draft' && lifecycle !== 'sent' && lifecycle !== 'resolved')
  ) {
    return undefined
  }
  return { id, workspace, document, body, anchor, lifecycle }
}

function parseBatch(
  value: unknown,
  workspace: ReviewWorkspaceIdentity,
  commentIds: ReadonlySet<string>,
): DocumentReviewBatch | undefined {
  if (!isDocumentReviewRecord(value)) return undefined
  const storedWorkspace = parseWorkspace(value['workspace'])
  const id = value['id']
  const members = value['commentIds']
  if (
    !storedWorkspace ||
    !documentReviewWorkspaceEquals(storedWorkspace, workspace) ||
    !validId(id, DOCUMENT_REVIEW_LIMITS.idBytes) ||
    !Array.isArray(members) ||
    members.length === 0 ||
    members.length > DOCUMENT_REVIEW_LIMITS.batchMembers ||
    members.some((member) => typeof member !== 'string' || !commentIds.has(member)) ||
    new Set(members).size !== members.length
  ) {
    return undefined
  }
  return { id, workspace, commentIds: members as string[] }
}

function parseAnchor(value: unknown): DocumentReviewAnchor | undefined {
  if (!isDocumentReviewRecord(value)) return undefined
  const snapshot = parseSnapshot(value['snapshot'])
  const range = parseRange(value['range'])
  const excerpt = value['excerpt']
  const contextBefore = value['contextBefore']
  const contextAfter = value['contextAfter']
  const state = parseAnchorState(value['state'])
  if (
    !snapshot ||
    !range ||
    typeof excerpt !== 'string' ||
    excerpt.length === 0 ||
    utf8Bytes(excerpt) > DOCUMENT_REVIEW_LIMITS.excerptBytes ||
    typeof contextBefore !== 'string' ||
    utf8Bytes(contextBefore) > DOCUMENT_REVIEW_LIMITS.contextBytes ||
    typeof contextAfter !== 'string' ||
    utf8Bytes(contextAfter) > DOCUMENT_REVIEW_LIMITS.contextBytes ||
    !state
  ) {
    return undefined
  }
  return { snapshot, range, excerpt, contextBefore, contextAfter, state }
}

function parseAnchorState(value: unknown): ReviewAnchorState | undefined {
  if (!isDocumentReviewRecord(value)) return undefined
  if (value['status'] === 'current') return { status: 'current' }
  if (value['status'] === 'moved') {
    const previous = parseLocation(value['previous'])
    return previous ? { status: 'moved', previous } : undefined
  }
  if (
    value['status'] === 'stale' &&
    staleReason(value['reason']) &&
    typeof value['reviewed'] === 'boolean'
  ) {
    return { status: 'stale', reason: value['reason'], reviewed: value['reviewed'] }
  }
  return undefined
}

function parseLocation(value: unknown): ReviewAnchorLocation | undefined {
  if (!isDocumentReviewRecord(value)) return undefined
  const snapshot = parseSnapshot(value['snapshot'])
  const range = parseRange(value['range'])
  return snapshot && range ? { snapshot, range } : undefined
}

function parseSnapshot(value: unknown): ReviewDocumentSnapshot | undefined {
  return isDocumentReviewRecord(value) &&
    value['algorithm'] === 'sha256' &&
    typeof value['digest'] === 'string' &&
    /^[a-f0-9]{64}$/.test(value['digest']) &&
    Number.isSafeInteger(value['byteLength']) &&
    (value['byteLength'] as number) >= 0
    ? {
        algorithm: 'sha256',
        digest: value['digest'],
        byteLength: value['byteLength'] as number,
      }
    : undefined
}

function parseRange(value: unknown): ReviewSourceRange | undefined {
  if (!isDocumentReviewRecord(value)) return undefined
  const startLine = value['startLine']
  const endLine = value['endLine']
  return Number.isSafeInteger(startLine) &&
    Number.isSafeInteger(endLine) &&
    (startLine as number) >= 1 &&
    (endLine as number) >= (startLine as number) &&
    (endLine as number) - (startLine as number) + 1 <=
      DOCUMENT_REVIEW_LIMITS.sourceRangeLines
    ? { startLine: startLine as number, endLine: endLine as number }
    : undefined
}

function parseWorkspace(value: unknown): ReviewWorkspaceIdentity | undefined {
  if (
    !isDocumentReviewRecord(value) ||
    !validId(value['id'], DOCUMENT_REVIEW_LIMITS.workspaceIdBytes)
  ) {
    return undefined
  }
  const root = parsePath(value['root'])
  return root ? { id: value['id'], root } : undefined
}

function parsePath(value: unknown): ReturnType<typeof hostPath> | undefined {
  if (
    !isDocumentReviewRecord(value) ||
    typeof value['hostId'] !== 'string' ||
    value['hostId'].length === 0 ||
    typeof value['path'] !== 'string' ||
    !value['path'].startsWith('/')
  ) {
    return undefined
  }
  const parsed = hostPath(asHostId(value['hostId']), value['path'])
  return parsed.path === value['path'] ? parsed : undefined
}

export function assertReviewWorkspace(workspace: ReviewWorkspaceIdentity): void {
  if (!parseWorkspace(workspace)) throw new Error('Invalid document-review workspace')
}

function validId(value: unknown, limit: number): value is string {
  if (typeof value !== 'string' || value.length === 0 || utf8Bytes(value) > limit) {
    return false
  }
  for (const character of value) {
    const codePoint = character.codePointAt(0)!
    if (codePoint <= 31 || codePoint === 127) return false
  }
  return true
}

function staleReason(
  value: unknown,
): value is Extract<ReviewAnchorState, { status: 'stale' }>['reason'] {
  return (
    value === 'ambiguous-match' ||
    value === 'deleted' ||
    value === 'host-unavailable' ||
    value === 'incomplete-read' ||
    value === 'invalid-snapshot' ||
    value === 'invalid-text' ||
    value === 'missing-match' ||
    value === 'read-limit-exceeded'
  )
}

export function reviewWorkspaceKey(workspace: ReviewWorkspaceIdentity): string {
  return `${workspace.id}\0${workspace.root.hostId}\0${workspace.root.path}`
}

export function cloneReviewModel(model: DocumentReviewModel): DocumentReviewModel {
  return structuredClone(model)
}

export function isFutureReviewVersion(value: unknown): boolean {
  return Number.isSafeInteger(value) && (value as number) > DOCUMENT_REVIEW_FILE_VERSION
}

function utf8Bytes(value: string): number {
  return Buffer.byteLength(value, 'utf8')
}
