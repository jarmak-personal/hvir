import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type ReactElement,
  type ReactNode,
} from 'react'
import type { ExtensionSessionContext } from '../../../shared/extensions/contract'
import type {
  ExtensionContributionState,
  ExtensionDemand,
  ExtensionSurfaceRequest,
  ExtensionView,
} from '../../../shared/extensions/workbench'
import { ExtensionViewPane } from './ExtensionViewStack'
import { ElectronExtensionGuestSurface } from './ElectronExtensionGuestSurface'
import {
  ExtensionContributionContext,
  useContributionDemand,
  useExtensionContributions,
} from './extension-contribution-context'
import { useExtensionForeground } from './use-extension-foreground'

/** Shared trusted data and presentation subscriptions; never executes package code. */
export function ExtensionContributionsProvider({
  children,
  workspaceId,
  views,
  onError,
  topActive,
  obscured,
  onTop,
  onWorkspace,
}: {
  readonly topActive: boolean
  readonly obscured: boolean
  readonly onTop: () => void
  readonly onWorkspace: () => void
  readonly children: ReactNode
  readonly workspaceId?: string
  readonly views: readonly ExtensionView[]
  readonly onError: (message: string) => void
}): ReactElement {
  const errorRef = useRef(onError)
  errorRef.current = onError
  const [topId, setTopId] = useState<string>()
  const selectedTop = views.find((view) => view.id === topId)
  const selectTop = useCallback(
    (view: ExtensionView): void => {
      setTopId(view.id)
      onTop()
    },
    [onTop],
  )
  useEffect(() => {
    if (!topId || selectedTop || !topActive) return
    // The open reply can precede its renderer publication. Only main can confirm removal.
    let current = true
    void window.hvir.invoke('extensions:views', undefined).then(
      (currentViews) => {
        if (current && !currentViews.some((view) => view.id === topId)) onWorkspace()
      },
      (reason: unknown) => {
        if (current)
          errorRef.current(
            reason instanceof Error ? reason.message : 'Extension view is unavailable',
          )
      },
    )
    return () => {
      current = false
    }
  }, [topId, selectedTop, topActive, onWorkspace, views])
  const [state, setState] = useState<readonly ExtensionContributionState[]>([])
  const [sessions, setSessions] = useState<readonly ExtensionSessionContext[]>([])
  const [terminalIds, setTerminalIds] = useState<Readonly<Record<string, string>>>({})
  const foreground = useExtensionForeground()
  const demands = useRef(new Map<string, readonly ExtensionDemand[]>())
  const demandPump = useRef({ running: false, dirty: false })
  const publishDemand = useCallback((): void => {
    const pump = demandPump.current
    pump.dirty = true
    if (pump.running) return
    pump.running = true
    queueMicrotask(() => {
      void (async () => {
        try {
          while (pump.dirty) {
            pump.dirty = false
            await window.hvir
              .invoke('extensions:demand', [...demands.current.values()].flat())
              .catch(() => undefined)
          }
        } finally {
          pump.running = false
        }
      })()
    })
  }, [])
  useEffect(() => {
    const currentDemands = demands.current
    let current = true,
      updated = false
    let refreshing = false,
      dirty = false
    const refresh = (): void => {
      dirty = true
      if (refreshing) return
      refreshing = true
      void (async () => {
        try {
          while (current && dirty) {
            dirty = false
            await window.hvir.invoke('extensions:context', undefined).then(
              (value) => {
                if (current) {
                  setSessions(value.sessions ?? [])
                  setTerminalIds(value.terminalIds)
                }
              },
              () => undefined,
            )
          }
        } finally {
          refreshing = false
        }
      })()
    }
    const dispose = window.hvir.on('extensions:contributions-changed', (value) => {
      if (!current) return
      updated = true
      setState(value)
      refresh()
    })
    const disposeActivation = window.hvir.on('extensions:state-changed', () => {
      // Reload revokes demand even when the replacement retains the same visible entries.
      if (current) publishDemand()
    })
    void window.hvir.invoke('extensions:contributions', undefined).then(
      (value) => {
        if (current && !updated) setState(value)
      },
      () => undefined,
    )
    refresh()
    return () => {
      current = false
      void dispose()
      void disposeActivation()
      currentDemands.clear()
      publishDemand()
    }
  }, [publishDemand])
  const demand = useCallback(
    (key: string, entries: readonly ExtensionDemand[]): (() => void) => {
      demands.current.set(key, entries)
      publishDemand()
      return () => {
        demands.current.delete(key)
        publishDemand()
      }
    },
    [publishDemand],
  )
  const open = useCallback(
    async (
      installationId: string,
      contributionId: string,
      context: ExtensionSurfaceRequest,
    ) => {
      try {
        return await window.hvir.invoke('extensions:open-view', {
          installationId,
          contributionId,
          context,
        })
      } catch (reason) {
        onError(
          reason instanceof Error ? reason.message : 'Extension view is unavailable',
        )
        throw reason
      }
    },
    [onError],
  )
  const close = useCallback((id: string): void => {
    void window.hvir
      .invoke('extensions:close-view', { viewId: id })
      .catch((reason: unknown) => {
        errorRef.current(
          reason instanceof Error ? reason.message : 'Extension view could not close',
        )
      })
  }, [])
  return (
    <ExtensionContributionContext.Provider
      value={{
        topActive,
        obscured,
        selectedTop,
        selectTop,
        close,
        closeTop: (id) => {
          close(id)
          if (id === topId) onWorkspace()
        },
        views,
        state,
        sessions,
        terminalIds,
        workspaceId,
        foreground,
        open,
        demand,
      }}
    >
      {children}
      {views
        .filter((view) => view.role === 'updater')
        .map((view) => (
          <div key={view.id} className="extension-updater" aria-hidden="true">
            <ExtensionViewPane
              view={view}
              visible={false}
              onClose={() => undefined}
              Surface={ElectronExtensionGuestSurface}
            />
          </div>
        ))}
    </ExtensionContributionContext.Provider>
  )
}

