import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactElement,
  type ReactNode,
} from 'react'
import { createPortal } from 'react-dom'

import {
  DocumentReviewInlineHostContext,
  lineRangeLabel,
  type RegisterDocumentReviewInlineHost,
} from './document-review-inline'
import type { DocumentReviewComment, ReviewSourceRange } from './document-review-types'
import type { DocumentReviewInteraction } from './use-document-review-interaction'

interface DraftText {
  readonly key: string
  readonly body: string
}

interface EditText {
  readonly commentId: string
  readonly body: string
}

export function DocumentReviewInlineProvider({
  interaction,
  children,
}: {
  readonly interaction: DocumentReviewInteraction
  readonly children: ReactNode
}): ReactElement {
  const [host, setHost] = useState<HTMLElement>()
  const [draft, setDraft] = useState<DraftText>()
  const [edit, setEdit] = useState<EditText>()
  const registerHost = useCallback<RegisterDocumentReviewInlineHost>((nextHost) => {
    let registered = true
    setHost(nextHost)
    return () => {
      if (!registered) return
      registered = false
      setHost((current) => (current === nextHost ? undefined : current))
    }
  }, [])
  const pendingKey = interaction.pendingRange
    ? rangeKey(interaction.pendingRange)
    : undefined
  const draftBody = pendingKey && draft?.key === pendingKey ? draft.body : ''

  useEffect(() => {
    if (!interaction.pendingRange) setDraft(undefined)
  }, [interaction.pendingRange])
  useEffect(() => {
    if (edit && !interaction.comments.some((comment) => comment.id === edit.commentId)) {
      setEdit(undefined)
    }
  }, [edit, interaction.comments])

  return (
    <DocumentReviewInlineHostContext.Provider value={registerHost}>
      {children}
      {host && interaction.active && interaction.inlineRange
        ? createPortal(
            <DocumentReviewInlineThread
              interaction={interaction}
              draftBody={draftBody}
              onDraftBody={(body) => {
                if (pendingKey) setDraft({ key: pendingKey, body })
              }}
              edit={edit}
              onBeginEdit={(comment) =>
                setEdit({ commentId: comment.id, body: comment.body })
              }
              onEditBody={(body) =>
                setEdit((current) => (current ? { ...current, body } : current))
              }
              onCancelEdit={() => setEdit(undefined)}
              onSaveEdit={(commentId, body) => {
                interaction.edit(commentId, body)
                setEdit(undefined)
              }}
            />,
            host,
          )
        : null}
    </DocumentReviewInlineHostContext.Provider>
  )
}

function DocumentReviewInlineThread({
  interaction,
  draftBody,
  onDraftBody,
  edit,
  onBeginEdit,
  onEditBody,
  onCancelEdit,
  onSaveEdit,
}: {
  readonly interaction: DocumentReviewInteraction
  readonly draftBody: string
  readonly onDraftBody: (body: string) => void
  readonly edit?: EditText
  readonly onBeginEdit: (comment: DocumentReviewComment) => void
  readonly onEditBody: (body: string) => void
  readonly onCancelEdit: () => void
  readonly onSaveEdit: (commentId: string, body: string) => void
}): ReactElement | null {
  const range = interaction.inlineRange
  const comments = useMemo(
    () =>
      range
        ? interaction.comments.filter((comment) =>
            rangesOverlap(range, comment.anchor.range),
          )
        : [],
    [interaction.comments, range],
  )
  if (!range) return null
  return (
    <section
      className="document-review-inline"
      aria-label={`Document review at ${lineRangeLabel(range)}`}
      onKeyDown={(event) => {
        if (event.key !== 'Escape') return
        event.preventDefault()
        event.stopPropagation()
        if (edit) onCancelEdit()
        else interaction.cancelCapture()
      }}
    >
      <header>
        <strong>Review</strong>
        <span>{lineRangeLabel(range)}</span>
        <button
          type="button"
          className="document-review-close"
          aria-label={`Close review at ${lineRangeLabel(range)}`}
          onClick={interaction.cancelCapture}
        >
          ×
        </button>
      </header>
      {interaction.pendingRange ? (
        <NewCommentForm
          range={interaction.pendingRange}
          body={draftBody}
          onBody={onDraftBody}
          onSubmit={interaction.submit}
          onCancel={interaction.cancelCapture}
        />
      ) : null}
      {comments.length > 0 ? (
        <ol className="document-review-comments">
          {comments.map((comment) => (
            <ReviewCommentCard
              key={comment.id}
              comment={comment}
              edit={edit?.commentId === comment.id ? edit : undefined}
              focusRequest={
                interaction.commentNavigation?.id === comment.id
                  ? interaction.commentNavigation.request
                  : undefined
              }
              interaction={interaction}
              onBeginEdit={() => onBeginEdit(comment)}
              onEditBody={onEditBody}
              onCancelEdit={onCancelEdit}
              onSaveEdit={(body) => onSaveEdit(comment.id, body)}
            />
          ))}
        </ol>
      ) : interaction.pendingRange ? null : (
        <p className="document-review-empty">No comments at this location.</p>
      )}
    </section>
  )
}

