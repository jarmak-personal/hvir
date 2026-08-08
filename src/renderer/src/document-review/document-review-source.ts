import { StateField, type EditorState, type Extension } from '@codemirror/state'
import {
  Decoration,
  EditorView,
  GutterMarker,
  WidgetType,
  gutter,
  keymap,
  type DecorationSet,
} from '@codemirror/view'

import type { DocumentReviewComment, ReviewSourceRange } from './document-review-types'

export interface DocumentReviewSourceProjection {
  readonly active: boolean
  readonly dirty: boolean
  readonly comments: readonly DocumentReviewComment[]
  readonly inlineRange?: ReviewSourceRange
  readonly onInlineHost: (host: HTMLElement) => () => void
  readonly onRange: (range?: ReviewSourceRange) => void
  readonly onCapture: (range: ReviewSourceRange) => void
  readonly onOpenComment: (comment: DocumentReviewComment) => void
  readonly onExit: () => void
}

export function createDocumentReviewSourceExtensions(
  projection?: DocumentReviewSourceProjection,
): Extension {
  if (!projection || (!projection.active && projection.comments.length === 0)) return []
  const commentsByLine = groupCommentsByStartLine(projection.comments)
  const reviewDecorations = StateField.define<DecorationSet>({
    create: (state) => sourceReviewDecorations(state, projection),
    update: (decorations, transaction) =>
      transaction.docChanged
        ? sourceReviewDecorations(transaction.state, projection)
        : decorations,
    provide: (field) => EditorView.decorations.from(field),
  })
  return [
    reviewDecorations,
    reviewGutter(commentsByLine, projection),
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
  projection: DocumentReviewSourceProjection,
): DecorationSet {
  const ranges = projection.comments.flatMap((comment) => {
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
  const inlineLine = projection.inlineRange?.startLine
  if (inlineLine) {
    const line = state.doc.line(Math.min(inlineLine, state.doc.lines))
    ranges.push(
      Decoration.widget({
        block: true,
        side: 1,
        widget: new InlineReviewWidget(projection.onInlineHost),
      }).range(line.to),
    )
  }
  return Decoration.set(ranges, true)
}

class InlineReviewWidget extends WidgetType {
  private unregister?: () => void
  private observer?: ResizeObserver
  private frame?: number

  constructor(private readonly register: (host: HTMLElement) => () => void) {
    super()
  }

  override toDOM(view: EditorView): HTMLElement {
    const host = document.createElement('div')
    host.className = 'document-review-inline-host document-review-inline-host-source'
    host.setAttribute('data-review-inline-host', '')
    const fitToVisibleSource = (): void => {
      const gutterWidth =
        view.dom.querySelector<HTMLElement>('.cm-gutters')?.getBoundingClientRect()
          .width ?? 0
      const width = Math.floor(view.scrollDOM.clientWidth - gutterWidth - 24)
      if (width <= 0) return
      const nextWidth = `${width}px`
      if (host.style.width !== nextWidth) host.style.width = nextWidth
    }
    fitToVisibleSource()
    this.unregister = this.register(host)
    if (typeof ResizeObserver !== 'undefined') {
      this.observer = new ResizeObserver(() => {
        fitToVisibleSource()
        view.requestMeasure()
      })
      this.observer.observe(host)
      this.observer.observe(view.scrollDOM)
    }
    this.frame = requestAnimationFrame(() => {
      fitToVisibleSource()
      view.requestMeasure()
    })
    return host
  }

  override ignoreEvent(): boolean {
    return true
  }

  override destroy(): void {
    this.unregister?.()
    this.observer?.disconnect()
    if (this.frame !== undefined) cancelAnimationFrame(this.frame)
  }
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
  projection: DocumentReviewSourceProjection,
): Extension {
  return gutter({
    class: projection.active
      ? 'cm-review-gutter cm-review-gutter-active'
      : 'cm-review-gutter',
    renderEmptyElements: projection.active,
    lineMarker(view, block) {
      const comments = commentsByLine.get(view.state.doc.lineAt(block.from).number)
      return comments ? new ReviewGutterMarker(comments) : null
    },
    domEventHandlers: {
      mousedown(view, block, event) {
        if (!(event instanceof MouseEvent) || event.button !== 0) return false
        const line = view.state.doc.lineAt(block.from).number
        const comments = commentsByLine.get(line)
        if (
          event.target instanceof Element &&
          event.target.closest('.cm-review-marker')
        ) {
          const comment = comments?.[0]
          if (!comment) return false
          event.preventDefault()
          projection.onOpenComment(comment)
          return true
        }
        if (!projection.active || projection.dirty) return false
        event.preventDefault()
        projection.onCapture({ startLine: line, endLine: line })
        return true
      },
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
