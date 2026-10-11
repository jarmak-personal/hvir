import { describe, expect, it, vi } from 'vitest'
import { DocumentMarkdownOwner } from '../src/main/viewer/document-markdown-owner'
import { renderMarkdownDocument } from '../src/shared/presentation/document-markdown/rendering'
import { SELECTED_MARKDOWN_LIMITS } from '../src/shared/presentation/document-markdown/contract'
import { sourceFixture } from './fixtures/extension-source'
function barrier() {
  let resume!: (value: string | null) => void
  return {
    promise: new Promise<string | null>((resolve) => {
      resume = resolve
    }),
    resume: (value: string | null) => resume(value),
  }
}
describe('document-owned selected Markdown parsing', () => {
  it('shares safe parsing policy while keeping selected links/resources inert and instructions complete', async () => {
    const html = await renderMarkdownDocument(
      '# Current\n\n<script>alert(1)</script>\n\n[external](https://example.com) [fragment](#current) ![diagram](images/diagram.png)\n\n```js\nconst current = true\n```',
      'dark',
      { load: () => Promise.resolve(undefined) },
      'selected',
    )
    expect(html).toContain('&lt;script&gt;')
    expect(html).not.toContain('<script>')
    expect(html).not.toContain('href="https://')
    expect(html).toContain('href="#current"')
    expect(html).toContain('data-instruction-image="images/diagram.png"')
    expect(html).not.toContain('<img')
    expect(html).toContain('const current = true')
    expect(html).toContain('data-source-line')
  })
  it('admits one lazy physical parse and holds admission until its actual RPC settles', async () => {
    const b = barrier(),
      worker = { render: vi.fn(() => b.promise), dispose: vi.fn() },
      create = vi.fn(() => worker),
      owner = new DocumentMarkdownOwner(create)
    expect(create).not.toHaveBeenCalled()
    const pending = owner.render('current')
    await expect(owner.render('newer')).rejects.toThrow(/already pending/)
    expect(create).toHaveBeenCalledTimes(1)
    expect(worker.render).toHaveBeenCalledTimes(1)
    b.resume('<p>current</p>')
    await expect(pending).resolves.toBe('<p>current</p>')
    owner.dispose()
    await expect(owner.render('new')).rejects.toThrow(/closed/)
    expect(create).toHaveBeenCalledTimes(1)
    expect(worker.dispose).toHaveBeenCalledTimes(1)
  })
  it('does not replace a disposed-but-unsettled process and refuses late publication', async () => {
    const b = barrier(),
      worker = { render: vi.fn(() => b.promise), dispose: vi.fn() },
      create = vi.fn(() => worker),
      owner = new DocumentMarkdownOwner(create)
    const pending = owner.render('current'),
      rejected = expect(pending).rejects.toThrow(/closed/)
    owner.dispose()
    owner.dispose()
    await expect(owner.render('new')).rejects.toThrow(/closed/)
    b.resume('<p>late</p>')
    await rejected
    expect(create).toHaveBeenCalledTimes(1)
    expect(worker.dispose).toHaveBeenCalledTimes(1)
  })
  it('bounds text and rendered output without calling partial HTML complete', async () => {
    const worker = {
        render: vi.fn(() =>
          Promise.resolve('x'.repeat(SELECTED_MARKDOWN_LIMITS.htmlBytes + 1)),
        ),
        dispose: vi.fn(),
      },
      owner = new DocumentMarkdownOwner(() => worker)
    await expect(
      owner.render('x'.repeat(SELECTED_MARKDOWN_LIMITS.textBytes + 1)),
    ).rejects.toThrow(/input/)
    expect(worker.render).not.toHaveBeenCalled()
    await expect(owner.render('complete')).resolves.toBeNull()
    owner.dispose()
  })
  it('retains the physical parse under source revocation and denies a late derived receipt', async () => {
    const b = barrier(),
      worker = { render: vi.fn(() => b.promise), dispose: vi.fn() },
      owner = new DocumentMarkdownOwner(() => worker),
      f = sourceFixture('application', owner)
    try {
      await f.grant()
      const selected = (await f.reading.select(f.caller, {
        source: 'source',
        path: f.path,
      })) as { receipt: string }
      const parsing = f.reading.render(f.caller, { receipt: selected.receipt }),
        rejected = expect(parsing).rejects.toThrow()
      await vi.waitFor(() => expect(worker.render).toHaveBeenCalledTimes(1))
      await f.approvals.revoke('installation', 'source')
      await expect(owner.render('new')).rejects.toThrow(/pending/)
      b.resume('<p>late</p>')
      await rejected
      expect(() => f.reading.read(f.caller, { receipt: selected.receipt })).toThrow(
        /stale/,
      )
    } finally {
      f.dispose()
    }
  })
})
