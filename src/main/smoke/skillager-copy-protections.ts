import { joinHostPath, type HostPath } from '../../shared/host-path'
import type { ProjectHost } from '../project-host/project-host'
import type { skillagerManagementControls } from './skillager-management-controls'

/** Owned local edits and foreign bytes stay preserved through actual consumer refusal. */
export async function verifyOwnedCopyProtections(
  ui: ReturnType<typeof skillagerManagementControls>,
  host: ProjectHost,
  target: HostPath,
  owned: HostPath,
  agent: string,
  exposureId: string,
): Promise<Record<string, unknown>> {
  const supportPath = joinHostPath(target, 'support.sh'),
    original = await host.readFile(supportPath),
    modified = Buffer.concat([
      original,
      Buffer.from('\nOwned local edit must survive.\n'),
    ])
  await host.writeFile(supportPath, modified)
  try {
    await ui.observeCopies({ agent, exposureId, target })
    await ui.set('copy-mode', 'stub')
    await ui.inspect(
      `(() => { document.getElementById('state').textContent=''; const row=[...document.querySelectorAll('#managed-copies > div')].find(e=>e.querySelector('p').textContent.startsWith(${JSON.stringify(agent)})); row.querySelector('button').click(); })()`,
    )
    await ui.ready(
      "document.getElementById('state').textContent.includes('preserve the existing target')",
      'modified Update refuses before confirmation',
    )
    if (!(await ui.inspect("document.getElementById('review').hidden")))
      throw new Error('Modified Update incorrectly offered a complete confirmation')
    if (!(await host.readFile(supportPath)).equals(modified))
      throw new Error('Protected Update changed owned local edit before refusal')
    await ui.inspect(
      `(() => { document.getElementById('state').textContent=''; const row=[...document.querySelectorAll('#managed-copies > div')].find(e=>e.querySelector('p').textContent.startsWith(${JSON.stringify(agent)})); row.querySelectorAll('button')[1].click(); })()`,
    )
    await ui.ready(
      "document.getElementById('state').textContent.includes('forced removal is unavailable')",
      'modified Remove preserves required-force target',
    )
    if (!(await host.readFile(supportPath)).equals(modified))
      throw new Error('Protected Update/Remove changed owned local edit')
  } finally {
    await host.writeFile(supportPath, original)
  }
  const held = joinHostPath(owned, `${agent}-held-managed`),
    foreign = 'Owned foreign target bytes; never adopt or replace.\n'
  await host.fileTransfer!.renameNoReplace(target, held)
  try {
    await host.createDirectoryExclusive(target, { mode: 0o755 })
    await host.writeFile(joinHostPath(target, 'SKILL.md'), foreign)
    await ui.set('copy-mode', 'native')
    await ui.inspect("document.getElementById('result').textContent=''")
    await ui.click('add-copy')
    const result = await ui.result('add-copy')
    if (
      result['outcome'] !== 'refused' ||
      (await host.readFile(joinHostPath(target, 'SKILL.md'))).toString('utf8') !==
        foreign ||
      (await host.readdir(target)).map((entry) => entry.name).join(',') !== 'SKILL.md'
    )
      throw new Error(
        'Direct Add failed to preserve the complete foreign target without sidecar/adoption',
      )
    return {
      agent,
      modifiedUpdateRefused: true,
      modifiedRemoveRefused: true,
      modifiedBytesPreserved: true,
      foreignAdd: result,
      foreignBytesPreserved: true,
      foreignSidecarAbsent: true,
    }
  } finally {
    await host.removeFile(joinHostPath(target, 'SKILL.md'))
    await host.fileTransfer!.removeDirectory(target)
    await host.fileTransfer!.renameNoReplace(held, target)
  }
}
