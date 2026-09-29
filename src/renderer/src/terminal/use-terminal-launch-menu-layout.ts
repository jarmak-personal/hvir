import {
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  type CSSProperties,
  type Dispatch,
  type RefObject,
  type SetStateAction,
} from 'react'

const MAX_LAUNCH_MENU_HEIGHT = 460
const VIEWPORT_GUTTER = 8

export function useTerminalLaunchMenuEscape(
  open: boolean,
  setOpen: Dispatch<SetStateAction<boolean>>,
): void {
  useEffect(() => {
    if (!open) return
    const close = (event: KeyboardEvent): void => {
      if (event.key === 'Escape') setOpen(false)
    }
    window.addEventListener('keydown', close)
    return () => window.removeEventListener('keydown', close)
  }, [open, setOpen])
}

export function useTerminalLaunchMenuLayout(open: boolean): {
  readonly menuRef: RefObject<HTMLDivElement | null>
  readonly menuStyle?: CSSProperties
} {
  const menuRef = useRef<HTMLDivElement>(null)
  const [maxHeight, setMaxHeight] = useState<number>()

  useLayoutEffect(() => {
    const menu = menuRef.current
    if (!open || !menu) return

    const fitToViewport = (): void => {
      const available = Math.max(
        0,
        window.innerHeight - menu.getBoundingClientRect().top - VIEWPORT_GUTTER,
      )
      setMaxHeight(Math.min(MAX_LAUNCH_MENU_HEIGHT, available))
    }
    fitToViewport()

    const rail = menu.closest('.terminal-rail')
    const observer = new ResizeObserver(fitToViewport)
    if (rail) observer.observe(rail)
    window.addEventListener('resize', fitToViewport)
    return () => {
      observer.disconnect()
      window.removeEventListener('resize', fitToViewport)
    }
  }, [open])

  return {
    menuRef,
    menuStyle: maxHeight === undefined ? undefined : { maxHeight },
  }
}
