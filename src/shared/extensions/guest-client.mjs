/* global AbortController */
/** One finite guest lifetime over the public bridge. All outbound traffic shares a clock. */
export function guestClient(bridge, clock = globalThis) {
  let alive = true,
    visible = false,
    serial = 0,
    timer,
    scheduled = false,
    pumping = false,
    outputTurns = 0,
    greeted = false
  // Keep short/clamped sequences immediate; a small replenishment margin adds
  // IPC-clock headroom without claiming a receiver-rate guarantee after stalls.
  const windowMs = 1050
  const pending = new Map(),
    actions = new Map(),
    cancellations = new Set(),
    listeners = new Set(),
    sentAt = [],
    output = [],
    ordinary = []
  const controller = new AbortController()
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
              request.submitted &&
              ['actions.invoke', 'connector.connect', 'source.request-trash'].includes(
                request.capability,
              )
            ),
        )
    }
    if (message.kind === 'action' && !actions.has(message.invocation.id)) {
      // Bound local obligations; main owns admission and eventual cancellation.
      if (actions.size >= 4) return
      actions.set(message.invocation.id, { controller: new AbortController() })
    }
    if (message.kind === 'action-cancelled') finishAction(message.id, false)
    if (message.kind === 'result') {
      const request = pending.get(message.id)
      if (request?.submitted) {
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
  function prune() {
    for (const queue of [output, ordinary])
      for (let index = queue.length - 1; index >= 0; index--)
        if (!queue[index].admitted()) queue.splice(index, 1)[0].resolve(false)
    if (!output.length && !ordinary.length) {
      clock.clearTimeout(timer)
      timer = undefined
    }
  }
  function pump() {
    if (pumping) return
    pumping = true
    try {
      prune()
      while (output.length || ordinary.length) {
        const now = clock.performance.now()
        while (sentAt.length && sentAt[0] <= now - windowMs) sentAt.shift()
        if (sentAt.length >= 24) {
          if (timer === undefined)
            timer = clock.setTimeout(
              () => {
                timer = undefined
                pump()
              },
              Math.max(1, sentAt[0] + windowMs - now),
            )
          break
        }
        // FIFO within each class; five reads then one control/ordinary request
        // gives every concurrent stream progress and reserves control service.
        const dataTurn = output.length && (!ordinary.length || outputTurns < 5)
        const entry = (dataTurn ? output : ordinary).shift()
        outputTurns = dataTurn ? Math.min(5, outputTurns + 1) : 0
        sentAt.push(now)
        try {
          // Physical submission precedes any synchronous visibility callback.
          if (entry.message.kind === 'request')
            pending.get(entry.message.id).submitted = true
          bridge.send(entry.message)
          if (entry.message.kind === 'action-result')
            finishAction(entry.message.id, false)
          entry.resolve(true)
        } catch (error) {
          entry.reject(error)
        }
        prune()
      }
    } finally {
      pumping = false
    }
  }
  function enqueue(message, admitted, data = false) {
    if (!admitted()) return Promise.resolve(false)
    const result = new Promise((resolve, reject) => {
      ;(data ? output : ordinary).push({ message, admitted, resolve, reject })
    })
    if (!scheduled) {
      scheduled = true
      void Promise.resolve().then(() => {
        scheduled = false
        pump()
      })
    }
    return result
  }
  function request(capability, input, actionId, signal) {
    if (!current(actionId))
      return Promise.reject(new Error('This view is hidden or closed'))
    // A submitted cancellation keeps its slot until its physical notification.
    // Repeated hide/show cannot accumulate an unbounded control queue.
    if (pending.size + cancellations.size >= 8)
      return Promise.reject(new Error('Guest request capacity exceeded'))
    return new Promise((resolve, reject) => {
      const id = `hvir-${++serial}`
      const request = { resolve, reject, actionId, capability, submitted: false }
      pending.set(id, request)
      const canceled = () =>
        cancelPending('Selected read ended', (entry) => entry === request)
      const finish = (callback) => (value) => {
        signal?.removeEventListener('abort', canceled)
        callback(value)
      }
      request.resolve = finish(resolve)
      request.reject = finish(reject)
      signal?.addEventListener('abort', canceled, { once: true })
      if (signal?.aborted) {
        canceled()
        return
      }
      void enqueue(
        {
          kind: 'request',
          id,
          capability,
          ...(actionId ? { actionId } : {}),
          ...(input === undefined ? {} : { input }),
        },
        () => current(actionId) && pending.has(id),
        capability === 'connector.output' && input?.release !== true,
      )
        .then((sent) => {
          if (!sent) throw new Error('This view is hidden or closed')
        })
        .catch((error) => {
          pending.delete(id)
          request.reject(error)
        })
    })
  }
  function cancelPending(reason, matches = () => true, notify = true) {
    for (const [id, request] of pending) {
      if (!matches(request)) continue
      pending.delete(id)
      request.reject(new Error(reason))
      if (request.submitted && notify) {
        cancellations.add(id)
        void enqueue({ kind: 'cancel', id }, () => !controller.signal.aborted)
          .catch(() => {}) // Main revocation remains authoritative; no rollback claim.
          .finally(() => cancellations.delete(id))
      }
    }
    prune()
  }
  function finishAction(id, notify = true) {
    const action = actions.get(id)
    actions.delete(id)
    action?.controller.abort()
    cancelPending('This action ended', (request) => request.actionId === id, notify)
    prune()
  }
  function dispose(notify = true) {
    if (!alive) return
    alive = false
    // Best-effort cancellation uses only remaining rate slots. Main owns teardown
    // when this guest is gone, so disposal retains neither timers nor queued traffic.
    cancelPending('This view closed', () => true, notify)
    if (notify) pump()
    controller.abort()
    for (const id of actions.keys()) finishAction(id, false)
    prune()
    unsubscribe()
    listeners.clear()
    cancellations.clear()
  }
  return {
    request: (capability, input, signal) => request(capability, input, undefined, signal),
    forAction(invocation) {
      const action = actions.get(invocation.id)
      if (!action) throw new Error('This action is no longer admitted')
      return {
        request: (capability, input, signal) =>
          request(capability, input, invocation.id, signal),
        reply(value, error) {
          if (!action.reply)
            action.reply = enqueue(
              {
                kind: 'action-result',
                id: invocation.id,
                ...(error === undefined ? { value } : { error }),
              },
              () => current(invocation.id),
            )
          return action.reply
        },
        dispose: () => finishAction(invocation.id),
        signal: action.controller.signal,
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
      if (greeted || !alive) return
      greeted = true
      void enqueue({ kind: 'hello', contract: '1.0' }, () => alive).catch(() => dispose())
      pump()
    },
  }
}
