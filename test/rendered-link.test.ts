import MarkdownIt from 'markdown-it'
import { describe, expect, it } from 'vitest'

import { localPath, resolveRenderedLink } from '../src/shared'
import { isSafeExternalUrl, isWorkbenchDocument } from '../src/main/navigation-policy'
import { MARKDOWN_OPTIONS } from '../src/renderer/src/viewer/render-protocol'

describe('rendered document links', () => {
  const document = localPath('/repo/docs/plan/00-overview.md')

  it('resolves relative and parent paths on the same host', () => {
    expect(resolveRenderedLink(document, '04-ssh-hosts.md')).toMatchObject({
      kind: 'file',
      path: localPath('/repo/docs/plan/04-ssh-hosts.md'),
    })
    expect(resolveRenderedLink(document, '../design.md#architecture')).toEqual({
      kind: 'file',
      path: localPath('/repo/docs/design.md'),
      fragment: 'architecture',
    })
  })

  it('keeps anchors internal and explicit web links external', () => {
    expect(resolveRenderedLink(document, '#goal')).toEqual({
      kind: 'anchor',
      fragment: 'goal',
    })
    expect(resolveRenderedLink(document, 'https://example.test/docs')).toEqual({
      kind: 'external',
      url: 'https://example.test/docs',
    })
  })

  it('blocks executable and malformed schemes', () => {
    expect(resolveRenderedLink(document, 'javascript:alert(1)')).toEqual({
      kind: 'blocked',
    })
    expect(resolveRenderedLink(document, '%E0%A4%A')).toEqual({ kind: 'blocked' })
  })

  it('does not turn bare repository filenames into web hosts', () => {
    const markdown = new MarkdownIt(MARKDOWN_OPTIONS)
    expect(markdown.render('Read design.md first.')).not.toContain('<a ')
    expect(markdown.render('[design](design.md)')).toContain('href="design.md"')
  })
})

describe('workbench navigation policy', () => {
  it('allows entry reloads but not relative-link replacement documents', () => {
    const entry = 'http://localhost:5173/'
    expect(isWorkbenchDocument('http://localhost:5173/?reload=1', entry)).toBe(true)
    expect(isWorkbenchDocument('http://localhost:5173/design.md', entry)).toBe(false)
    expect(isWorkbenchDocument('http://design.md/', entry)).toBe(false)
  })

  it('only delegates explicit browser-safe external schemes', () => {
    expect(isSafeExternalUrl('https://example.test')).toBe(true)
    expect(isSafeExternalUrl('mailto:hello@example.test')).toBe(true)
    expect(isSafeExternalUrl('file:///etc/passwd')).toBe(false)
    expect(isSafeExternalUrl('javascript:alert(1)')).toBe(false)
  })
})
