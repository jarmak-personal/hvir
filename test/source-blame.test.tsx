// @vitest-environment happy-dom

import { act } from 'react'
import { createRoot } from 'react-dom/client'
import { describe, expect, it, vi } from 'vitest'
import { useSourceBlame } from '../src/renderer/src/viewer/use-source-blame'
import { localPath, type GitBlameRun, type HostPath, type ViewMode } from '../src/shared'

describe('source blame request lifetime', () => {
  it('ignores a replaced path and a source request revoked by a mode change', async () => {
    const pending: Array<(runs: readonly GitBlameRun[]) => void> = []
    const invoke = vi.fn(
      () => new Promise<readonly GitBlameRun[]>((resolve) => pending.push(resolve)),
    )
    Object.defineProperty(window, 'hvir', { configurable: true, value: { invoke } })
    const host = document.createElement('div')
    const root = createRoot(host)
    function Probe({ path, mode }: { path: HostPath; mode: ViewMode }) {
      const { blame, blameStatus } = useSourceBlame(path, mode, true, 0, 0)
      return (
        <output>
          {blameStatus}:{blame[0]?.author}
        </output>
      )
    }
    const first = localPath('/repo/first.ts')
    const second = localPath('/repo/second.ts')
    const third = localPath('/repo/third.ts')
    const run = (author: string): GitBlameRun => ({
      author,
      hash: 'abcdef123456',
      summary: 'fixture',
      startLine: 1,
      lineCount: 1,
    })
    try {
      act(() => root.render(<Probe path={first} mode="source" />))
      act(() => root.render(<Probe path={second} mode="source" />))
      await act(async () => {
        pending[1]?.([run('current')])
        await Promise.resolve()
      })
      expect(host.textContent).toBe('1 blamed lines · 1 runs:current')
      await act(async () => {
        pending[0]?.([run('obsolete')])
        await Promise.resolve()
      })
      expect(host.textContent).toBe('1 blamed lines · 1 runs:current')
      act(() => root.render(<Probe path={third} mode="source" />))
      act(() => root.render(<Probe path={third} mode="rendered" />))
      await act(async () => {
        pending[2]?.([run('revoked')])
        await Promise.resolve()
      })
      expect(host.textContent).not.toContain('revoked')
      expect(invoke.mock.calls).toHaveLength(3)
    } finally {
      act(() => root.unmount())
      host.remove()
    }
  })
})
