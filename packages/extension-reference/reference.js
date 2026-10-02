/* global window, document */
const bridge = window.hvirExtension
const status = document.getElementById('status')
const button = document.getElementById('open-detail')
let serial = 0
if (button) button.disabled = true
let alive = true
const cleanups = new Set()
const timers = new Set()
const requests = new Map()
const listen = (callback) => {
  const stop = bridge.onMessage((message) => {
    if (alive) callback(message)
  })
  cleanups.add(stop)
  return () => {
    cleanups.delete(stop)
    stop()
  }
}
const on = (element, event, callback) => {
  if (!element) return
  const guarded = (...args) => {
    if (alive) callback(...args)
  }
  element.addEventListener(event, guarded)
  cleanups.add(() => element.removeEventListener(event, guarded))
}
function dispose() {
  if (!alive) return
  alive = false
  for (const [id, reject] of requests) {
    try {
      bridge.send({ kind: 'cancel', id })
    } catch {
      /* Local revocation still owns cleanup. */
    }
    reject(new Error('This view has closed.'))
  }
  requests.clear()
  for (const timer of timers) window.clearTimeout(timer)
  timers.clear()
  for (const cleanup of [...cleanups].reverse()) cleanup()
  cleanups.clear()
}
cleanups.add(window.hvirUI.bindPresentation(bridge))
window.addEventListener('pagehide', dispose, { once: true })
cleanups.add(() => window.removeEventListener('pagehide', dispose))
listen((message) => {
  if (message.kind === 'hello') {
    if (button) button.disabled = !message.capabilities.includes('viewer.open-own')
    status.textContent = `Connected · contract ${message.contract}`
  } else if (message.kind === 'result')
    status.textContent = !message.ok
      ? message.error
      : message.id.startsWith('open-')
        ? 'Detail view opened.'
        : message.id.startsWith('mark-')
          ? 'Session marked.'
          : 'Request completed.'
  else if (message.kind === 'revoked') {
    status.textContent = 'This view has closed.'
    if (button) button.disabled = true
    dispose()
  }
})
bridge.send({ kind: 'hello', contract: '1.0' })
on(button, 'click', () =>
  bridge.send({
    kind: 'request',
    id: `open-${++serial}`,
    capability: 'viewer.open-own',
    input: { contributionId: 'detail' },
  }),
)

let context
const clock = document.getElementById('clock-time')
let clockTimer
function updateClock() {
  if (!alive || !clock || !context?.visible) return
  const now = new Date()
  clock.dateTime = now.toISOString()
  clock.textContent = now.toLocaleTimeString()
  if (clockTimer !== undefined) return
  clockTimer = window.setTimeout(() => {
    timers.delete(clockTimer)
    clockTimer = undefined
    updateClock()
  }, 1000)
  timers.add(clockTimer)
}
const observation = document.getElementById('observation')
listen((message) => {
  if (message.kind === 'context') {
    context = message.context
    if (!context.visible && clockTimer !== undefined) {
      window.clearTimeout(clockTimer)
      timers.delete(clockTimer)
      clockTimer = undefined
    }
    updateClock()
    const title = document.getElementById('session-title')
    if (title) title.textContent = context.session?.title ?? 'No session context'
  }
  if (message.kind === 'contributions' && observation)
    observation.textContent = message.values
      .map((value) => `${value.label ?? ''} ${value.availability ?? ''}`)
      .join(' · ')
  if (message.kind === 'action') {
    const invocation = message.invocation
    status.textContent = `Action for ${invocation.context.session?.title ?? 'application'} · ${invocation.caller}`
    const timer = window.setTimeout(
      () => {
        timers.delete(timer)
        if (!alive) return
        bridge.send({
          kind: 'action-result',
          id: invocation.id,
          value: {
            session: invocation.context.session?.id ?? null,
            caller: invocation.caller,
          },
        })
        status.textContent = `Action completed · ${invocation.id}`
      },
      Math.max(500, Math.min(5000, Number(invocation.input?.delayMs) || 500)),
    )
    timers.add(timer)
  }
})
on(document.getElementById('mark-session'), 'click', () => {
  if (!context?.session) return
  bridge.send({
    kind: 'request',
    id: `mark-${++serial}`,
    capability: 'contributions.publish',
    input: {
      item: 'session',
      session: context.session.id,
      icon: '◆',
      label: 'Marked',
      tooltip: 'This exact session was marked',
    },
  })
})

// Native results have explicit process status; output pages remain caller-bound.
const nativeRun = document.getElementById('native-run')
const nativeNext = document.getElementById('native-next')
const nativeStatus = document.getElementById('native-status')
const nativeOutput = document.getElementById('native-output')
let nativeReceipt,
  nativeOffset = 0
