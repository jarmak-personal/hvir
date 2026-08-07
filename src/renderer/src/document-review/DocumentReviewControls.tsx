import type { ReactElement } from 'react'

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
          {interaction.reanchorCommentId ? 'Set anchor' : 'Add source comment'}
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
  if (!interaction.active) return null
  const showTray = Boolean(
    interaction.activeBatchId ||
    interaction.historyCount > 0 ||
    interaction.reanchorCommentId ||
    interaction.error,
  )
  return (
    <aside className="document-review-chrome" aria-label="Markdown review comments">
      {showTray ? (
        <div className="document-review-tray">
          {interaction.reanchorCommentId ? (
            <span className="document-review-guidance" role="status">
              Choose a new rendered block or source range.
              <button type="button" onClick={interaction.cancelCapture}>
                Cancel
              </button>
            </span>
          ) : null}
          {interaction.error ? (
            <span className="document-review-error" role="alert">
              {interaction.error}
            </span>
          ) : null}
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
        </div>
      ) : null}
      <DocumentReviewDeliveryPanel delivery={interaction.delivery} />
    </aside>
  )
}
