import { useEffect, useRef, useState, type ReactElement } from 'react'

import type { DocumentReviewComment, ReviewSourceRange } from './document-review-types'
import type { DocumentReviewInteraction } from './use-document-review-interaction'
import { DocumentReviewDeliveryPanel } from './DocumentReviewDeliveryPanel'

export function DocumentReviewToolbar({
  interaction,
  mode,
}: {
  readonly interaction: DocumentReviewInteraction
  readonly mode?: 'rendered' | 'source' | 'diff'
}): ReactElement | null {
  if (!interaction.available && interaction.comments.length === 0) return null
  return (
    <div className="document-review-toolbar" role="group" aria-label="Document review">
      <button
        type="button"
        className={interaction.active ? 'active' : ''}
        aria-label={
          interaction.active ? 'Exit Markdown review mode' : 'Enter Markdown review mode'
        }
        aria-pressed={interaction.active}
        disabled={!interaction.available}
        title="Markdown review mode"
        onClick={interaction.toggle}
      >
        Review{interaction.comments.length > 0 ? ` ${interaction.comments.length}` : ''}
      </button>
      {interaction.active && mode === 'source' ? (
        <button
          type="button"
          aria-label="Add comment for selected source lines"
          disabled={interaction.dirty || !interaction.sourceRange}
          title={
            interaction.dirty
              ? 'Save or reload before capturing a source range'
              : interaction.sourceRange
                ? `Add comment for ${lineRangeLabel(interaction.sourceRange)}`
                : 'Choose a source line or range first'
          }
          onClick={interaction.captureSource}
        >
          {interaction.reanchorCommentId ? 'Set anchor' : 'Add source comment'}
        </button>
      ) : null}
    </div>
  )
}

export function DocumentReviewPanel({
  interaction,
}: {
  readonly interaction: DocumentReviewInteraction
}): ReactElement | null {
  if (!interaction.active) return null
  return (
    <aside className="document-review-panel" aria-label="Markdown review comments">
      <header>
        <strong>Document review</strong>
        <span aria-label={`${interaction.comments.length} comments`}>
          {interaction.comments.length}
        </span>
        {interaction.activeBatchId ? (
          <button
            type="button"
            aria-label={`Preview review batch with ${interaction.activeBatchCount} comments`}
            onClick={() =>
              interaction.delivery.previewBatch(interaction.activeBatchId!)
            }
          >
            Preview batch {interaction.activeBatchCount}
          </button>
        ) : null}
        {interaction.historyCount > 0 ? (
          <button
            type="button"
            aria-label={`Clear ${interaction.historyCount} sent and resolved review ${interaction.historyCount === 1 ? 'comment' : 'comments'} from this workspace`}
            onClick={interaction.clearHistory}
          >
            Clear history {interaction.historyCount}
          </button>
        ) : null}
      </header>
      {interaction.dirty ? (
        <p className="document-review-guidance" role="status">
          Save or reload before adding or re-anchoring comments. Existing notes remain
          tied to the on-disk snapshot.
        </p>
      ) : null}
      {interaction.reanchorCommentId ? (
        <p className="document-review-guidance" role="status">
          Choose a rendered block or source range for the new anchor.
          <button type="button" onClick={interaction.cancelCapture}>
            Cancel
          </button>
        </p>
      ) : null}
      {interaction.error ? (
        <p className="document-review-error" role="alert">
          {interaction.error}
        </p>
      ) : null}
      {interaction.pendingRange ? (
        <NewCommentForm
          range={interaction.pendingRange}
          onSubmit={interaction.submit}
          onCancel={interaction.cancelCapture}
        />
      ) : null}
      <DocumentReviewDeliveryPanel delivery={interaction.delivery} />
      {interaction.comments.length === 0 && !interaction.pendingRange ? (
        <p className="document-review-empty">
          Choose a rendered block or a source line range to add feedback.
        </p>
      ) : null}
      <ol className="document-review-comments">
        {interaction.comments.map((comment) => (
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
    </aside>
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

function lineRangeLabel(range: ReviewSourceRange): string {
  return range.startLine === range.endLine
    ? `Line ${range.startLine}`
    : `Lines ${range.startLine}–${range.endLine}`
}
