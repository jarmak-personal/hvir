import type { GitCommitDetail, HostPath, HvirApi } from '../../../shared'

const MAX_CACHED_DETAILS = 200
const detailCache = new Map<string, GitCommitDetail>()
const pendingDetails = new Map<string, Promise<GitCommitDetail>>()

export function loadCommitDetail(root: HostPath, hash: string): Promise<GitCommitDetail> {
  const key = commitDetailKey(root, hash)
  const cached = detailCache.get(key)
  if (cached) {
    detailCache.delete(key)
    detailCache.set(key, cached)
    return Promise.resolve(cached)
  }
  const pending = pendingDetails.get(key)
  if (pending) return pending

  const rendererWindow = (
    globalThis as unknown as { readonly window: { readonly hvir: HvirApi } }
  ).window
  const request = rendererWindow.hvir.invoke('git:commit-detail', { root, hash })
  pendingDetails.set(key, request)
  void request.then(
    (detail) => {
      if (pendingDetails.get(key) === request) pendingDetails.delete(key)
      detailCache.set(key, detail)
      while (detailCache.size > MAX_CACHED_DETAILS) {
        const oldestKey = detailCache.keys().next().value
        if (oldestKey === undefined) break
        detailCache.delete(oldestKey)
      }
    },
    () => {
      if (pendingDetails.get(key) === request) pendingDetails.delete(key)
    },
  )
  return request
}

function commitDetailKey(root: HostPath, hash: string): string {
  return `${root.hostId}\0${root.path}\0${hash}`
}
