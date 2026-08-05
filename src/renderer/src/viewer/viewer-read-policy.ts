import type { ViewerWorkspaceModel } from './viewer-workspace-model'

export function isCurrentViewerRead(
  model: ViewerWorkspaceModel,
  action: {
    readonly id: string
    readonly workspaceGeneration: number
    readonly readGeneration: number
  },
): boolean {
  return (
    action.workspaceGeneration === model.generation &&
    model.readGenerations[action.id] === action.readGeneration
  )
}
