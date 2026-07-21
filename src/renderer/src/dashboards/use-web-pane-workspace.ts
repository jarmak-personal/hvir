import { useCallback, useEffect, useRef, useState } from 'react'

import {
  hostPathEquals,
  unwrapOperation,
  type HostPath,
  type ProjectState,
} from '../../../shared'
import type { WebViewState } from './WebPane'
import { sanitizedWebPaneTitle } from './web-pane-workspace-policy'

export interface OpenWebLinkRequest {
  readonly terminalId: string
  readonly workspaceRoot: HostPath
  readonly url: string
}

export function useWebPaneWorkspace({
  onActivate,
  onError,
}: {
  readonly onActivate: () => void
  readonly onError: (message: string) => void
}) {
  const [views, setViews] = useState<readonly WebViewState[]>([])
  const [activeId, setActiveId] = useState<string>()
  const [active, setActive] = useState(false)
  const [focused, setFocused] = useState(false)
  const viewsRef = useRef(views)
  const activeIdRef = useRef(activeId)
  const activeRef = useRef(active)
  const rootRef = useRef<HostPath | undefined>(undefined)
  const selection = useRef(
    new Map<string, { readonly id?: string; readonly active: boolean }>(),
  )
  const portsRef = useRef({ onActivate, onError })
  viewsRef.current = views
  activeIdRef.current = activeId
  activeRef.current = active
  portsRef.current = { onActivate, onError }

  useEffect(() => {
    const disposeNavigation = window.hvir.on(
      'web-pane:navigation-blocked',
      (navigation) => {
        setViews((current) =>
          current.map((view) =>
            view.id === navigation.paneId
              ? { ...view, blockedNavigation: navigation }
              : view,
          ),
        )
      },
    )
    const disposeDiagnostic = window.hvir.on(
      'web-pane:diagnostic',
      ({ paneId, event }) => {
        setViews((current) =>
          current.map((view) =>
            view.id === paneId
              ? {
                  ...view,
                  routeDiagnostic: {
                    revision: (view.routeDiagnostic?.revision ?? 0) + 1,
                    event,
                  },
                }
              : view,
          ),
        )
      },
    )
    return () => {
      void disposeNavigation()
      void disposeDiagnostic()
    }
  }, [])

  useEffect(() => {
    window.hvir.send('web-pane:full-page', {
      paneId: focused && active ? activeId : undefined,
    })
  }, [active, activeId, focused])

  const applyProjectState = useCallback(
    (state: ProjectState, currentRoot: HostPath | undefined): boolean => {
      const liveWorkspaceKeys = new Set(
        state.projects.flatMap((project) =>
          project.workspaces.map((workspace) => webWorkspaceKey(workspace.root)),
        ),
      )
      setViews((current) =>
        current.filter((view) =>
          liveWorkspaceKeys.has(webWorkspaceKey(view.workspaceRoot)),
        ),
      )
      if (currentRoot && hostPathEquals(currentRoot, state.root)) return false
      if (currentRoot) {
        selection.current.set(webWorkspaceKey(currentRoot), {
          id: activeIdRef.current,
          active: activeRef.current,
        })
      }
      const nextSelection = selection.current.get(webWorkspaceKey(state.root))
      const selectedView = viewsRef.current.find(
        (view) =>
          view.id === nextSelection?.id && hostPathEquals(view.workspaceRoot, state.root),
      )
      setActiveId(selectedView?.id)
      setActive(Boolean(selectedView && nextSelection?.active))
      setFocused(false)
      return true
    },
    [],
  )

  const openView = useCallback((view: WebViewState): void => {
    const existing = viewsRef.current.find((candidate) => candidate.id === view.id)
    if (existing) {
      setViews((current) =>
        current.map((candidate) =>
          candidate.id === existing.id
            ? { ...candidate, url: view.url, blockedNavigation: undefined }
            : candidate,
        ),
      )
      setActiveId(existing.id)
    } else {
      setViews((current) => [...current, view])
      setActiveId(view.id)
    }
    setActive(true)
    portsRef.current.onActivate()
  }, [])

  const openLink = useCallback(
    (activation: OpenWebLinkRequest): void => {
      void (async () => {
        try {
          const opened = unwrapOperation(
            await window.hvir.invoke('web-pane:open', {
              source: 'terminal',
              root: activation.workspaceRoot,
              terminalId: activation.terminalId,
              url: activation.url,
            }),
          )
          openView({
            id: opened.paneId,
            title: new URL(opened.origin).host,
            url: opened.url,
            origin: opened.origin,
            partition: opened.partition,
            workspaceRoot: activation.workspaceRoot,
            sourceTerminalId: activation.terminalId,
          })
        } catch (reason) {
          portsRef.current.onError(errorMessage(reason))
        }
      })()
    },
    [openView],
  )

  const followBlockedNavigation = useCallback(
    (id: string): void => {
      const view = viewsRef.current.find((candidate) => candidate.id === id)
      const navigation = view?.blockedNavigation
      if (!view || !navigation) return
      setViews((current) =>
        current.map((candidate) =>
          candidate.id === id
            ? { ...candidate, blockedNavigation: undefined }
            : candidate,
        ),
      )
      if (navigation.kind === 'external') {
        void window.hvir
          .invoke('web-pane:open-external', { paneId: id, url: navigation.url })
          .catch((reason) => portsRef.current.onError(errorMessage(reason)))
        return
      }
      void (async () => {
        try {
          const opened = unwrapOperation(
            await window.hvir.invoke('web-pane:open', {
              source: 'pane',
              paneId: id,
              url: navigation.url,
            }),
          )
          openView({
            id: opened.paneId,
            title: new URL(opened.origin).host,
            url: opened.url,
            origin: opened.origin,
            partition: opened.partition,
            workspaceRoot: view.workspaceRoot,
            sourceTerminalId: view.sourceTerminalId,
          })
        } catch (reason) {
          portsRef.current.onError(errorMessage(reason))
        }
      })()
    },
    [openView],
  )

  const activateView = useCallback((id: string): void => {
    setActiveId(id)
    setActive(true)
    portsRef.current.onActivate()
  }, [])

  const closeView = useCallback((id: string): void => {
    void window.hvir.invoke('web-pane:close', { paneId: id }).catch(() => undefined)
    const remaining = viewsRef.current.filter((candidate) => candidate.id !== id)
    setViews(remaining)
    if (activeIdRef.current === id) {
      const fallback = remaining
        .filter(
          (view) =>
            rootRef.current && hostPathEquals(view.workspaceRoot, rootRef.current),
        )
        .at(-1)
      setActiveId(fallback?.id)
      if (!fallback) setActive(false)
    }
  }, [])

  const forgetTerminalViews = useCallback((terminalId: string): void => {
    const removed = new Set(
      viewsRef.current
        .filter((view) => view.sourceTerminalId === terminalId)
        .map((view) => view.id),
    )
    if (removed.size === 0) return
    const remaining = viewsRef.current.filter((view) => !removed.has(view.id))
    setViews(remaining)
    if (activeIdRef.current && removed.has(activeIdRef.current)) {
      const fallback = remaining
        .filter(
          (view) =>
            rootRef.current && hostPathEquals(view.workspaceRoot, rootRef.current),
        )
        .at(-1)
      setActiveId(fallback?.id)
      if (!fallback) setActive(false)
    }
  }, [])

  const setWorkspaceRoot = useCallback((root: HostPath): void => {
    rootRef.current = root
  }, [])

  const setTitle = useCallback((id: string, title: string): void => {
    const sanitized = sanitizedWebPaneTitle(title)
    setViews((current) =>
      current.map((candidate) =>
        candidate.id === id && candidate.title !== sanitized
          ? { ...candidate, title: sanitized }
          : candidate,
      ),
    )
  }, [])

  const openBrowser = useCallback((id: string, url: string): void => {
    void window.hvir
      .invoke('web-pane:open-browser', { paneId: id, url })
      .catch((reason) => portsRef.current.onError(errorMessage(reason)))
  }, [])

  return {
    views,
    activeId,
    active,
    activeRef,
    focused,
    setFocused,
    setActive,
    applyProjectState,
    setWorkspaceRoot,
    openLink,
    activateView,
    closeView,
    forgetTerminalViews,
    followBlockedNavigation,
    setTitle,
    openBrowser,
  }
}

function errorMessage(reason: unknown): string {
  return reason instanceof Error ? reason.message : String(reason)
}

function webWorkspaceKey(root: HostPath): string {
  return `${root.hostId}:${root.path}`
}
