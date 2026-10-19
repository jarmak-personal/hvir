import { joinHostPath, type HostPath } from '../../shared/host-path'
import type { ProjectHost } from '../project-host/project-host'
import type { skillagerManagementControls } from './skillager-management-controls'

/** Unsupported previews remain explicit and complete; Skillager owns acceptance eligibility. */
export async function verifyOwnedReviewRefusals(
  ui: ReturnType<typeof skillagerManagementControls>,
  host: ProjectHost,
  source: HostPath,
  skillId: string,
  cli: (args: readonly string[]) => Promise<Record<string, unknown>>,
  catalog: HostPath,
): Promise<Record<string, unknown>> {
  const path = joinHostPath(source, 'owned-binary.dat'),
    bytes = Buffer.from('owned\0binary')
  await host.writeFile(path, bytes)
  try {
    await ui.set('skill-id', skillId)
    await ui.click('start-review')
    await ui.ready(
      "!document.getElementById('exact-review').hidden && !!document.querySelector('[data-review-path=\"owned-binary.dat\"]')",
      'complete unsupported manifest',
    )
    await ui.inspect(
      'document.querySelector(\'[data-review-path="owned-binary.dat"]\').click()',
    )
    await ui.ready(
      "document.getElementById('review-file-body').textContent.includes('owned-binary.dat:') && document.getElementById('review-file-body').textContent.includes('Preview unavailable')",
      'exact unsupported path and achievable CLI route',
    )
    if (!(await ui.inspect("document.querySelectorAll('[data-review-path]').length===4")))
      throw new Error('Unsupported eligible binary was omitted')
    if (!(await host.readFile(path)).equals(bytes))
      throw new Error('Unsupported review changed owned bytes')
  } finally {
    await host.removeFile(path)
  }
  // Public block decisions are state-scoped; canonical status reads this owned catalog trust scope.
  await cli(['--state-dir', catalog.path, 'review', 'block', skillId, '--json'])
  const status = await cli(['library', 'status', skillId, '--json'])
  if ((status['skill'] as Record<string, unknown>)['acceptance'] !== 'blocked')
    throw new Error('Owned public blocked fixture state was not established')
  await ui.set('skill-id', skillId)
  await ui.inspect("document.getElementById('state').textContent=''")
  await ui.click('observe-source')
  await ui.ready(
    "document.getElementById('state').textContent.includes('Reading remains available')",
    'blocked source has an achievable review/refresh next step',
  )
  await ui.ready(
    `document.getElementById('skill-id').value===${JSON.stringify(skillId)} && document.querySelector('main').getAttribute('aria-busy')==='false' && document.getElementById('add-copy').disabled`,
    'blocked exact source cannot become cached Add authority',
  )
  const beforeBlockedAdd = await ui.inspect(
    "document.getElementById('result').textContent",
  )
  await ui.inspect("document.getElementById('add-copy').click()")
  if (
    (await ui.inspect("document.getElementById('result').textContent")) !==
    beforeBlockedAdd
  )
    throw new Error('Blocked Add control submitted an action')
  await ui.click('start-review')
  await ui.ready(
    "!document.getElementById('exact-review').hidden && !!document.querySelector('[data-review-path=\"SKILL.md\"]')",
    'blocked exact metadata remains independently available',
  )
  await ui.inspect('document.querySelector(\'[data-review-path="SKILL.md"]\').click()')
  await ui.ready(
    "document.getElementById('state').textContent==='' && document.getElementById('review-file-label').textContent.startsWith('SKILL.md · ') && document.getElementById('review-file-body').textContent.includes('owned-consumer') && !document.getElementById('review-file-body').textContent.startsWith('Preview unavailable')",
    'blocked human current text remains readable',
  )
  // The CLI can offer an explicit acceptance command for a blocked version.
  // Reading must leave canonical acceptance unchanged; button readiness is not approval.
  const afterRead = await cli(['library', 'status', skillId, '--json']),
    beforeSkill = status['skill'] as Record<string, unknown>,
    afterSkill = afterRead['skill'] as Record<string, unknown>
  if (
    afterSkill['acceptance'] !== 'blocked' ||
    afterSkill['accepted_hash'] !== beforeSkill['accepted_hash']
  )
    throw new Error('Independent blocked reading changed canonical acceptance')
  return {
    unsupportedPath: path,
    completeManifestRetained: true,
    unsupportedPreviewLabeled: true,
    publicBlockedObserved: true,
    blockTrustScope: catalog,
    blockQualification:
      'Public explicit state-directory catalog block; no private trust-file edit',
    blockedAddUnavailable: true,
    blockedHumanReadAvailable: true,
    noImplicitAcceptance: true,
  }
}
