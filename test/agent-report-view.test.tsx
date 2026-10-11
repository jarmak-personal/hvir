// @vitest-environment happy-dom
import { act } from 'react'
import { createRoot } from 'react-dom/client'
import { expect, it, vi } from 'vitest'
import { AgentReportView } from '../src/renderer/src/viewer/AgentReportView'
import type { AgentReport } from '../src/shared/agent/contract'
import { localPath } from '../src/shared/host-path'
vi.mock('../src/renderer/src/viewer/markdown-client', () => ({
  renderMarkdown: () => Promise.resolve('<p>Rendered</p>'),
  useMarkdownRendererGeneration: () => 0,
}))
it('never displays or acknowledges the new report using a previous or deferred content read', async () => {
  const first: AgentReport = {
    id: 'first',
    workspace: 'workspace',
    root: localPath('/first'),
    title: 'First',
    version: 1,
    format: 'text',
    content: 'first content',
    unread: true,
  }
  const second: AgentReport = {
    ...first,
    id: 'second',
    root: localPath('/second'),
    title: 'Second',
    content: 'second content',
  }
  let resolveSecond!: (value: AgentReport) => void
  const secondRead = new Promise<AgentReport>((resolve) => {
    resolveSecond = resolve
  })
  const invoke = vi.fn((channel: string, request: { id: string; version?: number }) =>
    channel === 'agent:report-read'
      ? request.id === first.id
        ? Promise.resolve(first)
        : secondRead
      : Promise.resolve(),
  )
  Object.defineProperty(window, 'hvir', { configurable: true, value: { invoke } })
  const container = document.createElement('div')
  document.body.append(container)
  const root = createRoot(container)
  try {
    await act(async () => {
      root.render(<AgentReportView report={first} visible onOpenPath={() => undefined} />)
      await Promise.resolve()
    })
    expect(container.textContent).toContain('first content')
    expect(invoke).toHaveBeenCalledWith('agent:report-viewed', {
      id: 'first',
      version: 1,
    })
    invoke.mockClear()
    await act(async () => {
      root.render(
        <AgentReportView report={second} visible onOpenPath={() => undefined} />,
      )
      await Promise.resolve()
    })
    expect(container.textContent).not.toContain('first content')
    expect(
      invoke.mock.calls.filter(([channel]) => channel === 'agent:report-viewed'),
    ).toEqual([])
    await act(async () => {
      resolveSecond({ ...second, version: 2, content: 'unseen replacement' })
      await Promise.resolve()
    })
    expect(container.textContent).not.toContain('unseen replacement')
    expect(
      invoke.mock.calls.filter(([channel]) => channel === 'agent:report-viewed'),
    ).toEqual([])
  } finally {
    act(() => root.unmount())
    container.remove()
  }
})
