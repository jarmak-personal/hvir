export interface PageInfo {
  endCursor: string | null
  hasNextPage: boolean
}

export function nextPageCursor(pageInfo: PageInfo): string | null {
  if (!pageInfo.hasNextPage) return null
  if (pageInfo.endCursor === null) {
    throw new Error('GitHub returned a paginated connection without an end cursor.')
  }
  return pageInfo.endCursor
}
