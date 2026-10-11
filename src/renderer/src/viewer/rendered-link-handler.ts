import type { MouseEvent } from 'react'

import { resolveRenderedLink, type HostPath } from '../../../shared'
import { resolveRenderedDirectoryLink } from '../../../shared/rendered-link'

export function handleRenderedLinkClick(
  event: MouseEvent<HTMLDivElement>,
  documentPath: HostPath,
  onOpenPath?: (path: HostPath) => void,
  baseKind: 'document' | 'directory' = 'document',
): void {
  if (!(event.target instanceof Element)) return
  const anchor = event.target.closest<HTMLAnchorElement>('a[href]')
  if (!anchor || !event.currentTarget.contains(anchor)) return
  const href = anchor.getAttribute('href')
  if (!href) return

  const target =
    baseKind === 'directory'
      ? resolveRenderedDirectoryLink(documentPath, href)
      : resolveRenderedLink(documentPath, href)
  event.preventDefault()
  if (target.kind === 'file') {
    onOpenPath?.(target.path)
  } else if (target.kind === 'blocked') {
    window.alert('Cannot open document link: invalid path or another host')
  } else if (target.kind === 'external') {
    window.open(target.url, '_blank', 'noopener,noreferrer')
  } else if (target.kind === 'anchor') {
    const destination = [
      ...event.currentTarget.querySelectorAll<HTMLElement>('[id]'),
    ].find((element) => element.id === target.fragment)
    destination?.scrollIntoView({ block: 'start' })
  }
}
