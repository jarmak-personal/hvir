import type { EditorState, Extension } from '@codemirror/state'
import {
  Decoration,
  EditorView,
  GutterMarker,
  gutter,
  keymap,
  type DecorationSet,
} from '@codemirror/view'

import type { DocumentReviewComment, ReviewSourceRange } from './document-review-types'

export interface DocumentReviewSourceProjection {
  readonly active: boolean
  readonly dirty: boolean
  readonly comments: readonly DocumentReviewComment[]
  readonly onRange: (range?: ReviewSourceRange) => void
  readonly onExit: () => void
}

export function createDocumentReviewSourceExtensions(
  projection?: DocumentReviewSourceProjection,
): Extension {
  if (!projection) return []
  const commentsByLine = groupCommentsByStartLine(projection.comments)
  return [
    EditorView.decorations.of((view) =>
      sourceReviewDecorations(view.state, projection.comments),
    ),
    reviewGutter(commentsByLine),
    EditorView.updateListener.of((update) => {
      if (projection.active && (update.selectionSet || update.docChanged)) {
        projection.onRange(sourceReviewSelection(update.state))
      }
    }),
    keymap.of(
      projection.active
        ? [
            {
              key: 'Escape',
              preventDefault: true,
              run: () => {
                projection.onExit()
                return true
              },
            },
          ]
        : [],
    ),
    EditorView.contentAttributes.of({
      'aria-label': projection.active
        ? projection.dirty
          ? 'Markdown source review, capture unavailable until saved or reloaded'
          : 'Markdown source review'
        : 'Source viewer',
    }),
  ]
}

export function sourceReviewSelection(state: EditorState): ReviewSourceRange {
  const selection = state.selection.main
  const startLine = state.doc.lineAt(selection.from).number
  let endOffset = selection.to
  if (
    selection.to > selection.from &&
    selection.to > 0 &&
    state.doc.lineAt(selection.to).from === selection.to
  ) {
    endOffset -= 1
  }
  return { startLine, endLine: state.doc.lineAt(endOffset).number }
}

function sourceReviewDecorations(
  state: EditorState,
  comments: readonly DocumentReviewComment[],
): DecorationSet {
  const ranges = comments.flatMap((comment) => {
    if (comment.anchor.range.startLine > state.doc.lines) return []
    const start = state.doc.line(comment.anchor.range.startLine)
    const end = state.doc.line(Math.min(comment.anchor.range.endLine, state.doc.lines))
    const attributes = {
      class: `cm-review-anchor ${reviewStateClass(comment)}`,
      title: reviewStateLabel(comment),
    }
    return start.from === end.to
      ? [Decoration.line({ attributes }).range(start.from)]
      : [Decoration.mark({ attributes }).range(start.from, end.to)]
  })
  return Decoration.set(ranges, true)
}

function groupCommentsByStartLine(
  comments: readonly DocumentReviewComment[],
): ReadonlyMap<number, readonly DocumentReviewComment[]> {
  const grouped = new Map<number, DocumentReviewComment[]>()
  for (const comment of comments) {
    const line = comment.anchor.range.startLine
    grouped.set(line, [...(grouped.get(line) ?? []), comment])
  }
  return grouped
}

class ReviewGutterMarker extends GutterMarker {
  constructor(private readonly comments: readonly DocumentReviewComment[]) {
    super()
  }

  override toDOM(): HTMLElement {
    const marker = document.createElement('span')
    const states = [...new Set(this.comments.map(reviewStateLabel))]
    marker.className = `cm-review-marker ${this.comments.map(reviewStateClass).join(' ')}`
    marker.textContent = this.comments.some(
      (comment) => comment.anchor.state.status === 'stale',
    )
      ? '!'
      : this.comments.some((comment) => comment.anchor.state.status === 'moved')
        ? '↗'
        : String(this.comments.length)
    marker.setAttribute(
      'aria-label',
      `${this.comments.length} review ${this.comments.length === 1 ? 'note' : 'notes'}: ${states.join(', ')}`,
    )
    marker.title = states.join(', ')
    return marker
  }
}

function reviewGutter(
  commentsByLine: ReadonlyMap<number, readonly DocumentReviewComment[]>,
): Extension {
  return gutter({
    class: 'cm-review-gutter',
    lineMarker(view, block) {
      const comments = commentsByLine.get(view.state.doc.lineAt(block.from).number)
      return comments ? new ReviewGutterMarker(comments) : null
    },
  })
}

function reviewStateClass(comment: DocumentReviewComment): string {
  return `review-${comment.lifecycle} review-anchor-${comment.anchor.state.status}`
}

function reviewStateLabel(comment: DocumentReviewComment): string {
  const anchor = comment.anchor.state
  if (anchor.status === 'stale') return `${comment.lifecycle}, stale (${anchor.reason})`
  if (anchor.status === 'moved') return `${comment.lifecycle}, moved`
  return `${comment.lifecycle}, current`
}
