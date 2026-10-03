/* global window */
import { guestClient, runCli } from './bridge.mjs'
import { requireVersion, libraryStatus } from './catalog.mjs'
const client = guestClient(window.hvirExtension)
let busy = false,
  timer,
  generation = 0,
  verified = false,
  lastKnown
async function observe() {
  if (!client.alive || !client.visible || busy) return
  busy = true
  const revision = generation
  try {
    if (!verified) {
      requireVersion(await runCli(client, ['--version']))
      verified = true
    }
    const library = libraryStatus(
      JSON.parse(await runCli(client, ['library', 'status', '--json'])),
    )
    if (!client.visible || revision !== generation) return
    const value = {
      item: 'library',
      label: library.count === null ? 'Skills' : `Skills ${library.count}`,
      tooltip: `${library.count ?? 'Unknown number of'} personal library skills · current metadata`,
      observedAt: Date.now(),
      availability: 'current',
    }
    await client.request('contributions.publish', value)
    lastKnown = value
  } catch (error) {
    if (client.visible && revision === generation)
      await client
        .request('contributions.publish', {
          ...(lastKnown ?? { item: 'library', label: 'Skills' }),
          tooltip: `${error.message}`.slice(0, 160),
          availability: lastKnown ? 'stale' : 'failed',
        })
        .catch(() => {})
  } finally {
    busy = false
    schedule()
  }
}
function schedule() {
  window.clearTimeout(timer)
  if (client.alive && client.visible)
    timer = window.setTimeout(() => void observe(), 30_000)
}
client.listen((message) => {
  if (message.kind === 'context') {
    generation++
    window.clearTimeout(timer)
    if (message.context.visible) void observe()
  }
})
client.signal.addEventListener('abort', () => window.clearTimeout(timer), { once: true })
window.addEventListener('pagehide', () => client.dispose(), { once: true })
client.hello()
