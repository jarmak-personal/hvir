/** A cleanup handle returned by subscriptions/watchers. May be async. */
export type Disposer = () => void | Promise<void>
