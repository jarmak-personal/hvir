import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it, vi } from 'vitest'

import { WebPane, type WebViewState } from '../src/renderer/src/dashboards/WebPane'
import type { WebPaneSurfaceProps } from '../src/renderer/src/dashboards/web-pane-surface'
import { localPath } from '../src/shared'

describe('WebPaneSurface seam', () => {
  it('renders product chrome against a fake surface without an Electron webview', () => {
    let received: WebPaneSurfaceProps | undefined
    const FakeSurface = (props: WebPaneSurfaceProps) => {
      received = props
      return createElement('div', { 'data-fake-web-pane-surface': props.paneId })
    }
    const view: WebViewState = {
      id: 'c53b63f6-28bd-43ee-a6a6-fd4fdba0f9c8',
      title: 'Agent dashboard',
      url: 'http://localhost:5173/reef?tab=1',
      origin: 'http://localhost:5173',
      partition: 'hvir-web-pane-c53b63f6-28bd-43ee-a6a6-fd4fdba0f9c8',
      workspaceRoot: localPath('/tmp/hvir'),
      sourceTerminalId: 'terminal-1',
    }

    const markup = renderToStaticMarkup(
      createElement(WebPane, {
        view,
        focused: false,
        onToggleFocus: vi.fn(),
        onTitle: vi.fn(),
        onBlockedNavigation: vi.fn(),
        onOpenBrowser: vi.fn(),
        onRevealTerminal: vi.fn(),
        Surface: FakeSurface,
      }),
    )

    expect(markup).toContain('data-fake-web-pane-surface')
    expect(markup).not.toContain('<webview')
    expect(markup).toContain('http://localhost:5173')
    expect(received).toEqual(
      expect.objectContaining({
        paneId: view.id,
        partition: view.partition,
        initialUrl: view.url,
      }),
    )
  })
})
