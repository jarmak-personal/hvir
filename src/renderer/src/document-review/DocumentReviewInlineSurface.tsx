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

export function DocumentReviewInlineProvider({
  interaction,
  children,
}: {
  readonly interaction: DocumentReviewInteraction
  readonly children: ReactNode
}): ReactElement {
  const [host, setHost] = useState<HTMLElement>()
  const registerHost = useCallback<RegisterDocumentReviewInlineHost>((nextHost) => {
    let registered = true
    setHost(nextHost)
    return () => {
      if (!registered) return
      registered = false
      setHost((current) => (current === nextHost ? undefined : current))
    }
  }, [])

  return (
    <DocumentReviewInlineHostContext.Provider value={registerHost}>
      {children}
      {host && interaction.active && interaction.inlineRange
        ? createPortal(<DocumentReviewInlineThread interaction={interaction} />, host)
        : null}
    </DocumentReviewInlineHostContext.Provider>
  )
}

function DocumentReviewInlineThread({
  interaction,
}: {
  readonly interaction: DocumentReviewInteraction
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
    >
      <header>
        <strong>Review</strong>
        <span>{lineRangeLabel(range)}</span>
        <button
          type="button"
          aria-label={`Close review at ${lineRangeLabel(range)}`}
          onClick={interaction.closeInline}
        >
          Close
        </button>
      </header>
      {interaction.pendingRange ? (
        <NewCommentForm
          key={`${interaction.pendingRange.startLine}:${interaction.pendingRange.endLine}`}
          range={interaction.pendingRange}
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
              inBatch={interaction.inBatch.has(comment.id)}
              focusRequest={
                interaction.commentNavigation?.id === comment.id
                  ? interaction.commentNavigation.request
                  : undefined
              }
              interaction={interaction}
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
  onSubmit,
  onCancel,
}: {
  readonly range: ReviewSourceRange
  readonly onSubmit: (body: string) => Promise<void>
  readonly onCancel: () => void
}): ReactElement {
  const [body, setBody] = useState('')
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
      <label>
        <span>{lineRangeLabel(range)}</span>
        <textarea
          ref={textarea}
          aria-label="New review comment"
          value={body}
          onChange={(event) => setBody(event.currentTarget.value)}
        />
      </label>
      <div>
        <button type="submit" disabled={body.trim().length === 0}>
          Add comment
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
  inBatch,
  focusRequest,
  interaction,
}: {
  readonly comment: DocumentReviewComment
  readonly inBatch: boolean
  readonly focusRequest?: number
  readonly interaction: DocumentReviewInteraction
}): ReactElement {
  const [editing, setEditing] = useState(false)
  const [body, setBody] = useState(comment.body)
  const card = useRef<HTMLLIElement>(null)
  useEffect(() => setBody(comment.body), [comment.body])
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
      {editing ? (
        <form
          onSubmit={(event) => {
            event.preventDefault()
            interaction.edit(comment.id, body)
            setEditing(false)
          }}
        >
          <textarea
            autoFocus
            aria-label={`Edit comment at ${lineRangeLabel(comment.anchor.range)}`}
            value={body}
            onChange={(event) => setBody(event.currentTarget.value)}
          />
          <button type="submit" disabled={body.trim().length === 0}>
            Save comment
          </button>
          <button type="button" onClick={() => setEditing(false)}>
            Cancel
          </button>
        </form>
      ) : (
        <p>{comment.body}</p>
      )}
      <div className="document-review-comment-actions">
        {comment.lifecycle === 'draft' ? (
          <>
            <button
              type="button"
              aria-label={`Edit comment at ${lineRangeLabel(comment.anchor.range)}`}
              onClick={() => setEditing(true)}
            >
              Edit
            </button>
            <button
              type="button"
              aria-label={`Re-anchor comment at ${lineRangeLabel(comment.anchor.range)}`}
              disabled={interaction.dirty}
              title={
                interaction.dirty
                  ? 'Save or reload before re-anchoring'
                  : 'Choose a new source location'
              }
              onClick={() => interaction.beginReanchor(comment.id)}
            >
              Re-anchor
            </button>
            <button
              type="button"
              aria-label={`${inBatch ? 'Remove' : 'Add'} comment at ${lineRangeLabel(comment.anchor.range)} ${inBatch ? 'from' : 'to'} review batch`}
              disabled={staleUnreviewed && !inBatch}
              title={
                staleUnreviewed && !inBatch
                  ? 'Acknowledge or re-anchor this stale comment before batching it'
                  : undefined
              }
              onClick={() => interaction.toggleBatch(comment.id)}
            >
              {inBatch ? 'Remove from batch' : 'Add to batch'}
            </button>
            <button
              type="button"
              aria-label={`Preview handoff for comment at ${lineRangeLabel(comment.anchor.range)}`}
              disabled={staleUnreviewed}
              title={
                staleUnreviewed
                  ? 'Acknowledge or re-anchor this stale comment before previewing it'
                  : 'Choose an exact live terminal and preview the handoff'
              }
              onClick={() => interaction.delivery.previewComment(comment.id)}
            >
              Preview handoff
            </button>
            {staleUnreviewed ? (
              <button
                type="button"
                aria-label={`Acknowledge stale location for comment at ${lineRangeLabel(comment.anchor.range)}`}
                onClick={() => interaction.reviewStale(comment.id)}
              >
                Acknowledge stale location
              </button>
            ) : null}
            <button
              type="button"
              aria-label={`Remove comment at ${lineRangeLabel(comment.anchor.range)}`}
              onClick={() => interaction.remove(comment.id)}
            >
              Remove
            </button>
          </>
        ) : null}
        {comment.lifecycle === 'sent' ? (
          <button
            type="button"
            aria-label={`Resolve comment at ${lineRangeLabel(comment.anchor.range)}`}
            onClick={() => interaction.resolve(comment.id)}
          >
            Resolve
          </button>
        ) : null}
      </div>
      {inBatch ? (
        <span className="document-review-batch-state">
          {staleUnreviewed ? 'In batch · excluded while stale' : 'In review batch'}
        </span>
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
        {state.reviewed ? ' · acknowledged' : ''}
      </span>
    )
  }
  return <span className="review-anchor-state current">Current</span>
}

function rangesOverlap(left: ReviewSourceRange, right: ReviewSourceRange): boolean {
  return left.startLine <= right.endLine && right.startLine <= left.endLine
}
