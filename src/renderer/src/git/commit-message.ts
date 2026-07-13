import type { GitCommitDetail } from '../../../shared'

export function commitMessageBody(detail: GitCommitDetail): string {
  const message = normalizeLineEndings(detail.message).trim()
  const subject = normalizeLineEndings(detail.subject).trim()
  if (!message || message === subject) return ''
  if (subject && message.startsWith(`${subject}\n`)) {
    return message.slice(subject.length).trim()
  }
  return message
}

function normalizeLineEndings(value: string): string {
  return value.replace(/\r\n?/g, '\n')
}
