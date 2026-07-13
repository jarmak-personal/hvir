import type { ReactElement } from 'react'

import type { GitGraphRow } from './git-graph-layout'
import type { GitGraphLaneMetrics } from './git-graph-lane-metrics'

const GRAPH_COLORS = [
  '#69a7ff',
  '#dc8cff',
  '#5ed6a0',
  '#ffb45d',
  '#f2779f',
  '#6fd4e8',
] as const

export function GitGraphCell({
  row,
  width,
  height,
  metrics,
}: {
  readonly row: GitGraphRow
  readonly width: number
  readonly height: number
  readonly metrics: GitGraphLaneMetrics
}): ReactElement {
  const centerY = height / 2
  const laneX = (lane: number): number =>
    metrics.padding + lane * metrics.laneWidth + metrics.laneWidth / 2
  const curve = (fromLane: number, toLane: number, incoming: boolean): string => {
    const fromX = laneX(fromLane)
    const toX = laneX(toLane)
    if (incoming) {
      return `M ${fromX} 0 C ${fromX} ${centerY * 0.55}, ${toX} ${centerY * 0.55}, ${toX} ${centerY}`
    }
    return `M ${fromX} ${centerY} C ${fromX} ${centerY * 1.45}, ${toX} ${centerY * 1.45}, ${toX} ${height}`
  }

  return (
    <svg
      className="git-graph-lanes"
      width={width}
      height={height}
      viewBox={`0 0 ${width} ${height}`}
      aria-hidden="true"
    >
      {row.passthrough.map((line) => (
        <line
          key={`pass-${line.lane}`}
          x1={laneX(line.lane)}
          x2={laneX(line.lane)}
          y1={0}
          y2={height}
          stroke={graphColor(line.color)}
        />
      ))}
      {row.segments.map((segment, index) => (
        <path
          key={`${segment.incoming ? 'in' : 'out'}-${segment.fromLane}-${segment.toLane}-${index}`}
          d={curve(segment.fromLane, segment.toLane, segment.incoming)}
          stroke={graphColor(segment.color)}
        />
      ))}
      <circle
        cx={laneX(row.lane)}
        cy={centerY}
        r={4}
        fill="#15181e"
        stroke={graphColor(row.color)}
        strokeWidth={2.5}
      />
    </svg>
  )
}

export function GitGraphContinuation({
  row,
  width,
  height,
  metrics,
}: {
  readonly row: GitGraphRow
  readonly width: number
  readonly height: number
  readonly metrics: GitGraphLaneMetrics
}): ReactElement {
  const laneX = (lane: number): number =>
    metrics.padding + lane * metrics.laneWidth + metrics.laneWidth / 2
  return (
    <svg
      className="git-graph-lanes"
      width={width}
      height={height}
      viewBox={`0 0 ${width} ${height}`}
      aria-hidden="true"
    >
      {continuingLanes(row).map((line) => (
        <line
          key={line.lane}
          x1={laneX(line.lane)}
          x2={laneX(line.lane)}
          y1={0}
          y2={height}
          stroke={graphColor(line.color)}
        />
      ))}
    </svg>
  )
}

function continuingLanes(
  row: GitGraphRow,
): readonly { readonly lane: number; readonly color: number }[] {
  const lanes = new Map<number, number>()
  for (const line of row.passthrough) lanes.set(line.lane, line.color)
  for (const segment of row.segments) {
    if (!segment.incoming) lanes.set(segment.toLane, segment.color)
  }
  return [...lanes].map(([lane, color]) => ({ lane, color }))
}

function graphColor(index: number): string {
  return GRAPH_COLORS[index % GRAPH_COLORS.length] ?? GRAPH_COLORS[0]
}
