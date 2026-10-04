import { join } from 'node:path'
import { AGENT_GUIDE_TOPICS } from '../src/shared/agent/reference-catalog.ts'
import { inspectAgentClientManifest } from './agent-client-artifacts.mjs'
import { PRESENTATION_ASSETS } from './prepare-extension-ui.mts'

/** Native extraResources are separate from ASAR and must ship the offline public inputs. */
export async function inspectPackagedExtensionAssets(
  resources: string,
  readFile: (path: string) => Promise<Uint8Array>,
): Promise<void> {
  const requireBytes = async (path: string): Promise<void> => {
    if (!(await readFile(join(resources, path))).length)
      throw new Error(`Packaged public extension asset is empty: ${path}`)
  }
  for (const topic of Object.keys(AGENT_GUIDE_TOPICS))
    await requireBytes(`agent-guides/${topic}.md`)
  for (const asset of ['extension-authoring/SKILL.md', 'hvir-agent-command'])
    await requireBytes(asset)
  for (const [directory, id] of [
    ['extension-reference', 'hvir.reference'],
    ['extension-authoring/clock', 'hvir.clock'],
  ]) {
    const manifest = JSON.parse(
      Buffer.from(
        await readFile(join(resources, directory!, 'hvir-extension.json')),
      ).toString('utf8'),
    ) as {
      id: string
      version: string
      contract: string
      views: { entry: string }[]
      updater?: string
    }
    if (manifest.id !== id || manifest.version !== '0.3.0' || manifest.contract !== '1.0')
      throw new Error(`Packaged extension identity is invalid: ${directory}`)
    for (const asset of [
      ...PRESENTATION_ASSETS,
      ...manifest.views.map((view) => view.entry),
      ...(manifest.updater ? [manifest.updater] : []),
      ...(id === 'hvir.clock'
        ? ['clock.js', 'clock.css']
        : ['reference.js', 'reference.css', 'catalog.json', 'updater.js']),
    ])
      await requireBytes(`${directory}/${asset}`)
  }
  await inspectAgentClientManifest(join(resources, 'agent-clients'))
}
