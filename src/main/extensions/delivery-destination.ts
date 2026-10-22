import {
  containsHostPath,
  dirnameHostPath,
  hostPathEquals,
  joinHostPath,
  type HostPath,
} from '../../shared/host-path'
import { isProjectFileEntryName } from '../../shared/project-file-operations'
import { DELIVERY_LIMITS } from '../../shared/extensions/managed-delivery'
import type { DeliveryHost } from './delivery-tree'

/** Missing supporting parents are disclosed and journaled before their exclusive creation. */
export async function deliveryParents(
  host: DeliveryHost,
  root: HostPath,
  target: HostPath,
  current: () => void,
): Promise<HostPath[]> {
  if (
    containsHostPath(joinHostPath(root, '.hvir-delivery-retained'), target) ||
    !target.path.startsWith('/') ||
    hostPathEquals(root, target) ||
    !containsHostPath(root, target) ||
    target.path.split('/').some((part) => part === '.' || part === '..')
  )
    throw new Error('Delivery target must be an exact contained workspace child')
  if (
    !hostPathEquals(await host.realpath(root), root) ||
    (await host.stat(root)).type !== 'dir'
  )
    throw new Error('Granted delivery root changed')
  current()
  const parts = dirnameHostPath(target)
    .path.slice(root.path === '/' ? 1 : root.path.length + 1)
    .split('/')
    .filter(Boolean)
  if (parts.length > DELIVERY_LIMITS.depth) throw new Error('Delivery target is too deep')
  const missing: HostPath[] = []
  let path = root,
    absent = false
  for (const part of parts) {
    if (!isProjectFileEntryName(part)) throw new Error('Invalid delivery parent')
    path = joinHostPath(path, part)
    if (!absent) {
      try {
        if ((await host.stat(path)).type !== 'dir')
          throw new Error('Delivery traverses a link or non-directory')
      } catch (reason) {
        if ((reason as { code?: unknown }).code !== 'ENOENT') throw reason
        absent = true
      }
    }
    if (absent) missing.push(path)
    current()
  }
  return missing
}
