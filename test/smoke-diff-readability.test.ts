import type { BrowserWindow } from 'electron'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { localPath } from '../src/shared'
import type { ProjectHost } from '../src/main/project-host'
import { verifyDiffReadability } from '../src/main/smoke/diff-readability'
import { verifyDiffCopy } from '../src/main/smoke/diff-copy'

const native = vi.hoisted(() => {
  const data: {
    text?: string
    html?: string
    rtf?: string
    image?: unknown
    bookmark?: string
  } = {}
  return { image: { isEmpty: () => false }, data }
})
vi.mock('electron', () => ({
  clipboard: {
    readText: () => native.data.text ?? '',
    readHTML: () => native.data.html ?? '',
    readRTF: () => native.data.rtf ?? '',
    readImage: () => native.data.image ?? { isEmpty: () => true },
    readBookmark: () => ({
      title: native.data.bookmark ?? '',
      url: native.data.bookmark ? (native.data.text ?? '') : '',
    }),
    availableFormats: () => [
      ...('text' in native.data ? ['text/plain'] : []),
      ...('html' in native.data ? ['text/html'] : []),
      ...('rtf' in native.data ? ['text/rtf'] : []),
      ...('image' in native.data ? ['image/png'] : []),
    ],
    clear: () => {
      native.data = {}
    },
    write: (data: typeof native.data) => {
      native.data = data
    },
  },
}))
vi.mock('../src/main/smoke/diff-copy', () => ({ verifyDiffCopy: vi.fn() }))

beforeEach(() => {
  vi.clearAllMocks()
  native.data = {
    text: 'prior clipboard',
    html: '<b>prior clipboard</b>',
    rtf: '{\\rtf1 prior clipboard}',
    image: native.image,
  }
})

// This adapter-level suite proves restoration and partial-startup cleanup, not browser selection.
describe('diff readability owned resources', () => {
  it.each(
    ['success', 'presentation', 'copy', 'fixture-startup'].flatMap((outcome) =>
      ['text-only', 'rich'].map((kind) => ({ outcome, kind })),
    ),
  )(
    'restores the $kind clipboard and disposable Git/filesystem state after $outcome',
    async ({ outcome, kind }) => {
      if (kind === 'text-only') native.data = { text: 'prior clipboard' }
      const original = { ...native.data }
      const failure = new Error('named acceptance failure')
      const files = new Set<string>()
      const indexed = new Set<string>()
      let writes = 0
      const host = {
        writeFile: vi.fn<ProjectHost['writeFile']>(async (path) => {
          await Promise.resolve()
          files.add(path.path)
          if (outcome === 'fixture-startup' && ++writes === 2) throw failure
        }),
        exec: vi.fn<ProjectHost['exec']>(async (command, args) => {
          await Promise.resolve()
          const path = args.at(-1)!
          if (command === 'rm') files.delete(path)
          else if (args.includes('add')) indexed.add(path)
          else if (args.includes('update-index')) indexed.delete(path)
          return { code: 0, signal: null, stdout: '', stderr: '' }
        }),
      }
      const win = {
        isDestroyed: () => false,
        webContents: {
          isDestroyed: () => false,
          executeJavaScript: vi.fn().mockResolvedValue(undefined),
        },
      }
      // Reject the presentation action once; subsequent renderer cleanup can still run.
      if (outcome === 'presentation') {
        win.webContents.executeJavaScript.mockRejectedValueOnce(failure)
      }
      vi.mocked(verifyDiffCopy).mockImplementation(async () => {
        await Promise.resolve()
        native.data = { text: 'copied fixture' }
        if (outcome !== 'success') throw failure
      })
      const result = verifyDiffReadability(
        win as unknown as BrowserWindow,
        host,
        localPath('/fixture'),
        vi.fn(),
      )
      if (outcome === 'success') await expect(result).resolves.toContain('exact copy')
      else await expect(result).rejects.toBe(failure)
      expect(files.size).toBe(0)
      expect(indexed.size).toBe(0)
      expect(native.data).toEqual(original)
    },
  )

  it.each([
    {},
    { html: '<b>HTML only</b>' },
    { image: native.image },
    { text: '' },
    { html: '' },
    ...(process.platform === 'darwin'
      ? [{ text: 'https://example.test/page', bookmark: 'prior bookmark' }]
      : []),
  ])(
    'restores %o exactly after startup failure without introducing formats',
    async (original) => {
      native.data = original
      const host = {
        writeFile: vi
          .fn<ProjectHost['writeFile']>()
          .mockRejectedValue(new Error('startup failed')),
        exec: vi
          .fn<ProjectHost['exec']>()
          .mockResolvedValue({ code: 0, signal: null, stdout: '', stderr: '' }),
      }
      await expect(
        verifyDiffReadability({} as BrowserWindow, host, localPath('/fixture'), vi.fn()),
      ).rejects.toThrow('startup failed')
      expect(native.data).toEqual(original)
    },
  )
})
