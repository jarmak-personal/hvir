import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { AGENT_GUIDE_TOPICS } from '../src/shared/agent/reference-catalog.ts'
import { inspectAgentClientManifest } from './agent-client-artifacts.mjs'

export interface PackagedExtensionValidation {
  readonly id: string
  readonly contract: string
  readonly revision: string
  readonly kind: string
}

/** Native extraResources are separate from ASAR and must ship the offline public inputs. */
export async function inspectPackagedExtensionAssets(
  resources: string,
  readFile: (path: string) => Promise<Uint8Array>,
  validate: (path: string) => Promise<PackagedExtensionValidation>,
): Promise<void> {
  const requireBytes = async (path: string): Promise<void> => {
    if (!(await readFile(join(resources, path))).length)
      throw new Error(`Packaged public extension asset is empty: ${path}`)
  }
  for (const topic of Object.keys(AGENT_GUIDE_TOPICS))
    await requireBytes(`agent-guides/${topic}.md`)
  for (const asset of ['extension-authoring/SKILL.md', 'hvir-agent-command'])
    await requireBytes(asset)
  for (const [directory, source] of [
    ['extension-reference', '../packages/extension-reference'],
    ['extension-authoring/clock', '../packages/extension-authoring/clock'],
  ]) {
    // Ordinary capture owns the manifest, contract and complete eligible asset graph.
    // Compare its complete revision rather than maintaining a second template file policy.
    const expected = await validate(fileURLToPath(new URL(source!, import.meta.url)))
    const installed = await validate(join(resources, directory!))
    if (
      installed.id !== expected.id ||
      installed.contract !== expected.contract ||
      installed.revision !== expected.revision ||
      installed.kind !== expected.kind
    )
      throw new Error(`Packaged extension differs from maintained input: ${directory}`)
  }
  await inspectAgentClientManifest(join(resources, 'agent-clients'))
}
