import type { skillagerManagementControls } from './skillager-management-controls'

type ReviewControls = ReturnType<typeof skillagerManagementControls>

/** Human optional file inspection and one exact-version acceptance action. */
export async function reviewOwnedSkill(
  controls: ReviewControls,
  skillId: string,
  expectedFiles: readonly string[],
): Promise<Record<string, unknown>> {
  await controls.set('skill-id', skillId)
  await controls.click('start-review')
  await controls.ready(
    "!document.getElementById('exact-review').hidden && document.getElementById('state').textContent.includes('Inspect any file')",
    'complete owned review manifest',
  )
  const files = (await controls.inspect(
    "[...document.querySelectorAll('[data-review-path]')].map(e=>e.dataset.reviewPath)",
  )) as string[]
  if (JSON.stringify([...files].sort()) !== JSON.stringify([...expectedFiles].sort()))
    throw new Error('Owned complete review omitted or substituted an eligible file')
  // The complete inventory is available without visitation or acknowledgment gates.
  await controls.ready(
    "!document.getElementById('accept-version').disabled",
    'one exact version decision',
  )
  for (const path of expectedFiles.filter(
    (file) => file === 'SKILL.md' || file === 'owned.png',
  )) {
    await controls.inspect(
      `document.querySelector('[data-review-path=${JSON.stringify(path)}]').click()`,
    )
    await controls.ready(
      path.endsWith('.png')
        ? "!!document.querySelector('#review-file-body img')?.complete && document.getElementById('review-page-label').textContent.includes('complete bytes verified')"
        : "document.getElementById('review-file-body').textContent.length>0 && document.getElementById('state').textContent.includes('complete supported bytes verified')",
      'optional supported file inspection',
    )
  }
  await controls.inspect("document.getElementById('result').textContent=''")
  await controls.click('accept-version')
  const accepted = await controls.result('accept-version')
  if (accepted['outcome'] !== 'verified')
    throw new Error('Owned exact acceptance did not return a verified outcome')
  return accepted
}
