import { describe, expect, it } from 'vitest'

import { commitMessageBody } from '../src/renderer/src/git/commit-message'
import type { GitCommitDetail } from '../src/shared'

describe('commit message body', () => {
  it('removes the duplicated subject before Markdown rendering', () => {
    expect(
      commitMessageBody(
        detail(
          'Bump dependency',
          'Bump dependency\n\n- [Release notes](https://example.com)',
        ),
      ),
    ).toBe('- [Release notes](https://example.com)')
  })

  it('omits a message that contains only its subject', () => {
    expect(commitMessageBody(detail('Tidy history', 'Tidy history'))).toBe('')
  })

  it('removes the subject from CRLF commit messages', () => {
    expect(
      commitMessageBody(detail('Windows subject', 'Windows subject\r\n\r\n- body')),
    ).toBe('- body')
  })

  it('preserves bodies whose first line differs from the parsed subject', () => {
    expect(commitMessageBody(detail('Subject', 'Context before subject\n\nMore'))).toBe(
      'Context before subject\n\nMore',
    )
  })
})

function detail(subject: string, message: string): GitCommitDetail {
  return {
    hash: '0123456789abcdef',
    shortHash: '0123456',
    parents: [],
    refs: [],
    author: 'hvir',
    authoredAt: '2026-07-13T00:00:00Z',
    subject,
    message,
    files: [],
  }
}
