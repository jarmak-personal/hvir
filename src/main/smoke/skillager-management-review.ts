import type { skillagerManagementControls } from './skillager-management-controls'

type ReviewControls = ReturnType<typeof skillagerManagementControls>

/** Human complete current-file presentation, acknowledgments and exact public action. */
export async function reviewOwnedSkill(
  controls: ReviewControls,
  skillId: string,
  expectedFiles: readonly string[],
): Promise<Record<string, unknown>> {
  await controls.set('skill-id', skillId)
  await controls.click('start-review')
  await controls.ready(
    "!document.getElementById('exact-review').hidden && document.getElementById('state').textContent.includes('manifest loaded')",
    'complete owned review manifest',
  )
  const files = (await controls.inspect(
    "[...document.querySelectorAll('[data-review-path]')].map(e=>e.dataset.reviewPath)",
  )) as string[]
  if (JSON.stringify([...files].sort()) !== JSON.stringify([...expectedFiles].sort()))
    throw new Error('Owned complete review omitted or substituted an eligible file')
  for (const path of files) {
    await controls.inspect(
      `document.querySelector('[data-review-path='+CSS.escape(${JSON.stringify(path)})+']').click()`,
    )
    await controls.ready(
      "!document.getElementById('acknowledge-file').disabled || !document.getElementById('review-next').disabled",
      `complete owned file ${path}`,
    )
    while (!(await controls.inspect("document.getElementById('review-next').disabled")))
      await controls.click('review-next')
    await controls.click('acknowledge-file')
    await controls.ready(
      "document.getElementById('state').textContent.includes('complete files acknowledged')",
      `human acknowledgment ${path}`,
    )
  }
  await controls.click('prepare-acceptance')
  await controls.ready(
    "!document.getElementById('accept-version').disabled",
    'fresh identical exact manifest/token',
  )
  await controls.inspect("document.getElementById('result').textContent=''")
  await controls.click('accept-version')
  const accepted = await controls.result('accept-version')
  if (accepted['outcome'] !== 'verified')
    throw new Error('Owned exact acceptance did not return a verified outcome')
  return accepted
}
