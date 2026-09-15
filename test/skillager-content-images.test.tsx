// @vitest-environment happy-dom
import { act } from 'react'
import { createRoot } from 'react-dom/client'
import { expect, it, vi } from 'vitest'
import { SkillagerReviewContent } from '../src/renderer/src/skillager/SkillagerReviewContent'
import { renderMarkdown } from '../src/renderer/src/viewer/markdown-client'
import { localPath } from '../src/shared/host-path'
import type { SkillagerReviewContent as Content } from '../src/shared/skillager-review'
vi.mock('../src/renderer/src/viewer/markdown-client', () => ({
  renderMarkdown: vi.fn(),
  useMarkdownRendererGeneration: () => 0,
}))
it('loads every valid image within the content lane and releases blobs; external/escaping links never read', async () => {
  const node = document.createElement('div'),
    root = createRoot(node)
  document.body.append(node)
  const created = vi
    .spyOn(URL, 'createObjectURL')
    .mockImplementation(() => `blob:image-${Math.random()}`)
  const revoked = vi.spyOn(URL, 'revokeObjectURL').mockImplementation(() => {})
  const content: Content = {
    entry: 'SKILL.md',
    path: localPath('/library/skills/example/SKILL.md'),
    size: 1,
    text: '# Images',
  }
  vi.mocked(renderMarkdown).mockResolvedValue(
    Array.from({ length: 9 }, (_, n) => `<img src="image-${n}.png">`).join('') +
      '<img src="https://example.invalid/a.png"><img src="../outside.png"><a href="../secret.md">outside</a><a href="guide.md">guide</a>',
  )
  let active = 0,
    peak = 0
  const asset = vi.fn(async (_id: string, _document: string, entry: string) => {
    active++
    peak = Math.max(peak, active)
    await Promise.resolve()
    active--
    return {
      ok: true as const,
      value: {
        entry,
        path: localPath('/library/skills/example/' + entry),
        size: 1,
        image: { mime: 'image/png', bytes: Uint8Array.of(1) },
      },
    }
  })
  const open = vi.fn()
  try {
    await act(async () => {
      root.render(
        <SkillagerReviewContent
          id="ordinary"
          content={content}
          source={false}
          navigation={{ root: localPath('/library/skills/example'), asset, open }}
        />,
      )
      await Promise.resolve()
    })
    expect(asset).toHaveBeenCalledTimes(9)
    expect(peak).toBe(1)
    expect(node.querySelectorAll('img[src^="blob:"]')).toHaveLength(9)
    const links = node.querySelectorAll('a')
    act(() => links[0]!.click())
    expect(open).not.toHaveBeenCalled()
    act(() => links[1]!.click())
    expect(open).toHaveBeenCalledWith('ordinary', 'guide.md')
    await act(async () => {
      root.unmount()
      await Promise.resolve()
    })
    expect(revoked).toHaveBeenCalledTimes(created.mock.calls.length)
  } finally {
    node.remove()
    vi.restoreAllMocks()
  }
})
it('stops scheduling images when the selected body is removed', async () => {
  const node = document.createElement('div'),
    root = createRoot(node)
  document.body.append(node)
  vi.mocked(renderMarkdown).mockResolvedValue(
    '<img src="first.png"><img src="second.png">',
  )
  let finish!: (value: undefined) => void
  const asset = vi.fn(
    () =>
      new Promise<undefined>((resolve) => {
        finish = resolve
      }),
  )
  await act(async () => {
    root.render(
      <SkillagerReviewContent
        id="ordinary"
        content={{
          entry: 'SKILL.md',
          path: localPath('/library/skills/example/SKILL.md'),
          size: 1,
          text: 'images',
        }}
        source={false}
        navigation={{ asset, open: () => {} }}
      />,
    )
    await Promise.resolve()
  })
  expect(asset).toHaveBeenCalledTimes(1)
  await act(async () => {
    root.unmount()
    await Promise.resolve()
  })
  await act(async () => {
    finish(undefined)
    await Promise.resolve()
  })
  expect(asset).toHaveBeenCalledTimes(1)
  node.remove()
})