export function ExtensionTopDestination(): ReactElement | null {
  const model = useExtensionContributions()
  const selected = model?.selectedTop
  const views = model?.views ?? []
  const active = !!model?.topActive && !!model.foreground && !model.obscured
  useContributionDemand(
    'top',
    selected && active
      ? [
          {
            installationId: selected.installationId,
            contributionId: selected.contributionId,
            surface: 'top',
          },
        ]
      : [],
  )
  return (
    <main className="extension-top-destination" hidden={!model?.topActive}>
      {views
        .filter((view) => view.context?.surface === 'top')
        .map((view) => (
          <ExtensionViewPane
            key={view.id}
            view={view}
            selected={!!model?.topActive && !model.obscured && view.id === selected?.id}
            visible={active && view.id === selected?.id}
            onClose={() => model?.closeTop(view.id)}
            Surface={ElectronExtensionGuestSurface}
          />
        ))}
    </main>
  )
}

export function ExtensionTopRail(): ReactElement | null {
  const model = useExtensionContributions()
  const entries =
    model?.state.flatMap((extension) =>
      extension.manifest.views
        .filter((view) => view.navigation === 'top')
        .map((view) => ({ extension, view })),
    ) ?? []
  if (!model || !entries.length) return null
  return (
    <>
      {entries.map(({ extension, view }) => (
        <button
          key={`${extension.installationId}:${view.id}`}
          type="button"
          className="sessions-destination hvir-button"
          aria-current={
            model.topActive &&
            model.selectedTop?.installationId === extension.installationId &&
            model.selectedTop.contributionId === view.id
              ? 'page'
              : undefined
          }
          onClick={() => {
            void model
              .open(extension.installationId, view.id, { surface: 'top' })
              .then(model.selectTop)
              .catch(() => undefined)
          }}
        >
          {extension.navigationIcons?.[view.id] ? (
            <span
              aria-hidden="true"
              className="extension-navigation-icon"
              style={{ maskImage: `url("${extension.navigationIcons[view.id]}")` }}
            />
          ) : null}
          {view.title}
        </button>
      ))}
    </>
  )
}

export function ExtensionLeftRail({
  children,
  visible,
}: {
  readonly children: ReactNode
  readonly visible: boolean
}): ReactElement {
  const model = useExtensionContributions()
  const modelRef = useRef(model)
  modelRef.current = model
  const [selectedId, setSelectedId] = useState<string>()
  const selected = model?.views.find((view) => view.id === selectedId)
  const entries =
    model?.state.flatMap((extension) =>
      extension.manifest.views
        .filter((view) => view.navigation === 'left')
        .map((view) => ({ extension, view })),
    ) ?? []
  useEffect(() => {
    const current = modelRef.current
    const inaccessible = (current?.views ?? []).filter(
      (view) =>
        view.context?.surface === 'left' &&
        view.context.workspace?.id !== current?.workspaceId,
    )
    for (const view of inaccessible) current?.close(view.id)
    setSelectedId((id) => (inaccessible.some((view) => view.id === id) ? undefined : id))
  }, [model?.workspaceId, model?.close])
  useContributionDemand(
    'left',
    selected && visible && model?.foreground && !model.obscured
      ? [
          {
            installationId: selected.installationId,
            contributionId: selected.contributionId,
            surface: 'left',
            workspaceId: model.workspaceId,
          },
        ]
      : [],
  )
  return (
    <>
      {entries.length || selected ? (
        <nav className="rail-nav" aria-label="Extension project views">
          {entries.map(({ extension, view }) => (
            <button
              key={`${extension.installationId}:${view.id}`}
              type="button"
              aria-current={
                selected?.installationId === extension.installationId &&
                selected.contributionId === view.id
                  ? 'page'
                  : undefined
              }
              onClick={() => {
                if (model?.workspaceId)
                  void model
                    .open(extension.installationId, view.id, {
                      surface: 'left',
                      workspaceId: model.workspaceId,
                    })
                    .then((view) => {
                      if (view.context?.workspace?.id === modelRef.current?.workspaceId)
                        setSelectedId(view.id)
                      else modelRef.current?.close(view.id)
                    })
                    .catch(() => undefined)
              }}
              className="hvir-button"
            >
              {extension.navigationIcons?.[view.id] ? (
                <span
                  aria-hidden="true"
                  className="extension-navigation-icon"
                  style={{ maskImage: `url("${extension.navigationIcons[view.id]}")` }}
                />
              ) : null}
              {view.title}
            </button>
          ))}
          {selected ? (
            <button
              type="button"
              onClick={() => setSelectedId(undefined)}
              className="hvir-button"
            >
              Project views
            </button>
          ) : null}
        </nav>
      ) : null}
      <div className="extension-rail-builtins" hidden={!!selected}>
        {children}
      </div>
      {model?.views
        .filter((view) => view.context?.surface === 'left')
        .map((view) => (
          <ExtensionViewPane
            key={view.id}
            view={view}
            selected={view.id === selected?.id && visible && !model.obscured}
            visible={
              view.id === selected?.id && visible && model.foreground && !model.obscured
            }
            onClose={() => {
              model.close(view.id)
              setSelectedId(undefined)
            }}
            Surface={ElectronExtensionGuestSurface}
          />
        ))}
    </>
  )
}
