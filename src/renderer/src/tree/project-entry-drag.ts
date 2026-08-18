import {
  basenameHostPath,
  containsHostPath,
  hostPathEquals,
  joinHostPath,
  type FileType,
  type HostPath,
  type ProjectFileOrganizationRequest,
} from '../../../shared'
import { fileActionDestination } from './file-action-destination'

export const PROJECT_ENTRY_DRAG_TYPE = 'application/x-hvir-project-entry'

export interface ProjectEntryDragSource {
  readonly source: HostPath
  readonly sourceType: FileType
}

export function canDragProjectEntry(
  root: HostPath,
  source: HostPath,
  sourceType: FileType,
): boolean {
  return (
    source.hostId === root.hostId &&
    containsHostPath(root, source) &&
    !hostPathEquals(root, source) &&
    (sourceType === 'file' || sourceType === 'dir' || sourceType === 'symlink')
  )
}

export function projectEntryDropRequest(
  root: HostPath,
  drag: ProjectEntryDragSource,
  target: HostPath,
  targetType: FileType,
): Extract<ProjectFileOrganizationRequest, { readonly action: 'move' }> | undefined {
  if (
    !canDragProjectEntry(root, drag.source, drag.sourceType) ||
    target.hostId !== root.hostId ||
    !containsHostPath(root, target) ||
    targetType === 'other'
  ) {
    return undefined
  }
  const destinationDirectory = fileActionDestination(root, target, targetType)
  if (
    !containsHostPath(root, destinationDirectory) ||
    (drag.sourceType === 'dir' && containsHostPath(drag.source, destinationDirectory))
  ) {
    return undefined
  }
  const destination = joinHostPath(
    destinationDirectory,
    basenameHostPath(drag.source),
  )
  if (hostPathEquals(drag.source, destination)) return undefined
  return {
    action: 'move',
    workspaceRoot: root,
    source: drag.source,
    destinationDirectory,
  }
}

export function isProjectEntryDrag(types: readonly string[]): boolean {
  return types.includes(PROJECT_ENTRY_DRAG_TYPE)
}
