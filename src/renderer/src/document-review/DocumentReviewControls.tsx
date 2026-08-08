import { useEffect, useState, type ReactElement } from 'react'

import { ConfirmationDialog } from '../workbench/ConfirmationDialog'
import { DocumentReviewDeliveryPanel } from './DocumentReviewDeliveryPanel'
import { lineRangeLabel } from './document-review-inline'
import type { DocumentReviewInteraction } from './use-document-review-interaction'

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
          Add comment
        </button>
      ) : null}
    </div>
  )
}

export function DocumentReviewChrome({
  interaction,
}: {
  readonly interaction: DocumentReviewInteraction
}): ReactElement | null {
  const [confirmDiscard, setConfirmDiscard] = useState(false)
  useEffect(() => {
    if (!interaction.active || !interaction.activeBatchId) setConfirmDiscard(false)
  }, [interaction.active, interaction.activeBatchId])
  if (!interaction.active) return null
  const showTray = Boolean(
    interaction.activeBatchId ||
    interaction.historyCount > 0 ||
    interaction.dirty ||
    interaction.orphanedComments.length > 0 ||
    interaction.error ||
    interaction.delivery.loading ||
    interaction.delivery.notice ||
    interaction.delivery.error,
  )
  return (
    <aside className="document-review-chrome" aria-label="Markdown review comments">
      {showTray ? (
        <div className="document-review-tray">
          {interaction.dirty ? (
            <span className="document-review-guidance" role="status">
              Save or reload to add comments. Existing review stays on the saved version.
            </span>
          ) : null}
          {interaction.error ? (
            <span className="document-review-error" role="alert">
              {interaction.error}
            </span>
          ) : null}
          {!interaction.delivery.open && interaction.delivery.error ? (
            <span className="document-review-error" role="alert">
              {interaction.delivery.error}
            </span>
          ) : null}
          {interaction.delivery.notice ? (
            <span className="document-review-notice" role="status">
              {interaction.delivery.notice}
            </span>
          ) : null}
          {interaction.delivery.loading && !interaction.delivery.open ? (
            <span className="document-review-notice" role="status">
              Sending review…
            </span>
          ) : null}
          {interaction.orphanedComments.map((comment) => (
            <button
              key={comment.id}
              type="button"
              className="document-review-orphan"
              onClick={() => interaction.navigate(comment)}
            >
              Open unplaced comment · {lineRangeLabel(comment.anchor.range)}
            </button>
          ))}
          {interaction.activeBatchId ? (
            <button
              type="button"
              className="document-review-primary"
              aria-label={`Send ${interaction.activeBatchCount} review ${interaction.activeBatchCount === 1 ? 'comment' : 'comments'} to the top terminal`}
              disabled={
                interaction.delivery.loading || interaction.delivery.directHandoffBlocked
              }
              title={
                interaction.delivery.directHandoffBlocked
                  ? 'Review and prepare the feedback again before another send'
                  : 'Send to the first visible terminal'
              }
              onClick={() =>
                interaction.delivery.handoffBatch(interaction.activeBatchId!)
              }
            >
              Send review {interaction.activeBatchCount}
            </button>
          ) : null}
          {interaction.activeBatchId ? (
            <button
              type="button"
              aria-label={`Discard ${interaction.activeBatchCount} draft review ${interaction.activeBatchCount === 1 ? 'comment' : 'comments'}`}
              onClick={() => {
                if (
                  interaction.activeBatchCount > 1 ||
                  interaction.activeBatchDocumentCount > 1
                ) {
                  setConfirmDiscard(true)
                } else {
                  interaction.discardReview()
                }
              }}
            >
              Discard review
            </button>
          ) : null}
          {interaction.activeBatchId ? (
            <button
              type="button"
              aria-label={`Review and send ${interaction.activeBatchCount} comments`}
              onClick={() =>
                interaction.delivery.previewBatch(interaction.activeBatchId!)
              }
            >
              Review and send…
            </button>
          ) : null}
          {interaction.historyCount > 0 ? (
            <button
              type="button"
              aria-label={`Clear ${interaction.historyCount} sent and resolved review ${interaction.historyCount === 1 ? 'comment' : 'comments'} from this workspace`}
              onClick={interaction.clearHistory}
            >
              Clear sent review {interaction.historyCount}
            </button>
          ) : null}
        </div>
      ) : null}
      <DocumentReviewDeliveryPanel delivery={interaction.delivery} />
      {confirmDiscard ? (
        <ConfirmationDialog
          labelledBy="document-review-discard-title"
          actions={[
            {
              label: 'Cancel',
              kind: 'cancel',
              onSelect: () => setConfirmDiscard(false),
            },
            {
              label: 'Discard review',
              kind: 'destructive',
              onSelect: () => {
                setConfirmDiscard(false)
                interaction.discardReview()
              },
            },
          ]}
        >
          <h2 id="document-review-discard-title">Discard this review?</h2>
          <p>
            This removes {interaction.activeBatchCount} unsent review{' '}
            {interaction.activeBatchCount === 1 ? 'comment' : 'comments'} from this
            workspace.
          </p>
        </ConfirmationDialog>
      ) : null}
    </aside>
  )
}
