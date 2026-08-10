import { createContext, useContext } from 'react'

import type { ReviewSourceRange } from './document-review-types'

export type RegisterDocumentReviewInlineHost = (host: HTMLElement) => () => void

export const DocumentReviewInlineHostContext =
  createContext<RegisterDocumentReviewInlineHost>(() => () => undefined)

export function useDocumentReviewInlineHostRegistration(): RegisterDocumentReviewInlineHost {
  return useContext(DocumentReviewInlineHostContext)
}

export function lineRangeLabel(range: ReviewSourceRange): string {
  return range.startLine === range.endLine
    ? `Line ${range.startLine}`
    : `Lines ${range.startLine}–${range.endLine}`
}
