/* global AbortController */
/** A guest-local lifetime over the public bridge; no private workbench imports. */
export function guestClient(bridge, clock = globalThis) {
  let alive = true,
    serial = 0,
    visible = false
  const pending = new Map(),
    listeners = new Set(),
    actions = new Map(),
    sentAt = []
  const controller = new AbortController()
  let queue = Promise.resolve(),
    waiting
  const unsubscribe = bridge.onMessage((message) => {
    if (!alive) return
    if (message.kind === 'context') {
      visible = message.context.visible
      if (!visible)
        cancelPending(
          'This view is hidden',
          (request) =>
            !request.actionId &&
            !(
              ['actions.invoke', 'connector.connect'].includes(request.capability) &&
              request.submitted
            ),
        )
    }
    if (message.kind === 'action')
      actions.set(message.invocation.id, new AbortController())
    if (message.kind === 'action-cancelled') finishAction(message.id, false)
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
    if (message.kind === 'revoked') dispose(false)
  })
  function current(actionId) {
    return alive && (actionId ? actions.has(actionId) : visible)
  }
  function trySend(message) {
    const now = clock.performance.now()
    while (sentAt.length && sentAt[0] <= now - 1000) sentAt.shift()
    if (sentAt.length >= 24) return false
    sentAt.push(now)
    // Mark the physical send attempt before callbacks can hide its caller.
    if (message.kind === 'request') pending.get(message.id).submitted = true
    bridge.send(message)
    return true
  }
  function sendQueued(message, admitted) {
    const delivery = queue.then(async () => {
      while (admitted()) {
        // Count every outbound message, including control messages. Hidden
        // Chromium timers may clamp to 1s; short bounded sequences need no timer
        // between each page. Main's public 30-message/s ceiling remains unchanged.
        if (trySend(message)) return true
        await new Promise((resume) => {
          waiting = {
            admitted,
            resume,
            timer: clock.setTimeout(
              () => {
                waiting = undefined
                resume()
              },
              Math.max(1, sentAt[0] + 1000 - clock.performance.now()),
            ),
          }
        })
      }
      return false
    })
    queue = delivery.catch(() => false)
    return delivery
  }
  function request(capability, input, actionId) {
    return new Promise((resolve, reject) => {
      const id = `skillager-${++serial}`
      const request = { resolve, reject, actionId, capability, submitted: false }
      pending.set(id, request)
      void sendQueued(
        {
          kind: 'request',
          id,
          capability,
          ...(actionId ? { actionId } : {}),
          ...(input === undefined ? {} : { input }),
        },
        () => current(actionId) && pending.has(id),
      )
        .then((sent) => {
          if (!sent) throw new Error('This view is hidden or closed')
        })
        .catch((error) => {
          pending.delete(id)
          reject(error)
        })
    })
  }
  function cancelPending(reason, matches = () => true, notify = true) {
    if (waiting && !waiting.admitted()) {
      clock.clearTimeout(waiting.timer)
      waiting.resume()
      waiting = undefined
    }
    for (const [id, request] of pending) {
      if (!matches(request)) continue
      if (request.submitted && notify)
        try {
          const message = { kind: 'cancel', id }
          if (!trySend(message)) void sendQueued(message, () => alive).catch(() => {})
        } catch {
          /* Main revocation still applies; cancellation cannot prove rollback. */
        }
      request.reject(new Error(reason))
      pending.delete(id)
    }
  }
  function finishAction(id, notify = true) {
    actions.get(id)?.abort()
    actions.delete(id)
    cancelPending('This action ended', (request) => request.actionId === id, notify)
  }
  function dispose(notify = true) {
    if (!alive) return
    alive = false
    controller.abort()
    if (waiting) {
      clock.clearTimeout(waiting.timer)
      waiting.resume()
      waiting = undefined
    }
    for (const id of actions.keys()) finishAction(id, notify)
    unsubscribe()
    listeners.clear()
    cancelPending('This view closed', () => true, notify)
  }
  return {
    request,
    forAction(invocation) {
      const action = actions.get(invocation.id)
      if (!action) throw new Error('This action is no longer admitted')
      return {
        request: (capability, input) => request(capability, input, invocation.id),
        reply: (value, error) =>
          sendQueued(
            {
              kind: 'action-result',
              id: invocation.id,
              ...(error === undefined ? { value } : { error }),
            },
            () => current(invocation.id),
          ),
        dispose: () => finishAction(invocation.id),
        signal: action.signal,
        get alive() {
          return current(invocation.id)
        },
      }
    },
    delay(milliseconds) {
      return new Promise((resolve, reject) => {
        const finish = (error) => {
          clock.clearTimeout(timer)
          listeners.delete(changed)
          controller.signal.removeEventListener('abort', aborted)
          error ? reject(error) : resolve()
        }
        const changed = (message) => {
          if (message.kind === 'context' && !message.context.visible)
            finish(new Error('This view is hidden'))
        }
        const aborted = () => finish(new Error('This view closed'))
        const timer = clock.setTimeout(() => finish(), milliseconds)
        listeners.add(changed)
        controller.signal.addEventListener('abort', aborted, { once: true })
        if (!alive || !visible) finish(new Error('This view is hidden or closed'))
      })
    },
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
      const message = { kind: 'hello', contract: '1.0' }
      if (!trySend(message)) void sendQueued(message, () => alive).catch(() => dispose())
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
export async function runCli(client, args, context, retryFrequency = true) {
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
  if (await deferReadFrequency(client, result, retryFrequency)) {
    return runCli(client, args, context, false)
  }
  let text = '',
    error = ''
  try {
    if (result.receipt) {
      text = await outputText(client, result.receipt)
      error = await outputText(client, result.receipt, 'stderr')
    }
    if (result.outcome !== 'completed' || result.code !== 0 || result.truncated)
      throw new Error(
        result.outcome === 'not-started' && result.reason === 'unapproved'
          ? 'Approve your Skillager CLI in Settings → Extensions → Skillager to browse skills.'
          : result.outcome === 'not-started' &&
              ['frequency', 'capacity'].includes(result.reason)
            ? result.reason === 'frequency'
              ? 'Refresh deferred by the completed-execution frequency limit; freshness unavailable.'
              : 'Refresh deferred by execution capacity; freshness unavailable.'
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

/** Only a never-started observation may defer once; mutation owners never call this. */
export async function deferReadFrequency(client, result, permitted) {
  if (
    permitted &&
    result.outcome === 'not-started' &&
    result.reason === 'frequency' &&
    typeof client.delay === 'function' &&
    client.visible === true
  ) {
    // D5 shares only in-flight work. Reobserve after its completed-source limit;
    // no cached freshness, implicit body access or native mutation replay.
    await client.delay(1100)
    if (!client.alive) throw new Error('This operation is no longer admitted')
    if (!client.visible) throw new Error('This observation is hidden')
    return true
  }
  return false
}
