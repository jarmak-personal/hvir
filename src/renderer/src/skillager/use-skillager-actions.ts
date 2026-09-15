import { useCallback, useEffect, useRef, useState } from 'react'
import type { SkillagerMetadata } from '../../../shared/skillager'
import type { ExposureAction } from './skillager-exposure-model'

export type SkillagerActionSurface = 'sidebar' | 'details'
interface MenuRequest {
  readonly id: number
  readonly x: number
  readonly y: number
  readonly metadata: SkillagerMetadata
  readonly surface: SkillagerActionSurface
  readonly trigger: HTMLElement
  readonly context: string
}
interface Options {
  readonly context: string
  readonly sidebarVisible: boolean
  readonly detailsVisible: boolean
  readonly blocked: boolean
  readonly onSelect: (metadata: SkillagerMetadata, action: ExposureAction) => void
}
/** One request owns the Skills menu across rows and detail surfaces. */
export function useSkillagerActions(options: Options) {
  const [request, setRequest] = useState<MenuRequest>()
  const requestRef = useRef(request)
  requestRef.current = request
  const optionsRef = useRef(options)
  optionsRef.current = options
  const serial = useRef(0)
  const current = useCallback((at: MenuRequest): boolean => {
    const now = optionsRef.current
    return (
      at.context === now.context &&
      !now.blocked &&
      at.trigger.isConnected &&
      (at.surface === 'sidebar' ? now.sidebarVisible : now.detailsVisible)
    )
  }, [])
  const dismiss = useCallback((restoreFocus = false) => {
    const at = requestRef.current
    requestRef.current = undefined
    setRequest(undefined)
    if (restoreFocus && at?.trigger.isConnected) at.trigger.focus()
  }, [])
  useEffect(() => {
    if (request && !current(request)) dismiss()
  }, [
    request,
    options.context,
    options.sidebarVisible,
    options.detailsVisible,
    options.blocked,
    current,
    dismiss,
  ])
  const open = useCallback(
    (
      metadata: SkillagerMetadata,
      surface: SkillagerActionSurface,
      trigger: HTMLElement,
      point?: { x: number; y: number },
    ) => {
      const bounds = trigger.getBoundingClientRect()
      const at = {
        id: ++serial.current,
        x: point?.x ?? bounds.left,
        y: point?.y ?? bounds.bottom,
        metadata,
        surface,
        trigger,
        context: optionsRef.current.context,
      }
      if (!current(at)) return
      requestRef.current = at
      setRequest(at)
    },
    [current],
  )
  const select = useCallback(
    (action: ExposureAction) => {
      const at = requestRef.current
      if (!at || !current(at)) {
        dismiss()
        return
      }
      dismiss(true)
      optionsRef.current.onSelect(at.metadata, action)
    },
    [current, dismiss],
  )
  return { request, current, open, dismiss, select }
}
