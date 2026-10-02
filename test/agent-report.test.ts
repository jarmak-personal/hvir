import { describe, expect, it } from 'vitest'
import { AgentReportOwner } from '../src/main/viewer/agent-report-owner'
import { AGENT_LIMITS } from '../src/shared/agent/contract'
import { localPath } from '../src/shared/host-path'
import { renderMarkdownDocument } from '../src/renderer/src/viewer/markdown-renderer'
import { resolveRenderedDirectoryLink } from '../src/shared/rendered-link'

describe('viewer-owned agent reports', () => {
  it('retains content after caller exit and replaces only an exact handle and host-qualified workspace', () => {
    const reports = new AgentReportOwner(() => undefined),
      root = localPath('/workspace')
    const published = reports.publish(
      'first',
      'workspace',
      root,
      'Findings',
      'markdown',
      '# first',
    )
    expect(reports.snapshot()[0]).not.toHaveProperty('content')
    expect(reports.read(published.id).content).toBe('# first')
    expect(() =>
      reports.publish('second', 'workspace', root, 'Second', 'text', 'bad', published.id),
    ).toThrow('handle')
    expect(() =>
      reports.publish('second', 'other', root, 'Second', 'text', 'bad', published.handle),
    ).toThrow('target')
    expect(
      reports.publish(
        'second',
        'workspace',
        root,
        'Second',
        'text',
        'replacement',
        published.handle,
      ).id,
    ).toBe(published.id)
    expect(reports.read(published.id)).toMatchObject({
      content: 'replacement',
      version: 2,
      unread: true,
    })
    reports.viewed(published.id, 1)
    expect(reports.read(published.id).unread).toBe(true)
    reports.viewed(published.id, 2)
    expect(reports.read(published.id).unread).toBe(false)
    reports.close(published.id)
    expect(() => reports.read(published.id)).toThrow('closed')
    expect(() =>
      reports.publish(
        'third',
        'workspace',
        root,
        'Third',
        'text',
        'bad',
        published.handle,
      ),
    ).toThrow('handle')
  })
  it('refuses capacity without eviction and releases content on workspace closure', () => {
    const reports = new AgentReportOwner(() => undefined),
      root = localPath('/workspace')
    for (let index = 0; index < AGENT_LIMITS.reportsPerConnection; index++)
      reports.publish('one', 'workspace', root, 'Report', 'text', 'kept')
    expect(() =>
      reports.publish('one', 'workspace', root, 'Overflow', 'text', 'bad'),
    ).toThrow('capacity')
    expect(() =>
      reports.publish(
        'two',
        'workspace',
        root,
        'Oversized',
        'text',
        '界'.repeat(AGENT_LIMITS.reportBytes),
      ),
    ).toThrow('byte')
    expect(reports.snapshot()).toHaveLength(AGENT_LIMITS.reportsPerConnection)
    reports.retainWorkspaces(new Set())
    expect(reports.snapshot()).toEqual([])
  })
  it('renders inert automatic resources while preserving explicit root-qualified human links', async () => {
    const html = await renderMarkdownDocument(
      '![file](file:///etc/passwd) ![network](https://example.invalid/pixel)\n\n[Read](src/a.ts)\n<script>alert(1)</script>',
      'dark',
      { load: () => Promise.resolve(undefined) },
      'inert',
    )
    expect(html).not.toContain('<img')
    expect(html).not.toContain('<script>')
    expect(html).toContain('src/a.ts')
    expect(resolveRenderedDirectoryLink(localPath('/workspace'), 'src/a.ts')).toEqual({
      kind: 'file',
      path: localPath('/workspace/src/a.ts'),
    })
  })
})
