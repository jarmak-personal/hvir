/* global AbortController */
/** A guest-local lifetime over the public bridge; no private workbench imports. */
export function guestClient(bridge, clock = globalThis) {
  let alive = true,
    serial = 0,
    visible = false,
    nextSend = 0
  const pending = new Map(),
    listeners = new Set()
  const controller = new AbortController()
  let queue = Promise.resolve(),
    waiting
  const unsubscribe = bridge.onMessage((message) => {
    if (!alive) return
    if (message.kind === 'context') {
      visible = message.context.visible
      if (!visible) cancelPending('This view is hidden')
    }
    if (message.kind === 'result') {
      const request = pending.get(message.id)
      if (request) {
        pending.delete(message.id)
        message.ok
          ? request.resolve(message.value)
          : request.reject(new Error(message.error))
      }
    }
    for (const listener of listeners) listener(message)
    if (message.kind === 'revoked') dispose()
  })
  function request(capability, input) {
    return new Promise((resolve, reject) => {
      const id = `skillager-${++serial}`
      pending.set(id, { resolve, reject })
      queue = queue
        .then(async () => {
          if (!alive || !visible || !pending.has(id))
            throw new Error('This view is hidden or closed')
          const wait = Math.max(0, nextSend - Date.now())
          if (wait)
            await new Promise((resume) => {
              waiting = {
                resume,
                timer: clock.setTimeout(() => {
                  waiting = undefined
                  resume()
                }, wait),
              }
            })
          if (!alive || !visible || !pending.has(id))
            throw new Error('This view is hidden or closed')
          nextSend = Date.now() + 40
          bridge.send({
            kind: 'request',
            id,
            capability,
            ...(input === undefined ? {} : { input }),
          })
        })
        .catch((error) => {
          pending.delete(id)
          reject(error)
        })
    })
  }
  function cancelPending(reason) {
    if (waiting) {
      clock.clearTimeout(waiting.timer)
      waiting.resume()
      waiting = undefined
    }
    for (const [id, request] of pending) {
      try {
        bridge.send({ kind: 'cancel', id })
      } catch {
        /* Main revocation still applies. */
      }
      request.reject(new Error(reason))
    }
    pending.clear()
  }
  function dispose() {
    if (!alive) return
    alive = false
    controller.abort()
    unsubscribe()
    listeners.clear()
    cancelPending('This view closed')
  }
  return {
    request,
    dispose,
    signal: controller.signal,
    get alive() {
      return alive
    },
    get visible() {
      return visible
    },
    listen(callback) {
      listeners.add(callback)
      return () => listeners.delete(callback)
    },
    hello() {
      bridge.send({ kind: 'hello', contract: '1.0' })
    },
  }
}
export async function outputText(client, receipt, stream = 'stdout') {
  let text = '',
    offset = 0
  for (;;) {
    const page = await client.request('connector.output', { receipt, stream, offset })
    text += page.data
    if (text.length > 4 * 1024 * 1024)
      throw new Error('CLI output exceeds the public limit')
    if (page.nextOffset === null) return text
    if (page.nextOffset <= offset) throw new Error('CLI output page did not advance')
    offset = page.nextOffset
  }
}
export async function runCli(client, args, context) {
  const workspace = context?.workspace
  if (workspace && workspace.host !== 'local')
    throw new Error(
      'SSH project presence is unknown. The personal library remains local; no remote Skillager command is run.',
    )
  const result = await client.request('connector.execute', {
    connector: workspace ? 'project-cli' : 'library-cli',
    host: 'local',
    ...(workspace ? { workspace: workspace.id } : {}),
    args,
  })
  let text = '',
    error = ''
  try {
    if (result.receipt) {
      text = await outputText(client, result.receipt)
      error = await outputText(client, result.receipt, 'stderr')
    }
    if (result.outcome !== 'completed' || result.code !== 0 || result.truncated)
      throw new Error(
        result.outcome === 'not-started' &&
          ['frequency', 'capacity'].includes(result.reason)
          ? 'Another refresh is pending; last-known rows are retained.'
          : `Skillager ${result.outcome}: ${result.reason ?? `exit ${result.code ?? 'unknown'}`}${error ? ` · ${error.slice(0, 300)}` : ''}`,
      )
    return text
  } finally {
    if (result.receipt)
      await client
        .request('connector.output', { receipt: result.receipt, release: true })
        .catch(() => {})
  }
}
