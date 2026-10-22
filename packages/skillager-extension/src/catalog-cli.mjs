import { runCli } from './bridge.mjs'
import { requireVersion } from './catalog.mjs'

/** Catalog observations are fenced by their owning list or selected-reader lifetime. */
export function catalogCli(client, context, generation) {
  const verifiedVersions = new Set()
  return async (args, project) => {
    const revision = generation(),
      workspace = project?.workspace
    const current = () => {
      if (
        !client.alive ||
        !context().visible ||
        generation() !== revision ||
        (workspace && JSON.stringify(workspace) !== JSON.stringify(context().workspace))
      )
        throw new Error('This observation is no longer current')
    }
    // Fence each public transport phase, including version -> command and frequency deferral.
    const scopedClient = {
      request: async (...input) => {
        // Retired observations may release their own opaque output receipt, never read it.
        if (!(input[0] === 'connector.output' && input[1]?.release === true)) current()
        return client.request(...input)
      },
      delay: async (milliseconds) => {
        current()
        await client.delay(milliseconds)
        current()
      },
      get alive() {
        return client.alive
      },
      get visible() {
        return client.visible
      },
    }
    const key = workspace?.id ?? 'library'
    if (!verifiedVersions.has(key)) {
      requireVersion(await runCli(scopedClient, ['--version'], project))
      current()
      verifiedVersions.add(key)
    }
    const text = await runCli(scopedClient, args, project)
    current()
    return JSON.parse(text)
  }
}

/** Only the public stale-cursor envelope can restart a metadata traversal. */
export function isStaleCatalogCursor(error) {
  if (error?.cli?.outcome !== 'completed' || error.cli.code !== 15) return false
  try {
    const value = JSON.parse(error.cli.stdout)
    return value?.schema === 'skillager.error.v1' && value.error?.code === 'stale_cursor'
  } catch {
    return false
  }
}
