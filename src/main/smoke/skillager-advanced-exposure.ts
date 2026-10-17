import { joinHostPath, localPath, type HostPath } from '../../shared/host-path'
import type { ProjectHost } from '../project-host/project-host'
import type { skillagerManagementControls } from './skillager-management-controls'

interface Lineage {
  canonical: { library_id: string; skill_id: string; path: string }
  preservation: string
  origins: Array<{ origin_id: string; path: string }>
}

/** Real installed public CLI preparation followed by ordinary human guest controls. */
export async function verifyOwnedAdvancedExposure(
  ui: ReturnType<typeof skillagerManagementControls>,
  host: ProjectHost,
  workspace: HostPath,
  cli: (args: readonly string[]) => Promise<Record<string, unknown>>,
): Promise<readonly Record<string, unknown>[]> {
  const proof: Record<string, unknown>[] = []
  const choices = (await ui.inspect(
    "[...document.getElementById('copy-agent').options].map(option=>({id:option.value,label:option.textContent}))",
  )) as Array<{ id: string; label: string }>
  if (
    JSON.stringify(choices.map((item) => item.label)) !==
    JSON.stringify(['Codex', 'Claude'])
  )
    throw new Error(
      'Advanced walkthrough requires both displayed supported CLI agent choices',
    )
  for (const { id: agent, label } of choices) {
    const base = joinHostPath(
        workspace,
        label === 'Codex' ? '.agents/skills' : '.claude/skills',
      ),
      sources: Array<{ original: HostPath; lineage: Lineage; bytes: string }> = []
    for (const suffix of ['one', 'two']) {
      const original = joinHostPath(base, `advanced-${agent}-${suffix}`),
        bytes = `---\nname: Advanced ${suffix}\ndescription: Use only for an owned advanced exposure fixture.\n---\n\nRead the complete supporting guide.\n`
      await host.createDirectoryExclusive(original, { mode: 0o755 })
      await host.writeFile(joinHostPath(original, 'SKILL.md'), bytes)
      await host.createFileExclusive(joinHostPath(original, 'helper.sh'), { mode: 0o755 })
      await host.writeFile(joinHostPath(original, 'helper.sh'), '#!/bin/sh\ntrue\n')
      if (
        (await host.readFile(joinHostPath(original, 'SKILL.md'))).toString() !== bytes ||
        (await host.readFile(joinHostPath(original, 'helper.sh'))).toString() !==
          '#!/bin/sh\ntrue\n'
      )
        throw new Error('Owned native original was not completely inspected')
      await cli(['review', 'approve', `project/advanced-${agent}-${suffix}`, '--json'])
      const status = await cli(['library', 'sync', '--status', '--json']),
        lineage = (status['lineages'] as Lineage[]).find((item) =>
          item.origins.some((origin) => origin.path === original.path),
        )
      if (!lineage || lineage.preservation !== 'verified')
        throw new Error('Public native preservation lineage is unavailable')
      sources.push({ original, lineage, bytes })
    }
    await ui.set('copy-agent', agent)
    await ui.set('copy-mode', 'stub')
    await ui.click('observe-advanced')
    try {
      await ui.ready(
        `document.querySelectorAll('#advanced-origin option').length >= 2`,
        `${agent} preserved native choices`,
      )
    } catch (error) {
      const diagnostic = await ui.inspect(`(() => {
        const state=document.getElementById('state').textContent;
        let observed;try{observed=JSON.parse(document.getElementById('advanced-observation').textContent)}catch{}
        return {originOptions:document.querySelectorAll('#advanced-origin option').length,
          observationPresent:!!observed, lineageCount:observed?.preserved?.lineages?.length,
          stateClasses:['Observing','unavailable','frequency','capacity','bound','coverage','library','confined','returned','changed','uninitialized','registered','not initialized','identity','not-started','No mutation'].filter(value=>state.includes(value))};
      })()`)
      console.log('[smoke] advanced native-choice boundary', JSON.stringify(diagnostic))
      throw error
    }
    await ui.set('advanced-operation', 'adopt-native')
    const one = sources[0]!,
      two = sources[1]!
    await selectOrigin(one.original)
    const uncovered = joinHostPath(one.original, 'uncovered.txt')
    await host.writeFile(uncovered, 'Owned uncovered bytes must remain.\n')
    await ui.click('preview-advanced')
    await ui.ready(
      "document.getElementById('review').hidden && document.getElementById('state').textContent.includes('Preserve the files')",
      `${agent} uncovered native refusal`,
    )
    if (
      (await host.readFile(uncovered)).toString() !==
      'Owned uncovered bytes must remain.\n'
    )
      throw new Error('Refused adoption discarded uncovered original bytes')
    await host.removeFile(uncovered)
    const adopted = await change('adopt-native')
    if ((await host.readdir(one.original)).some((item) => item.name === 'helper.sh'))
      throw new Error('Adopted Stub unexpectedly retained Full support in the project')
    if (
      (
        await host.readFile(localPath(`${one.lineage.canonical.path}/SKILL.md`))
      ).toString() !== one.bytes ||
      (
        await host.readFile(localPath(`${one.lineage.canonical.path}/helper.sh`))
      ).toString() !== '#!/bin/sh\ntrue\n' ||
      ((await host.stat(localPath(`${one.lineage.canonical.path}/helper.sh`))).mode &
        0o111) ===
        0
    )
      throw new Error('Native adoption lost original canonical bytes or executable mode')
    await ui.click('observe-advanced')
    await ui.ready(
      `document.querySelectorAll('#advanced-replacements option').length >= 1`,
      `${agent} adopted standalone choice`,
    )
    await ui.set('advanced-operation', 'group')
    const name = `Advanced ${agent}`
    await ui.set('advanced-name', name)
    await ui.set('advanced-members', one.lineage.canonical.skill_id)
    await ui.inspect(
      `(() => { const option=[...document.querySelectorAll('#advanced-replacements option')].find(item => item.value===${JSON.stringify(`advanced-${agent}-one`)}); if(!option)throw new Error('Exact replacement unavailable'); option.selected=true; })()`,
    )
    const grouped = await change('group')
    const router = joinHostPath(base, `skillager-advanced-${agent}`)
    if ((await host.readdir(base)).some((item) => item.name === `advanced-${agent}-one`))
      throw new Error('Selected standalone replacement was retained unexpectedly')
    const twoBytes = (
      await host.readFile(joinHostPath(two.original, 'SKILL.md'))
    ).toString()
    await ui.click('observe-advanced')
    await ui.ready(
      `document.querySelectorAll('#advanced-router option').length >= 1`,
      `${agent} current Router`,
    )
    await ui.set('advanced-operation', 'set-members')
    await ui.set(
      'advanced-members',
      `${one.lineage.canonical.skill_id}\n${two.lineage.canonical.skill_id}`,
    )
    const addedMember = await change('set-members')
    await ui.click('observe-advanced')
    await ui.ready(
      `document.querySelectorAll('#advanced-departures select').length===2`,
      `${agent} complete departing choices`,
    )
    await ui.set('advanced-members', two.lineage.canonical.skill_id)
    await ui.inspect(
      `(() => { const choice=[...document.querySelectorAll('#advanced-departures select')].find(item=>item.dataset.member===${JSON.stringify(one.lineage.canonical.skill_id)});choice.value='remove';choice.dispatchEvent(new Event('input',{bubbles:true})); })()`,
    )
    const removedMember = await change('set-members')
    await ui.click('observe-advanced')
    await ui.ready(
      `document.querySelectorAll('#advanced-departures select').length===1`,
      `${agent} updated Router membership`,
    )
    await ui.set('advanced-operation', 'ungroup')
    await ui.set('copy-mode', 'native')
    // Changing the mode invalidates observations, so explicitly reobserve exact Router identity.
    await ui.click('observe-advanced')
    await ui.ready(
      `document.querySelectorAll('#advanced-router option').length>=1`,
      `${agent} refreshed Ungroup target`,
    )
    const ungrouped = await change('ungroup')
    if (
      (await host.readdir(base)).some(
        (item) => item.name === `skillager-advanced-${agent}`,
      )
    )
      throw new Error('Ungroup left the selected Router')
    if (
      (await host.readFile(joinHostPath(two.original, 'SKILL.md'))).toString() !==
      twoBytes
    )
      throw new Error('Unselected native original changed during membership or Ungroup')
    const tag = await cli(['tag', 'show', `advanced-${agent}`, '--json'])
    if (!JSON.stringify(tag).includes(two.lineage.canonical.skill_id))
      throw new Error('Ungroup discarded curated tag membership')
    await ui.click('observe-advanced')
    await ui.ready(
      `document.querySelectorAll('#advanced-origin option').length>=1`,
      `${agent} preserved Full native choice`,
    )
    await ui.set('advanced-operation', 'adopt-native')
    await selectOrigin(two.original)
    const fullAdoption = await change('adopt-native')
    if (
      (await host.readFile(joinHostPath(two.original, 'SKILL.md'))).toString() !==
        twoBytes ||
      ((await host.stat(joinHostPath(two.original, 'helper.sh'))).mode & 0o111) === 0
    )
      throw new Error('Full adoption lost original bytes or modes')
    proof.push({
      agent,
      adopted,
      grouped,
      addedMember,
      removedMember,
      ungrouped,
      fullAdoption,
      canonicalPreserved: true,
      unselectedOriginalPreserved: true,
      curatedTagRetained: true,
      router,
      qualification:
        'Normally installed exact merged-wheel CLI through ordinary D4 human controls/D5 execution; no signed-package claim.',
    })
  }
  console.log(
    '[smoke] advanced Skillager exposure: both-agent native Full/Stub adoption, Group, add/remove membership, Ungroup and preserved original bytes/modes',
  )
  return proof

  async function selectOrigin(path: HostPath) {
    await ui.inspect(
      `(() => { const select=document.getElementById('advanced-origin'); const option=[...select.options].find(item=>item.textContent.includes(${JSON.stringify(path.path)}));if(!option)throw new Error('Exact origin unavailable'); select.value=option.value;select.dispatchEvent(new Event('input',{bubbles:true})); })()`,
    )
  }
  async function change(operation: string) {
    await ui.inspect("document.getElementById('result').textContent=''")
    await ui.click('preview-advanced')
    await ui.ready(
      `!document.getElementById('review').hidden && JSON.parse(document.getElementById('review-plan').textContent).request?.action===${JSON.stringify(operation)}`,
      `complete ${operation} review`,
    )
    await ui.click('confirm-plan')
    const result = await ui.result('change-exposure')
    if (
      result['outcome'] !== 'verified' ||
      result['operation'] !== operation ||
      !Array.isArray(result['results'])
    )
      throw new Error(`Advanced ${operation} returned no complete verified result`)
    return result
  }
}
