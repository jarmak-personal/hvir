import type { WebContents } from 'electron'
import { createHash } from 'node:crypto'
import { joinHostPath, localPath, type HostPath } from '../../shared/host-path'
import type { ProjectHost } from '../project-host/project-host'
import {
  skillagerManagementControls,
  type SkillagerManagementControls,
} from './skillager-management-controls'

/** Real installed CLI and isolated guest controls; all fixture/library writes stay owned. */
export async function verifyOwnedSaveUse(
  projectGuest: WebContents,
  detail: () => Promise<WebContents>,
  host: ProjectHost,
  workspace: HostPath,
  owned: HostPath,
  cli: (args: readonly string[]) => Promise<Record<string, unknown>>,
  controls: SkillagerManagementControls,
): Promise<Record<string, unknown>> {
  const project = skillagerManagementControls(projectGuest, controls)
  const beforeStatus = await cli(['library', 'status', '--json'])
  const cases: Record<string, unknown>[] = []
  for (const label of ['Codex', 'Claude']) {
    const provider = joinHostPath(workspace, label === 'Codex' ? '.agents' : '.claude')
    for (const path of [provider, joinHostPath(provider, 'skills')]) {
      try {
        await host.createDirectoryExclusive(path, { mode: 0o755 })
      } catch (error) {
        if ((error as { code?: string }).code !== 'EEXIST') throw error
      }
    }
    for (const mode of ['stub', 'native']) {
      const name = `owned-save-use-${mode}-${cases.length}`,
        original = joinHostPath(joinHostPath(provider, 'skills'), name),
        instruction = joinHostPath(original, 'SKILL.md'),
        support = joinHostPath(original, 'support.sh'),
        body = `---\nname: ${name}\ndescription: Use only for the owned Save and use fixture.\n---\n\nPreserve the exact original support files.\n`,
        helper = '#!/bin/sh\ntrue\n'
      await host.createDirectoryExclusive(original, { mode: 0o755 })
      await host.writeFile(instruction, body)
      await host.createFileExclusive(support, { mode: 0o755 })
      await host.writeFile(support, helper)
      await controls.click('Skills in this project')
      await project.set('query', name)
      await project.inspect("document.getElementById('search-form').requestSubmit()")
      await project.ready(
        `!![...document.querySelectorAll('#skills [role=option]')].find(e=>e.dataset.sourcePath===${JSON.stringify(instruction.path)})`,
        'Save and use exact original occurrence',
      )
      await project.inspect(
        `[...document.querySelectorAll('#skills [role=option]')].find(e=>e.dataset.sourcePath===${JSON.stringify(instruction.path)}).click()`,
      )
      const guest = await detail(),
        ui = skillagerManagementControls(guest, controls),
        control = mode === 'stub' ? 'exposure-stub' : 'exposure-full'
      await ui.ready(
        `(() => {const context=document.getElementById('exposure-context'),button=document.getElementById(${JSON.stringify(control)});return !!context&&!!button&&context.checkVisibility()&&!button.hidden&&!button.disabled})()`,
        'original copy choice',
      )
      const agent = await ui.inspect(
        `[...document.querySelectorAll('#task-agent option')].find(option=>option.textContent===${JSON.stringify(label)})?.value`,
      )
      if (typeof agent !== 'string' || !agent)
        throw new Error('The original’s agent is absent from the package choices')
      await ui.click(control)
      await ui.ready(
        "!document.getElementById('import-save').disabled&&document.getElementById('import-save').textContent.startsWith('Save and use')",
        'complete combined decision',
      )
      const preview = (await ui.inspect(
        "JSON.parse(document.getElementById('import-manifest').textContent)",
      )) as {
        schema: string
        mode: string
        agent: string
        import: {
          review_manifest: {
            library: { root: string; status: string }
            destination_id: string
            destination_path: string
            file_count: number
          }
        }
        replacement: { targets: Array<{ path: string; action: string }> }
      }
      const manifest = preview.import.review_manifest
      if (
        preview.schema !== 'skillager.import-placement.v1' ||
        preview.agent !== agent ||
        preview.mode !== mode ||
        manifest.file_count !== 2 ||
        !manifest.library.root.startsWith(`${owned.path}/`) ||
        !preview.replacement.targets.some(
          (target) => target.path === original.path && target.action === 'replace',
        )
      )
        throw new Error('Combined review lost exact effects or escaped the owned library')
      if (cases.length === 0) {
        await ui.click('import-cancel')
        const afterCancel = await cli(['library', 'status', '--json'])
        if (
          afterCancel['initialized'] !== beforeStatus['initialized'] ||
          (await host.readFile(instruction)).toString('utf8') !== body
        )
          throw new Error('Cancelled combined review initialized or replaced content')
        await ui.click(control)
        await ui.ready(
          "!document.getElementById('import-save').disabled",
          'fresh combined decision after cancellation',
        )
      }
      const progress = (await ui.inspect(`(() => {
        const button=document.getElementById('import-save');if(!button.checkVisibility()||button.disabled)throw new Error('Combined action unavailable');
        button.click();return {label:button.textContent,busy:document.getElementById('selected-import').getAttribute('aria-busy')};
      })()`)) as { label: string; busy: string }
      if (progress.label !== 'Saving…' || progress.busy !== 'true')
        throw new Error('Combined submit lacks immediate working feedback')
      await ui.ready(
        "(() => {try{return JSON.parse(document.getElementById('import-result').textContent).outcome==='verified'}catch{return false}})()",
        'verified Save and use completion',
      )
      const result = (await ui.inspect(
        "JSON.parse(document.getElementById('import-result').textContent)",
      )) as {
        action: string
        save: { status: string }
        placement: { status: string }
      }
      if (
        result.action !== 'save-and-use-copy' ||
        result.save.status !== 'accepted' ||
        result.placement.status !== 'applied'
      )
        throw new Error(
          'Combined result lost separate accepted-save and project outcomes',
        )
      const canonical = localPath(manifest.destination_path)
      if (
        (await host.readFile(joinHostPath(canonical, 'SKILL.md'))).toString('utf8') !==
          body ||
        (await host.readFile(joinHostPath(canonical, 'support.sh'))).toString('utf8') !==
          helper ||
        ((await host.stat(joinHostPath(canonical, 'support.sh'))).mode & 0o777) !== 0o755
      )
        throw new Error(
          'Combined save did not preserve complete original bytes and executable mode',
        )
      const inventory = await cli([
        'expose',
        '--list',
        '--agent',
        agent,
        '--scope',
        'project',
        '--json',
      ])
      const matches = (inventory['exposures'] as Array<Record<string, unknown>>).filter(
        (copy) => copy['target'] === original.path,
      )
      if (
        matches.length !== 1 ||
        matches[0]!['mode'] !== mode ||
        matches[0]!['skill_id'] !== manifest.destination_id
      )
        throw new Error(
          'Current project inventory does not match the chosen managed copy',
        )
      cases.push({
        agent,
        mode,
        initialized: manifest.library.status === 'will-initialize',
        accepted: true,
        managed: true,
        originalHash: createHash('sha256').update(body).digest('hex'),
        executableMode: 0o755,
        oneHumanDecision: true,
        immediateProgress: true,
      })
    }
  }
  return {
    initiallyRegistered: beforeStatus['initialized'],
    cancellationPreservedState: true,
    cases,
  }
}
