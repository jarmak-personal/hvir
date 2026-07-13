export interface GitGraphLaneMetrics {
  readonly laneWidth: number
  readonly padding: number
}

export const FULL_GRAPH_LANE_METRICS: GitGraphLaneMetrics = {
  laneWidth: 18,
  padding: 9,
}

export const RAIL_GRAPH_LANE_METRICS: GitGraphLaneMetrics = {
  laneWidth: 12,
  padding: 5,
}

export function gitGraphWidth(laneCount: number, metrics: GitGraphLaneMetrics): number {
  return Math.max(2, laneCount) * metrics.laneWidth + metrics.padding * 2
}
