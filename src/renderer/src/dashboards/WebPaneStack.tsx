import type { ReactElement } from 'react'

import { hostPathEquals, type HostPath } from '../../../shared'
import { WebPane, type WebViewState } from './WebPane'

export function WebPaneStack({
  views,
  root,
  active,
  activeId,
  focused,
  onToggleFocus,
  onTitle,
  onBlockedNavigation,
  onOpenBrowser,
  onRevealTerminal,
}: {
  readonly views: readonly WebViewState[]
  readonly root: HostPath
  readonly active: boolean
  readonly activeId?: string
  readonly focused: boolean
  readonly onToggleFocus: () => void
  readonly onTitle: (id: string, title: string) => void
  readonly onBlockedNavigation: (id: string) => void
  readonly onOpenBrowser: (id: string, url: string) => void
  readonly onRevealTerminal: (view: WebViewState) => void
}): ReactElement {
  return (
    <>
      {views.map((view) => (
        // Visibility-based hiding: display:none breaks <webview> guests, so
        // inactive panes collapse to zero height instead.
        <div
          className={`workspace-view${
            hostPathEquals(view.workspaceRoot, root) && active && activeId === view.id
              ? ''
              : ' web-view-hidden'
          }`}
          key={view.id}
        >
          <WebPane
            view={view}
            focused={hostPathEquals(view.workspaceRoot, root) && focused}
            onToggleFocus={onToggleFocus}
            onTitle={(title) => onTitle(view.id, title)}
            onBlockedNavigation={() => onBlockedNavigation(view.id)}
            onOpenBrowser={(url) => onOpenBrowser(view.id, url)}
            onRevealTerminal={() => onRevealTerminal(view)}
          />
        </div>
      ))}
    </>
  )
}
