import type { GitCommitSummary } from '../../../shared'

export interface GitGraphSegment {
  readonly fromLane: number
  readonly toLane: number
  /** The segment ends at the commit node rather than the next row. */
  readonly incoming: boolean
  readonly color: number
}

export interface GitGraphRow {
  readonly commit: GitCommitSummary
  readonly lane: number
  readonly color: number
  readonly passthrough: readonly { readonly lane: number; readonly color: number }[]
  readonly segments: readonly GitGraphSegment[]
}

export interface GitGraphLayout {
  readonly rows: readonly GitGraphRow[]
  readonly laneCount: number
}

interface ActiveLane {
  readonly target: string
  readonly color: number
}

/**
 * Assign stable lanes to a topologically ordered commit stream. The model is
 * intentionally renderer-neutral: the SVG layer only paints the visible rows.
 */
export function buildGitGraphLayout(
  commits: readonly GitCommitSummary[],
): GitGraphLayout {
  const lanes: Array<ActiveLane | undefined> = []
  const rows: GitGraphRow[] = []
  let nextColor = 0
  let laneCount = 1

  for (const commit of commits) {
    const matchingLanes: number[] = []
    for (let lane = 0; lane < lanes.length; lane += 1) {
      if (lanes[lane]?.target === commit.hash) matchingLanes.push(lane)
    }

    const commitLane = matchingLanes[0] ?? firstOpenLane(lanes)
    const commitColor = lanes[commitLane]?.color ?? nextColor++
    if (!lanes[commitLane]) {
      lanes[commitLane] = { target: commit.hash, color: commitColor }
    }

    const passthrough = lanes.flatMap((active, lane) =>
      active && active.target !== commit.hash ? [{ lane, color: active.color }] : [],
    )
    const segments: GitGraphSegment[] = matchingLanes.map((lane) => ({
      fromLane: lane,
      toLane: commitLane,
      incoming: true,
      color: lanes[lane]?.color ?? commitColor,
    }))

    for (const lane of matchingLanes.slice(1)) lanes[lane] = undefined
    lanes[commitLane] = undefined

    commit.parents.forEach((parent, parentIndex) => {
      let parentLane = lanes.findIndex((active) => active?.target === parent)
      let parentColor = parentLane >= 0 ? lanes[parentLane]?.color : undefined
      if (parentLane < 0) {
        parentLane = parentIndex === 0 ? commitLane : firstOpenLane(lanes)
        parentColor = parentIndex === 0 ? commitColor : nextColor++
        lanes[parentLane] = { target: parent, color: parentColor }
      }
      segments.push({
        fromLane: commitLane,
        toLane: parentLane,
        incoming: false,
        color: parentColor ?? commitColor,
      })
    })

    while (lanes.length > 0 && lanes.at(-1) === undefined) lanes.pop()
    laneCount = Math.max(laneCount, commitLane + 1, lanes.length)
    rows.push({
      commit,
      lane: commitLane,
      color: commitColor,
      passthrough,
      segments,
    })
  }

  return { rows, laneCount }
}

function firstOpenLane(lanes: readonly (ActiveLane | undefined)[]): number {
  const open = lanes.findIndex((lane) => lane === undefined)
  return open < 0 ? lanes.length : open
}
