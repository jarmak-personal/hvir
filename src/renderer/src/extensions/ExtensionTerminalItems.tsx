import { useCallback, useEffect, useRef, useState, type ReactElement } from 'react'
import { createPortal } from 'react-dom'
import type { ExtensionView } from '../../../shared/extensions/workbench'
import { useViewportContextMenuPosition } from '../context-menu/viewport-context-menu'
import { ElectronExtensionGuestSurface } from './ElectronExtensionGuestSurface'
import { ExtensionViewPane } from './ExtensionViewStack'
import {
  useContributionDemand,
  useExtensionContributions,
} from './extension-contribution-context'

/** Data-only rail controls: terminal focus, attention, rendering and input stay terminal-owned. */
export function ExtensionTerminalItems({
  placement,
  terminalId,
  active,
}: {
  readonly placement: 'header' | 'session'
  readonly terminalId?: string
  readonly active: boolean
}): ReactElement | null {
  const model = useExtensionContributions()
  const session = terminalId
    ? model?.sessions.find((session) => model.terminalIds[session.id] === terminalId)
    : undefined
  const [popup, setPopup] = useState<{
    view: ExtensionView
    anchor: { id: number; x: number; y: number }
    returnFocus: HTMLElement
  }>()
  const popupRef = useRef<HTMLDivElement>(null)
  const generation = useRef(0)
  const currentPopup = useRef(popup)
  currentPopup.current = popup
  const entries =
    model?.state.flatMap((extension) =>
      (extension.manifest.railItems ?? [])
        .filter((item) => item.placement === placement)
        .map((item) => ({ extension, item })),
    ) ?? []
  const demandActive =
    active &&
    !model?.topActive &&
    !!model?.foreground &&
    !model.obscured &&
    (!terminalId || !!session)
  useContributionDemand(
    `rail:${model?.workspaceId}:${terminalId ?? 'header'}`,
    demandActive
      ? entries.map(({ extension, item }) => ({
          installationId: extension.installationId,
          contributionId: item.id,
          surface: 'rail',
          workspaceId: model?.workspaceId,
          ...(session ? { sessionId: session.id } : {}),
        }))
      : [],
  )
  const close = useCallback((restore = true): void => {
    generation.current++
    const current = currentPopup.current
    setPopup(undefined)
    if (current) {
      void window.hvir
        .invoke('extensions:close-view', { viewId: current.view.id })
        .catch(() => undefined)
      if (restore && current.returnFocus.isConnected)
        current.returnFocus.focus({ preventScroll: true })
    }
  }, [])
  const currentView = popup
    ? model?.views.find((view) => view.id === popup.view.id)
    : undefined
  const popupDeclared =
    !popup ||
    entries.some((entry) => entry.extension.installationId === popup.view.installationId)
  useEffect(() => {
    if (popup && (!currentView || currentView.failure)) close()
    else if (!demandActive || !popupDeclared) close(false)
  }, [demandActive, popupDeclared, currentView, popup, close])
  useEffect(
    () => () => {
      close(false)
    },
    [close],
  )
  useEffect(() => {
    if (!popup) return
    popupRef.current
      ?.querySelector<HTMLButtonElement>('button')
      ?.focus({ preventScroll: true })
    const keyboard = (event: KeyboardEvent): void => {
      if (event.key !== 'Escape') return
      event.preventDefault()
      event.stopPropagation()
      close()
    }
    const pointer = (event: PointerEvent): void => {
      if (
        !popupRef.current?.contains(event.target as Node) &&
        !popup.returnFocus.contains(event.target as Node)
      )
        close(false)
    }
    document.addEventListener('keydown', keyboard, true)
    document.addEventListener('pointerdown', pointer, true)
    return () => {
      document.removeEventListener('keydown', keyboard, true)
      document.removeEventListener('pointerdown', pointer, true)
    }
  }, [popup, close])
  const position = useViewportContextMenuPosition(popupRef, popup?.anchor)
  if (!model || !active || !entries.length) return null
  return (
    <span className="extension-terminal-items">
      {entries.map(({ extension, item }) => {
        const value =
          extension.values.find(
            (value) => value.item === item.id && value.session === session?.id,
          ) ?? extension.values.find((value) => value.item === item.id && !value.session)
        const availability =
          item.kind === 'observation'
            ? (value?.availability ?? (extension.error ? 'failed' : 'stale'))
            : undefined
        const tooltip = `${value?.tooltip ?? item.tooltip}${availability ? ` · ${availability}` : ''}${extension.error ? ` · ${extension.error}` : ''}`
        return (
          <button
            key={`${extension.installationId}:${item.id}`}
            type="button"
            className="terminal-icon-button"
            title={tooltip}
            aria-label={tooltip}
            aria-haspopup={item.click.placement === 'popup' ? 'dialog' : undefined}
            disabled={!!terminalId && !session}
            onClick={(event) => {
              event.stopPropagation()
              close(false)
              const opening = ++generation.current
              const button = event.currentTarget,
                bounds = button.getBoundingClientRect()
              void model
                .open(extension.installationId, item.click.view, {
                  surface: item.click.placement === 'popup' ? 'popup' : 'viewer',
                  workspaceId: model.workspaceId,
                  ...(session ? { sessionId: session.id } : {}),
                })
                .then((view) => {
                  if (item.click.placement !== 'popup') return
                  if (generation.current !== opening) {
                    void window.hvir.invoke('extensions:close-view', { viewId: view.id })
                    return
                  }
                  setPopup({
                    view,
                    anchor: { id: opening, x: bounds.left, y: bounds.bottom },
                    returnFocus: button,
                  })
                })
                .catch(() => undefined)
            }}
          >
            <span aria-hidden="true">{value?.icon ?? item.icon}</span>
            {value?.label ?? item.label}
          </button>
        )
      })}
      {popup && currentView
        ? createPortal(
            <div
              ref={popupRef}
              className="extension-item-popup"
              role="dialog"
              aria-label={popup.view.title}
              style={position}
            >
              <ExtensionViewPane
                view={currentView}
                visible={demandActive}
                onClose={close}
                Surface={ElectronExtensionGuestSurface}
              />
            </div>,
            document.body,
          )
        : null}
    </span>
  )
}
