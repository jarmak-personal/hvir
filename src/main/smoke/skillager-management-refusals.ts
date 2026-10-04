import { joinHostPath, type HostPath } from '../../shared/host-path'
import type { ProjectHost } from '../project-host/project-host'
import type { skillagerManagementControls } from './skillager-management-controls'

/** Complete unsupported manifests refuse approval, while blocked current text remains human-readable. */
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
      "document.getElementById('state').textContent.includes('owned-binary.dat:') && document.getElementById('state').textContent.includes('public Skillager CLI')",
      'exact unsupported path and achievable CLI route',
    )
    if (
      !(await ui.inspect(
        "document.getElementById('accept-version').disabled && document.querySelectorAll('[data-review-path]').length===4",
      ))
    )
      throw new Error('Unsupported eligible binary was omitted or called ready')
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
  await ui.click('add-copy')
  await ui.ready(
    "document.getElementById('state').textContent.includes('Select the current accepted source version explicitly')",
    'blocked source cannot become cached Add authority',
  )
  await ui.click('start-review')
  await ui.ready(
    "!document.getElementById('exact-review').hidden && !!document.querySelector('[data-review-path=\"SKILL.md\"]')",
    'blocked exact metadata remains independently available',
  )
  await ui.inspect('document.querySelector(\'[data-review-path="SKILL.md"]\').click()')
  await ui.ready(
    "document.getElementById('state').textContent.includes('complete supported bytes verified')",
    'blocked human current text remains readable',
  )
  if (!(await ui.inspect("document.getElementById('accept-version').disabled")))
    throw new Error('Independent blocked reading implicitly accepted a version')
  return {
    unsupportedPath: path,
    completeManifestRetained: true,
    unsupportedAcceptanceRefused: true,
    publicBlockedObserved: true,
    blockTrustScope: catalog,
    blockQualification:
      'Public explicit state-directory catalog block; no private trust-file edit',
    blockedAddUnavailable: true,
    blockedHumanReadAvailable: true,
    noImplicitAcceptance: true,
  }
}
