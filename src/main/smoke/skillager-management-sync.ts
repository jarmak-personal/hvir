import { joinHostPath, type HostPath } from '../../shared/host-path'
import type { ProjectHost } from '../project-host/project-host'
import type { skillagerManagementControls } from './skillager-management-controls'
import { createHash } from 'node:crypto'

/** Authored external setup uses public approval solely to exercise the approved-sync consumer. */
export async function verifyOwnedApprovedSync(
  ui: ReturnType<typeof skillagerManagementControls>,
  host: ProjectHost,
  owned: HostPath,
  library: HostPath,
  cli: (args: readonly string[]) => Promise<Record<string, unknown>>,
): Promise<readonly Record<string, unknown>[]> {
  const collection = joinHostPath(owned, 'collection'),
    held = joinHostPath(owned, 'library-held'),
    support = 'Owned approved-sync support only.\n',
    proof: Record<string, unknown>[] = []
  await host.createDirectoryExclusive(collection, { mode: 0o755 })
  for (const name of ['backfill', 'pinned']) {
    const source = joinHostPath(collection, name)
    await host.createDirectoryExclusive(source, { mode: 0o755 })
    await host.writeFile(joinHostPath(source, 'support.txt'), support)
  }
  await cli(['collection', 'add', collection.path, '--name', 'owned', '--json'])
  let pinnedBody = ''
  for (const [name, phase, decision] of [
    ['backfill', 'created', 'approve'],
    ['backfill', 'updated', 'approve'],
    ['pinned', 'created', 'pin'],
    ['pinned', 'conflict', 'approve'],
  ] as const) {
    const source = joinHostPath(collection, name)
    const body = `---\nname: ${name}\ndescription: Use only for an owned synchronization fixture.\n---\n\nOwned completely inspected ${phase} revision.\n`
    await host.writeFile(joinHostPath(source, 'SKILL.md'), body)
    const files = (await host.readdir(source)).map((entry) => entry.name).sort()
    if (
      JSON.stringify(files) !== JSON.stringify(['SKILL.md', 'support.txt']) ||
      (await host.readFile(joinHostPath(source, 'SKILL.md'))).toString('utf8') !== body ||
      (await host.readFile(joinHostPath(source, 'support.txt'))).toString('utf8') !==
        support
    )
      throw new Error('External approved-sync fixture was not completely inspected')
    // Isolate external approval from automatic sync; restore the complete owned library in finally.
    await host.fileTransfer!.renameNoReplace(library, held)
    let approved: Record<string, unknown>
    try {
      approved = await cli(['review', decision, `owned/${name}`, '--json'])
    } finally {
      await host.fileTransfer!.renameNoReplace(held, library)
    }
    if (
      (
        (approved['action'] as Record<string, unknown>)['library_sync'] as Record<
          string,
          unknown
        >
      )['status'] !== 'refused'
    )
      throw new Error(
        'External setup unexpectedly auto-synchronized instead of exercising explicit sync',
      )
    await ui.click('preview-sync')
    try {
      await ui.ready(
        "!document.getElementById('review').hidden && document.getElementById('review-title').textContent.includes('synchronization')",
        'complete approved-source sync preflight',
      )
    } catch (error) {
      const diagnostic = await ui
        .inspect(
          `(() => {
        const state=document.getElementById('state')?.textContent ?? '';
        const classes=['action-result bound','32-source report','coverage','identity','frequency','cancelled','unavailable'];
        return {reviewHidden:document.getElementById('review')?.hidden !== false,
          expectedTitle:document.getElementById('review-title')?.textContent.includes('synchronization') === true,
          refusalClasses:classes.filter(value=>state.includes(value))};
      })()`,
        )
        .catch(() => ({ inspectionUnavailable: true }))
      console.log('[smoke] Skillager sync preflight boundary', JSON.stringify(diagnostic))
      throw error
    }
    await ui.inspect("document.getElementById('result').textContent=''")
    await ui.click('confirm-plan')
    const result = await ui.result('sync-library')
    if (
      result['outcome'] !== (phase === 'conflict' ? 'partial' : 'verified') ||
      (result['counts'] as Record<string, unknown>)[phase] !== 1
    )
      throw new Error(`Explicit sync ${phase} was not completely reported`)
    const item = (result['items'] as Array<Array<string | null>>).find(
        (item) => item[2] === phase,
      ),
      id = item?.[1]
    if (!id?.startsWith('lib/'))
      throw new Error('Explicit sync has no canonical identity for its observed effect')
    const target = joinHostPath(joinHostPath(library, 'skills'), id.slice(4))
    if (name === 'pinned' && phase === 'created') pinnedBody = body
    const expectedBody = phase === 'conflict' ? pinnedBody : body
    if (phase === 'conflict' && item?.[4] !== 'canonical-pinned')
      throw new Error(
        'Pinned synchronization omitted its authoritative protection reason',
      )
    if (name === 'pinned') {
      const observed = await cli(['library', 'sync', '--status', '--json'])
      const lineage = (
        observed['lineages'] as Array<{ canonical: Record<string, unknown> }>
      ).find((entry) => entry.canonical['skill_id'] === id)
      if (
        lineage?.canonical['trust'] !== 'pinned' ||
        lineage.canonical['acceptance'] !== 'accepted'
      )
        throw new Error(
          'Public upstream pin did not retain an accepted pinned canonical version',
        )
    }
    if (
      JSON.stringify((await host.readdir(target)).map((entry) => entry.name).sort()) !==
      JSON.stringify(['SKILL.md', 'support.txt'])
    )
      throw new Error('Synchronized canonical tree has an unexpected complete file set')
    if (
      (await host.readFile(joinHostPath(target, 'SKILL.md'))).toString('utf8') !==
        expectedBody ||
      (await host.readFile(joinHostPath(target, 'support.txt'))).toString('utf8') !==
        support
    )
      throw new Error('Explicit approved-source sync changed authored body/support bytes')
    const completeFiles = []
    for (const name of ['SKILL.md', 'support.txt']) {
      const path = joinHostPath(target, name),
        bytes = await host.readFile(path)
      if (
        ((await host.stat(path)).mode & 0o111) !==
        ((await host.stat(joinHostPath(source, name))).mode & 0o111)
      )
        throw new Error('Synchronization changed authored executable state')
      completeFiles.push({
        name,
        bytes: bytes.length,
        sha256: createHash('sha256').update(bytes).digest('hex'),
        executable: ((await host.stat(path)).mode & 0o111) !== 0,
      })
    }
    proof.push({
      phase,
      source: name,
      decision,
      pinnedCanonicalPreserved: phase === 'conflict',
      qualification:
        'Complete authored external fixture inspection/public source approval solely for approved-sync diagnostic; no hvir acceptance substitution.',
      publicSourceApprovalObserved: true,
      automaticSyncStatus: 'refused',
      result,
      completeFiles,
    })
  }
  return proof
}