function NewCommentForm({
  range,
  body,
  onBody,
  onSubmit,
  onCancel,
}: {
  readonly range: ReviewSourceRange
  readonly body: string
  readonly onBody: (body: string) => void
  readonly onSubmit: (body: string) => Promise<void>
  readonly onCancel: () => void
}): ReactElement {
  const form = useRef<HTMLFormElement>(null)
  const textarea = useRef<HTMLTextAreaElement>(null)
  useEffect(() => {
    form.current?.scrollIntoView?.({ block: 'nearest' })
    textarea.current?.focus({ preventScroll: true })
  }, [range.endLine, range.startLine])
  return (
    <form
      ref={form}
      className="document-review-compose"
      aria-label={`New comment for ${lineRangeLabel(range)}`}
      onSubmit={(event) => {
        event.preventDefault()
        void onSubmit(body)
      }}
    >
      <textarea
        ref={textarea}
        aria-label="New review comment"
        value={body}
        onChange={(event) => onBody(event.currentTarget.value)}
      />
      <div>
        <button type="submit" disabled={body.trim().length === 0}>
          Add review comment
        </button>
        <button type="button" onClick={onCancel}>
          Cancel
        </button>
      </div>
    </form>
  )
}

function ReviewCommentCard({
  comment,
  edit,
  focusRequest,
  interaction,
  onBeginEdit,
  onEditBody,
  onCancelEdit,
  onSaveEdit,
}: {
  readonly comment: DocumentReviewComment
  readonly edit?: EditText
  readonly focusRequest?: number
  readonly interaction: DocumentReviewInteraction
  readonly onBeginEdit: () => void
  readonly onEditBody: (body: string) => void
  readonly onCancelEdit: () => void
  readonly onSaveEdit: (body: string) => void
}): ReactElement {
  const card = useRef<HTMLLIElement>(null)
  useEffect(() => {
    if (focusRequest === undefined) return
    card.current?.scrollIntoView?.({ block: 'nearest' })
    card.current?.focus({ preventScroll: true })
  }, [focusRequest])
  const stale = comment.anchor.state.status === 'stale'
  const staleUnreviewed = stale && !comment.anchor.state.reviewed
  return (
    <li
      ref={card}
      tabIndex={-1}
      aria-label={`Review comment at ${lineRangeLabel(comment.anchor.range)}`}
      className={`document-review-comment review-anchor-${comment.anchor.state.status}`}
    >
      <div className="document-review-comment-heading">
        <button
          type="button"
          aria-label={`Go to review comment at ${lineRangeLabel(comment.anchor.range)}`}
          onClick={() => interaction.navigate(comment)}
        >
          {lineRangeLabel(comment.anchor.range)}
        </button>
        <span className={`review-state review-${comment.lifecycle}`}>
          {comment.lifecycle}
        </span>
        <AnchorState comment={comment} />
      </div>
      {edit ? (
        <form
          onSubmit={(event) => {
            event.preventDefault()
            onSaveEdit(edit.body)
          }}
        >
          <textarea
            autoFocus
            aria-label={`Edit comment at ${lineRangeLabel(comment.anchor.range)}`}
            value={edit.body}
            onChange={(event) => onEditBody(event.currentTarget.value)}
          />
          <button type="submit" disabled={edit.body.trim().length === 0}>
            Save
          </button>
          <button type="button" onClick={onCancelEdit}>
            Cancel
          </button>
        </form>
      ) : comment.lifecycle === 'draft' ? (
        <button
          type="button"
          className="document-review-comment-body"
          aria-label={`Edit comment at ${lineRangeLabel(comment.anchor.range)}`}
          onClick={onBeginEdit}
        >
          {comment.body}
        </button>
      ) : (
        <p>{comment.body}</p>
      )}
      {comment.lifecycle === 'draft' ? (
        <div className="document-review-comment-actions">
          {staleUnreviewed ? (
            <button
              type="button"
              aria-label={`Acknowledge stale location for comment at ${lineRangeLabel(comment.anchor.range)}`}
              onClick={() => interaction.reviewStale(comment.id)}
            >
              Use stale location
            </button>
          ) : null}
          <button
            type="button"
            aria-label={`Remove comment at ${lineRangeLabel(comment.anchor.range)}`}
            onClick={() => interaction.remove(comment.id)}
          >
            Delete
          </button>
        </div>
      ) : null}
    </li>
  )
}

function AnchorState({
  comment,
}: {
  readonly comment: DocumentReviewComment
}): ReactElement {
  const state = comment.anchor.state
  if (state.status === 'moved') {
    return (
      <span className="review-anchor-state moved">
        Moved from {lineRangeLabel(state.previous.range)}
      </span>
    )
  }
  if (state.status === 'stale') {
    return (
      <span className="review-anchor-state stale">
        Stale · {state.reason.replaceAll('-', ' ')}
        {state.reviewed ? ' · accepted' : ''}
      </span>
    )
  }
  return <span className="review-anchor-state current">Current</span>
}

function rangesOverlap(left: ReviewSourceRange, right: ReviewSourceRange): boolean {
  return left.startLine <= right.endLine && right.startLine <= left.endLine
}

function rangeKey(range: ReviewSourceRange): string {
  return `${range.startLine}:${range.endLine}`
}