function nativeRequest(capability, input) {
  const id = `native-${++serial}`
  return new Promise((resolve, reject) => {
    if (!alive) return reject(new Error('This view has closed.'))
    let stop = () => {}
    try {
      stop = listen((message) => {
        if (message.kind !== 'result' || message.id !== id) return
        stop()
        requests.delete(id)
        if (message.ok) resolve(message.value)
        else reject(new Error(message.error))
      })
      requests.set(id, reject)
      bridge.send({ kind: 'request', id, capability, input })
    } catch (error) {
      stop()
      requests.delete(id)
      reject(error)
    }
  })
}
async function releaseNativeReceipt() {
  const receipt = nativeReceipt
  nativeReceipt = undefined
  if (receipt)
    await nativeRequest('connector.output', { receipt, release: true }).catch(() => {})
}
async function nativePage() {
  const page = await nativeRequest('connector.output', {
    receipt: nativeReceipt,
    stream: 'stdout',
    offset: nativeOffset,
  })
  if (!alive) return
  nativeOutput.textContent = page.data
  nativeOffset = page.nextOffset
  nativeNext.disabled = nativeOffset === null
  if (nativeOffset === null) {
    await releaseNativeReceipt()
  }
}
listen((message) => {
  if (message.kind === 'hello' && nativeRun)
    nativeRun.disabled = !['connector.execute', 'connector.output'].every((capability) =>
      message.capabilities.includes(capability),
    )
})
on(nativeRun, 'click', async () => {
  nativeRun.disabled = true
  try {
    await releaseNativeReceipt()
    const result = await nativeRequest('connector.execute', {
      connector: 'installed-tool',
      host: 'local',
      args: JSON.parse(document.getElementById('native-args').value),
    })
    if (!alive) return
    nativeStatus.textContent = `${result.outcome} · ${result.host || 'no approved host'} · exit ${result.code ?? 'unknown'}${result.truncated ? ' · truncated' : ''}${result.reason ? ` · ${result.reason}` : ''}`
    nativeOutput.textContent = ''
    nativeReceipt = result.receipt
    nativeOffset = 0
    nativeNext.disabled = true
    if (nativeReceipt) await nativePage()
  } catch (error) {
    if (!alive) return
    nativeStatus.textContent = error.message
  } finally {
    if (alive) nativeRun.disabled = false
  }
})
on(nativeNext, 'click', () => {
  void nativePage().catch((error) => {
    if (!alive) return
    nativeStatus.textContent = error.message
    nativeNext.disabled = true
  })
})

// A local, immutable catalog demonstrates the named list/detail consumer offline.
const search = document.getElementById('catalog-search')
const list = document.getElementById('catalog-list')
const detail = document.getElementById('catalog-detail')
const catalogState = document.getElementById('catalog-state')
let catalog = [],
  catalogGeneration = 0,
  catalogController
if (list) {
  const navigation = window.hvirUI.bindList(list, (row) => {
    const item = catalog.find((item) => item.id === row.dataset.id)
    if (item) detail.textContent = item.detail
  })
  cleanups.add(() => {
    catalogGeneration++
    catalogController?.abort()
    catalogController = undefined
    navigation.dispose()
  })
  const render = () => {
    if (!alive || catalogState.dataset.state === 'error') return
    const query = search.value.trim().toLowerCase()
    const matches = catalog.filter((item) => item.title.toLowerCase().includes(query))
    list.replaceChildren(
      ...matches.map((item) => {
        const row = document.createElement('button')
        row.type = 'button'
        row.className = 'hvir-button hvir-row hvir-focus'
        row.dataset.variant = 'selectable'
        row.dataset.id = item.id
        row.setAttribute('role', 'option')
        row.setAttribute('aria-selected', 'false')
        row.textContent = item.title
        return row
      }),
    )
    navigation.refresh()
    detail.textContent = matches.length
      ? 'Choose an example to read its details.'
      : 'Try a different search.'
    catalogState.dataset.state = matches.length ? 'ready' : 'empty'
    catalogState.textContent = matches.length
      ? `${matches.length} examples`
      : 'No examples match your search.'
  }
  const reload = async () => {
    const generation = ++catalogGeneration
    catalogState.dataset.state = 'loading'
    catalogState.textContent = 'Loading examples…'
    catalogController?.abort()
    const abort = new window.AbortController()
    catalogController = abort
    try {
      const response = await window.fetch('catalog.json', { signal: abort.signal })
      if (!response.ok)
        throw new Error('Examples are unavailable. Choose Reload examples to try again.')
      const value = await response.json()
      if (
        !Array.isArray(value) ||
        value.some(
          (item) =>
            !item ||
            !['id', 'title', 'detail'].every((key) => typeof item[key] === 'string'),
        )
      )
        throw new Error(
          'Examples could not be read. Choose Reload examples to try again.',
        )
      if (!alive || generation !== catalogGeneration) return
      catalog = value
      catalogState.dataset.state = 'ready'
      render()
    } catch (error) {
      if (!alive || generation !== catalogGeneration) return
      catalog = []
      list.replaceChildren()
      detail.textContent = 'Search remains available when examples load.'
      catalogState.dataset.state = 'error'
      catalogState.textContent = error.message
    } finally {
      if (catalogController === abort) catalogController = undefined
    }
  }
  on(search, 'input', render)
  on(document.getElementById('catalog-reload'), 'click', () => {
    void reload()
  })
  void reload()
}
