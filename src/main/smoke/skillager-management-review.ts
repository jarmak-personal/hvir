import type { skillagerManagementControls } from './skillager-management-controls'

type ReviewControls = ReturnType<typeof skillagerManagementControls>

/** Human optional file inspection and one exact-version acceptance action. */
export async function reviewOwnedSkill(
  controls: ReviewControls,
  skillId: string,
  expectedFiles: readonly string[],
): Promise<Record<string, unknown>> {
  await controls.set('skill-id', skillId)
  await controls.ready(
    "document.querySelector('main').getAttribute('aria-busy')==='false'",
    'automatic selected-source observation settled',
  )
  await controls.click('start-review')
  await controls.ready(
    "!document.getElementById('exact-review').hidden && !document.getElementById('accept-version').disabled && document.querySelectorAll('[data-review-path]').length>0",
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
    const verified = `document.getElementById('state').textContent==='' && document.getElementById('review-file-label').textContent.startsWith(${JSON.stringify(`${path} · `)}) && !document.getElementById('review-file-body').textContent.startsWith('Preview unavailable')`
    await controls.ready(
      path.endsWith('.png')
        ? `!!document.querySelector('#review-file-body img')?.complete && document.querySelector('#review-file-body img').naturalWidth>0 && ${verified}`
        : `document.getElementById('review-file-body').textContent.length>0 && ${verified}`,
      'optional supported file inspection',
    )
  }
  await controls.inspect("document.getElementById('result').textContent=''")
  await controls.click('accept-version')
  const accepted = await controls.result('accept-version').catch(async (error) => {
    console.log(
      '[smoke] exact review acceptance boundary',
      await controls.inspect(
        "({state:document.getElementById('state').textContent.slice(0,512),disabled:document.getElementById('accept-version').disabled,visible:document.getElementById('accept-version').checkVisibility(),reviewHidden:document.getElementById('exact-review').hidden})",
      ),
    )
    throw error
  })
  if (accepted['outcome'] !== 'verified')
    throw new Error('Owned exact acceptance did not return a verified outcome')
  return accepted
}
