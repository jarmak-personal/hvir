import { containsHostPath, joinHostPath, type HostPath } from '../../shared/host-path'
import type { ProjectHost } from '../project-host/project-host'
import type { skillagerManagementControls } from './skillager-management-controls'
import { createHash } from 'node:crypto'
import { verifyOwnedCopyProtections } from './skillager-copy-protections'

type Controls = ReturnType<typeof skillagerManagementControls>

/** Actual managed trees and preservation after ordinary public Add/Update/Remove controls. */
export async function verifyOwnedManagedCopies(
  controls: Controls,
  host: ProjectHost,
  workspace: HostPath,
  skillId: string,
  canonical: HostPath,
  owned: HostPath,
  canonicalPending: () => Promise<void>,
): Promise<readonly Record<string, unknown>[]> {
  const proof: Record<string, unknown>[] = []
  const selected = new Map<string, { target: HostPath; exposureId: string }>()
  await controls.click('observe-source')
  await controls.ready(
    "document.getElementById('state').textContent.includes('Accepted source version selected')",
    'exact owned accepted source',
  )
  const choices = (await controls.inspect(
    "[...document.getElementById('copy-agent').options].map(e=>({id:e.value,label:e.textContent}))",
  )) as Array<{ id: string; label: string }>
  if (
    JSON.stringify(choices.map((item) => item.label)) !==
    JSON.stringify(['Codex', 'Claude'])
  )
    throw new Error(
      'Owned walkthrough requires both displayed supported CLI agent choices',
    )
  for (const { id: agent } of choices) {
    await controls.set('copy-agent', agent)
    await controls.set('copy-mode', 'native')
    await controls.inspect("document.getElementById('result').textContent=''")
    await controls.click('add-copy')
    const added = await controls.result('add-copy')
    if (added['outcome'] !== 'verified')
      throw new Error(`Owned ${agent} Add did not return a verified outcome`)
    const target = added['target'] as HostPath,
      exposureId = added['exposureId']
    if (typeof exposureId !== 'string')
      throw new Error('Owned Add omitted its exact managed identity')
    selected.set(agent, { target, exposureId })
    if (!containsHostPath(workspace, target) || added['agent'] !== agent)
      throw new Error('Owned copy target substituted workspace or agent')
    const fullTree = (await host.readdir(target)).map((entry) => entry.name).sort()
    if (
      JSON.stringify(fullTree) !==
      JSON.stringify([
        'SKILL.md',
        'owned.png',
        'skillager.materialized.yaml',
        'support.sh',
      ])
    )
      throw new Error(
        'Full Add file set differs from the complete owned authored fixture',
      )
    for (const name of ['SKILL.md', 'support.sh', 'owned.png']) {
      const original = joinHostPath(canonical, name),
        installed = joinHostPath(target, name)
      if (
        !(await host.readFile(original)).equals(await host.readFile(installed)) ||
        ((await host.stat(original)).mode & 0o111) !==
          ((await host.stat(installed)).mode & 0o111)
      )
        throw new Error(`Full Add changed owned ${name} bytes or executable state`)
    }
    const protections = await verifyOwnedCopyProtections(
      controls,
      host,
      target,
      owned,
      agent,
      exposureId,
    )
    await controls.observeCopies({ agent, exposureId, target })
    await controls.set('copy-mode', 'stub')
    await controls.inspect(
      `(() => { const row=[...document.querySelectorAll('#managed-copies > div')].find(e=>e.querySelector('p').textContent.startsWith(${JSON.stringify(agent)})); row.querySelector('button').click(); })()`,
    )
    await controls.ready(
      "!document.getElementById('review').hidden",
      `${agent} complete Stub mode-change plan`,
    )
    const completePlan = (await controls.inspect(
        "JSON.parse(document.getElementById('review-plan').textContent)",
      )) as Record<string, unknown>,
      preview = completePlan as {
        file_effects: Array<{
          path: string
          after: { sha256?: string; size?: number } | null
        }>
      }
    const expectedStub = preview.file_effects.find(
      (effect) => effect.path === 'SKILL.md',
    )?.after
    if (!expectedStub?.sha256 || expectedStub.size === undefined)
      throw new Error('Complete Stub preview has no exact resulting body identity')
    await controls.inspect("document.getElementById('result').textContent=''")
    await controls.click('confirm-plan')
    const updated = await controls.result('change-exposure')
    if (
      updated['outcome'] !== 'verified' ||
      updated['exposureId'] !== added['exposureId']
    )
      throw new Error(
        `Owned ${agent} exact managed Update did not return a verified outcome`,
      )
    const tree = (await host.readdir(target)).map((entry) => entry.name).sort(),
      body = (await host.readFile(joinHostPath(target, 'SKILL.md'))).toString('utf8')
    if (
      JSON.stringify(tree) !==
        JSON.stringify(['SKILL.md', 'skillager.materialized.yaml']) ||
      !body.includes(skillId)
    )
      throw new Error(
        'Stub mode change did not produce the exact Stub file set and canonical identity',
      )
    const bodyBytes = await host.readFile(joinHostPath(target, 'SKILL.md'))
    if (
      bodyBytes.length !== expectedStub.size ||
      createHash('sha256').update(bodyBytes).digest('hex') !== expectedStub.sha256
    )
      throw new Error(
        'Actual Stub body differs from the complete reviewed public resulting file identity',
      )
    proof.push({
      agent,
      added,
      updated,
      fullTree,
      stubTree: tree,
      stubBodySha256: expectedStub.sha256,
      protections,
    })
  }
  await canonicalPending()
  // Removal observes managed targets; selecting the now-pending canonical source is unnecessary.
  for (const { id: agent } of choices) {
    await controls.observeCopies({ agent, ...selected.get(agent)! })
    await controls.inspect(
      `(() => { const row=[...document.querySelectorAll('#managed-copies > div')].find(e=>e.querySelector('p').textContent.startsWith(${JSON.stringify(agent)})); row.querySelectorAll('button')[1].click(); })()`,
    )
    await controls.ready(
      "!document.getElementById('review').hidden",
      `${agent} complete Remove plan`,
    )
    await controls.inspect("document.getElementById('result').textContent=''")
    await controls.click('confirm-plan')
    const removed = await controls.result('remove-copy')
    if (removed['outcome'] !== 'verified')
      throw new Error(`Owned ${agent} Remove did not return a verified outcome`)
    const target = removed['target'] as HostPath
    try {
      await host.stat(target)
      throw new Error('Removed managed directory still exists')
    } catch (error) {
      if ((error as { code?: unknown }).code !== 'ENOENT') throw error
    }
    proof.push({ agent, removed, canonicalAcceptance: 'pending' })
  }
  return proof
}
