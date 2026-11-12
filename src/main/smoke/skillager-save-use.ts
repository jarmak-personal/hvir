import type { WebContents } from 'electron'
import { createHash } from 'node:crypto'
import { joinHostPath, localPath, type HostPath } from '../../shared/host-path'
import type { ProjectHost } from '../project-host/project-host'
import {
  skillagerManagementControls,
  type SkillagerManagementControls,
} from './skillager-management-controls'
import { smokeScriptValue } from './script-value'

/** Real installed CLI and isolated guest controls; all fixture/library writes stay owned. */
export async function verifyOwnedSaveUse(
  projectGuest: WebContents,
  detail: () => Promise<WebContents>,
  host: ProjectHost,
  workspace: HostPath,
  owned: HostPath,
  cli: (
    args: readonly string[],
    expectedExit?: number,
  ) => Promise<Record<string, unknown>>,
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
      const ui = await select(instruction, name),
        control = mode === 'stub' ? 'exposure-stub' : 'exposure-full',
        agent = await agentChoice(ui, label)
      await prepare(ui, mode)
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
  const registration = await cli(['library', 'status', '--json']),
    library = localPath((registration['library'] as { root: string }).root),
    root = joinHostPath(joinHostPath(workspace, '.agents'), 'skills'),
    failures: Record<string, unknown> = {}
  if (!library.path.startsWith(`${owned.path}/`))
    throw new Error('Current library escaped the owned fixture')
  async function original(name: string) {
    const directory = joinHostPath(root, name),
      instruction = joinHostPath(directory, 'SKILL.md'),
      body = `---\nname: ${name}\ndescription: Use only in the owned Save and use refusal fixture.\n---\n\nKeep this original until a reviewed replacement succeeds.\n`
    await host.createDirectoryExclusive(directory, { mode: 0o755 })
    await host.writeFile(instruction, body)
    return { directory, instruction, body, ui: await select(instruction, name) }
  }
  async function absent(path: HostPath) {
    try {
      await host.stat(path)
    } catch (error) {
      if ((error as { code?: string }).code === 'ENOENT') return
      throw error
    }
    throw new Error('Refused Save and use wrote its canonical destination')
  }
  const collision = await original('owned-combined-collision')
  await prepare(collision.ui, 'stub')
  const occupied = joinHostPath(joinHostPath(library, 'skills'), 'owned-save-use-stub-0'),
    beforeCollision = await host.readFile(joinHostPath(occupied, 'SKILL.md')),
    beforeSupport = await host.readFile(joinHostPath(occupied, 'support.sh'))
  await collision.ui.inspect(
    "if(!document.getElementById('import-options').open)document.querySelector('#import-options > summary').click()",
  )
  await collision.ui.set('import-name', 'owned-save-use-stub-0')
  await collision.ui.click('import-refresh')
  await collision.ui.ready(
    "document.getElementById('import-save').disabled && document.getElementById('import-state').textContent.includes('already exists')",
    'occupied combined destination refuses without overwriting',
  )
  if (
    (await host.readFile(collision.instruction)).toString() !== collision.body ||
    !(await host.readFile(joinHostPath(occupied, 'SKILL.md'))).equals(beforeCollision) ||
    !(await host.readFile(joinHostPath(occupied, 'support.sh'))).equals(beforeSupport)
  )
    throw new Error('Collision changed the original or occupied canonical bytes')
  failures.collisionRefused = true
  for (const change of ['instruction', 'extra-project-file']) {
    const name = `owned-combined-drift-${change}`,
      fixture = await original(name)
    await prepare(fixture.ui, 'stub')
    const review = await manifest(fixture.ui)
    if (change === 'instruction')
      await host.writeFile(
        fixture.instruction,
        `${fixture.body}\nChanged after review.\n`,
      )
    else
      await host.writeFile(
        joinHostPath(fixture.directory, 'extra.txt'),
        'Added after review.\n',
      )
    // Exercise both the ordinary guest submission and the exact displayed public argv.
    await fixture.ui.click('import-save')
    await fixture.ui.ready(
      "document.getElementById('import-state').textContent.includes('This original or its destination changed. Review Save and use again.') && document.getElementById('import-save').disabled && document.getElementById('import-reconcile').hidden && document.getElementById('selected-import').getAttribute('aria-busy')==='false'",
      'changed original refuses before submission through the public action error',
    )
    const refused = await cli(review.next_command_argv.slice(1), 2)
    if (
      refused['schema'] !== 'skillager.import-placement.v1' ||
      refused['status'] !== 'refused' ||
      (refused['save'] as Record<string, unknown>)['status'] !== 'not-started' ||
      (refused['placement'] as Record<string, unknown>)['status'] !== 'not-started'
    )
      throw new Error(
        'Stale complete decision did not return structured no-effect refusal',
      )
    await absent(localPath(review.import.review_manifest.destination_path))
    const expected =
      change === 'instruction' ? `${fixture.body}\nChanged after review.\n` : fixture.body
    if (
      (await host.readFile(fixture.instruction)).toString() !== expected ||
      (change === 'extra-project-file' &&
        (await host.readFile(joinHostPath(fixture.directory, 'extra.txt'))).toString() !==
          'Added after review.\n')
    )
      throw new Error('Refused stale decision changed current project files')
    failures[change] = {
      guest: 'no-effect-action-error',
      publicCliExit: 2,
      save: 'not-started',
      placement: 'not-started',
    }
  }
  const preserved = await original('owned-combined-preserved')
  await preserved.ui.ready(
    "!document.getElementById('import-save').disabled",
    'standalone save review',
  )
  await preserved.ui.click('import-save')
  await outcome(preserved.ui, 'verified')
  await preserved.ui.ready(
    "!document.getElementById('exposure-stub').disabled",
    'saved original replacement',
  )
  await preserved.ui.click('exposure-stub')
  await preserved.ui.ready(
    "!document.getElementById('exposure-review').hidden && JSON.parse(document.getElementById('exposure-plan').textContent).request.action==='adopt-native'",
    'already preserved original uses adoption review',
  )
  await preserved.ui.click('exposure-confirm')
  await preserved.ui.ready(
    "(() => {try{const r=JSON.parse(document.getElementById('exposure-result').textContent);return r.outcome==='verified'&&r.action==='change-exposure'&&r.operation==='adopt-native'}catch{return false}})()",
    'existing saved original adopts without another import',
  )
  if (
    (
      await host.readFile(
        joinHostPath(
          joinHostPath(joinHostPath(library, 'skills'), 'owned-combined-preserved'),
          'SKILL.md',
        ),
      )
    ).toString() !== preserved.body
  )
    throw new Error('Adoption changed the previously saved canonical')
  failures.preservedOriginal = {
    action: 'change-exposure',
    operation: 'adopt-native',
    canonicalPreserved: true,
  }
  const denied = await original('owned-combined-denied')
  await prepare(denied.ui, 'stub')
  const deniedReview = await manifest(denied.ui),
    skills = joinHostPath(library, 'skills'),
    permissions = (await host.stat(skills)).mode & 0o777
  async function chmod(path: HostPath, mode: number) {
    const result = await host.exec('chmod', [mode.toString(8), path.path], {
      cwd: library,
    })
    if (result.code !== 0)
      throw new Error('Owned failure fixture permission change failed')
  }
  await chmod(skills, 0o500)
  try {
    await denied.ui.click('import-save')
    await outcome(denied.ui, 'uncertain')
  } finally {
    await chmod(skills, permissions)
  }
  await absent(localPath(deniedReview.import.review_manifest.destination_path))
  failures.absent = await reconcile(denied.ui, 'destination-absent')
  await denied.ui.click('import-refresh')
  await denied.ui.ready(
    "!document.getElementById('import-save').disabled",
    'new explicit compound review after acknowledgment',
  )
  await absent(localPath(deniedReview.import.review_manifest.destination_path))
  if ((await host.readFile(denied.instruction)).toString() !== denied.body)
    throw new Error('Denied save changed original bytes')
  await denied.ui.click('import-cancel')
  if ((registration['git'] as { mode: string }).mode === 'system') {
    const pending = await original('owned-combined-pending')
    await prepare(pending.ui, 'stub')
    const hook = joinHostPath(
      joinHostPath(joinHostPath(library, '.git'), 'hooks'),
      'pre-commit',
    )
    await host.writeFile(hook, '#!/bin/sh\nexit 1\n')
    await chmod(hook, 0o700)
    try {
      await pending.ui.click('import-save')
      await outcome(pending.ui, 'uncertain')
      failures.pending = await reconcile(pending.ui, 'pending')
      if ((await host.readFile(pending.instruction)).toString() !== pending.body)
        throw new Error('Pending save changed project original')
    } finally {
      await host.removeFile(hook)
    }
  } else
    failures.pending = {
      qualification: 'Git failure is exercised only in the separate Git fixture.',
    }
  return {
    initiallyRegistered: beforeStatus['initialized'],
    cancellationPreservedState: true,
    cases,
    failures,
  }

  async function select(instruction: HostPath, name: string) {
    await controls.click('Skills in this project')
    await project.set('query', name)
    await project.inspect("document.getElementById('search-form').requestSubmit()")
    await project.ready(
      `!![...document.querySelectorAll('#skills [data-skill-select]')].find(e=>e.dataset.sourcePath===${JSON.stringify(instruction.path)})`,
      'Save and use exact original occurrence',
    )
    await project.inspect(
      `[...document.querySelectorAll('#skills [data-skill-select]')].find(e=>e.dataset.sourcePath===${JSON.stringify(instruction.path)}).click()`,
    )
    const ui = skillagerManagementControls(await detail(), controls)
    await ui.ready(
      `document.getElementById('source-label')?.textContent.endsWith(${JSON.stringify(` · local: ${instruction.path}`)})`,
      'selected exact original identity',
    )
    return ui
  }
  async function agentChoice(
    ui: ReturnType<typeof skillagerManagementControls>,
    label: string,
  ) {
    const agent = await ui.inspect(
      `[...document.querySelectorAll('#task-agent option')].find(option=>option.textContent===${JSON.stringify(label)})?.value`,
    )
    if (typeof agent !== 'string' || !agent)
      throw new Error('The original’s agent is absent from the package choices')
    return agent
  }
  async function prepare(
    ui: ReturnType<typeof skillagerManagementControls>,
    mode: string,
  ) {
    const control = mode === 'stub' ? 'exposure-stub' : 'exposure-full'
    await ui.ready(
      `(() => {const context=document.getElementById('exposure-context'),button=document.getElementById(${smokeScriptValue(control)});return !!context&&!!button&&context.checkVisibility()&&!button.hidden&&!button.disabled})()`,
      'original copy choice',
    )
    await ui.click(control)
    await ui.ready(
      "!document.getElementById('import-save').disabled&&document.getElementById('import-save').textContent.startsWith('Save and use')",
      'complete combined decision',
    )
  }
  async function manifest(ui: ReturnType<typeof skillagerManagementControls>) {
    return (await ui.inspect(
      "JSON.parse(document.getElementById('import-manifest').textContent)",
    )) as {
      next_command_argv: string[]
      import: { review_manifest: { destination_path: string } }
    }
  }
  async function outcome(
    ui: ReturnType<typeof skillagerManagementControls>,
    expected: string,
  ) {
    try {
      await ui.ready(
        `(() => {try{return JSON.parse(document.getElementById('import-result').textContent).outcome===${smokeScriptValue(expected)}}catch{return false}})()`,
        `Save and use ${expected} result`,
      )
    } catch (error) {
      const facts = await ui.inspect(`(() => {
        let result;try{result=JSON.parse(document.getElementById('import-result').textContent)}catch{}
        const state=document.getElementById('import-state').textContent.toLowerCase();
        return {resultPresent:!!result,outcome:['verified','refused','uncertain','saved-not-replaced'].includes(result?.outcome)?result.outcome:null,
          operationPresent:typeof result?.operationId==='string',compound:result?.action==='save-and-use-copy',
          visible:document.getElementById('selected-import').checkVisibility(),busy:document.getElementById('selected-import').getAttribute('aria-busy'),
          stateClasses:['changed','review','frequency','capacity','timed out','not-started','refused','saving','invalid','schema','unknown'].filter(value=>state.includes(value))};
      })()`)
      console.log('[smoke] Save and use result boundary', JSON.stringify(facts))
      throw error
    }
  }
  async function reconcile(
    ui: ReturnType<typeof skillagerManagementControls>,
    expected: string,
  ) {
    await ui.click('import-reconcile')
    await ui.ready(
      "document.getElementById('import-reconcile').textContent==='Acknowledge current facts'",
      'current original and destination facts',
    )
    const response = (await ui.inspect(
        "JSON.parse(document.getElementById('import-result').textContent)",
      )) as { observation: string },
      facts = JSON.parse(response.observation) as {
        state?: string
        acceptance?: string
        originalCompletion: string
        partialFiles: string
        project: { state: string; content: string }
      }
    if (
      (facts.state ?? facts.acceptance) !== expected ||
      facts.originalCompletion !== 'unknown' ||
      facts.partialFiles !== 'unknown' ||
      facts.project.state !== 'original-present' ||
      facts.project.content !== 'not-asserted'
    )
      throw new Error('Current original observation overstated incomplete effects')
    await ui.click('import-reconcile')
    await ui.ready(
      "document.getElementById('import-reconcile').hidden",
      'specific compound uncertainty acknowledged without replay',
    )
    return { ...facts, acknowledgmentDidNotReplay: true }
  }
}
