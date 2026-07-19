export const PANE_DIVIDER_SIZE = 1

export function fitSplitPrimaryWidth(
  width: number,
  containerWidth: number,
  paneMinWidth: number,
): number {
  return Math.min(
    Math.max(paneMinWidth, width),
    Math.max(paneMinWidth, containerWidth - paneMinWidth - PANE_DIVIDER_SIZE),
  )
}
