import type { MouseEvent } from 'react'

import { resolveRenderedLink, type HostPath } from '../../../shared'

export function handleRenderedLinkClick(
  event: MouseEvent<HTMLDivElement>,
  documentPath: HostPath,
  onOpenPath?: (path: HostPath) => void,
): void {
  if (!(event.target instanceof Element)) return
  const anchor = event.target.closest<HTMLAnchorElement>('a[href]')
  if (!anchor || !event.currentTarget.contains(anchor)) return
  const href = anchor.getAttribute('href')
  if (!href) return

  const target = resolveRenderedLink(documentPath, href)
  event.preventDefault()
  if (target.kind === 'file') {
    onOpenPath?.(target.path)
  } else if (target.kind === 'external') {
    window.open(target.url, '_blank', 'noopener,noreferrer')
  } else if (target.kind === 'anchor') {
    const destination = [
      ...event.currentTarget.querySelectorAll<HTMLElement>('[id]'),
    ].find((element) => element.id === target.fragment)
    destination?.scrollIntoView({ block: 'start' })
  }
}
