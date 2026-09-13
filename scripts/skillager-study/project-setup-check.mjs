// Browser checks for the synthetic project-setup journey, using the existing study runner.
export async function checkProjectSetupStudy({
  flow,
  click,
  pointClick,
  choose,
  run,
  assert,
  waitFor,
  capture,
  absent,
}) {
  await flow('project-existing')
  await assert(
    `document.querySelectorAll('[data-native]').length===4 && document.querySelector('#project-skill-list').textContent.includes('Pending review') && document.querySelector('#project-skill-list').textContent.includes('Lint blocked') && document.querySelector('#project-skill-list').textContent.includes('Approved') && document.querySelector('#project-skill-list').textContent.includes('Blocked') && document.querySelector('#project-skill-list').textContent.includes('Claude Code') && document.querySelector('#project-skill-list').textContent.includes('Codex') && document.querySelector('#content').textContent.includes('Managed copy')`,
    'Public project metadata includes existing approved, pending and lint-blocked native skills separately from managed copies before setup',
  )
  await pointClick('[data-native="project-draft"]')
  await assert(
    `document.querySelector('#skills-view').textContent.includes('Project native · Unmanaged') && document.querySelector('#skills-view').textContent.includes('Pending review') && document.querySelector('#skills-view').textContent.includes('/.claude/skills/project-draft') && !document.querySelector('#skills-view [data-action="add"]') && !document.querySelector('#skills-view [data-action="update"]') && !document.querySelector('#skills-view [data-action="remove"]') && !document.querySelector('#skills-view [data-action="accept"]')`,
    'Native metadata details confer no managed mutation or canonical-library acceptance actions',
  )
  await click('[data-viewer="document"]')
  await pointClick('[data-action="refresh"]')
  await assert(
    `document.querySelector('#project-readiness').textContent.includes('Pending review') && document.querySelector('#setup-terminal').hidden && !document.querySelector('#setup-terminal-tabs button')`,
    'Observation keeps pending metadata visible without launching setup or installing Working',
  )
  await choose('#agent', 'claude')
  await assert(
    `document.querySelector('.project-setup').textContent.includes('Claude Code') && document.querySelector('.project-setup code').textContent==='skillager setup --agent claude' && document.querySelector('.project-setup').textContent.includes('Local · hvir / main')`,
    'The compact setup action displays its exact local project and selected agent before launch',
  )
  await capture('project-existing')
  const original = await run(`document.querySelector('#ordinary-terminal').innerHTML`)
  await pointClick('[data-action="project-setup"]')
  await assert(
    `document.querySelector('[data-action="project-setup"]').disabled && document.querySelector('[data-action="project-setup"]').textContent==='Opening new terminal…' && !document.querySelector('#setup-terminal-tabs button')`,
    'One pending explicit handoff disables duplicate setup before a new terminal is attached',
  )
  await waitFor(`!document.querySelector('#setup-terminal').hidden`)
  await run('studyTimers.projectSetup()')
  await assert(
    `document.querySelectorAll('#setup-terminal-tabs button').length===1 && document.querySelector('#setup-terminal').textContent.includes('/home/example/.local/bin/skillager setup --agent claude') && document.querySelector('#setup-terminal').textContent.includes('Local · /work/hvir') && document.querySelector('#ordinary-terminal').innerHTML===${JSON.stringify(original)} && !document.querySelector('#document-view').hidden`,
    'A one-use handoff opens exactly one new terminal fixture at the selected command/project without changing the original terminal or viewer',
  )
  await capture('project-terminal')
  await choose('#project-outcome', 'Paused')
  await click('#finish-project-terminal')
  await assert(
    `document.querySelector('#setup-terminal').textContent.includes('exited with code 0') && document.querySelector('#project-readiness').textContent.includes('Paused') && document.querySelector('#project-readiness').textContent.includes('Not installed') && !document.querySelector('[data-action="project-setup"]').disabled`,
    'Exit zero leaves the separately supplied paused/Working-absent fixture visible, with another explicit action available',
  )
  await pointClick('[data-action="project-setup"]')
  await waitFor(`document.querySelectorAll('#setup-terminal-tabs button').length===2`)
  await choose('#project-outcome', 'Ready')
  await click('#finish-project-terminal')
  await assert(
    `document.querySelector('#project-readiness').textContent.includes('Ready') && document.querySelector('#project-readiness').textContent.includes('Installed') && !document.querySelector('[data-action="project-setup"]') && document.querySelectorAll('[data-native]').length===4 && !document.querySelector('#project-skill-list').textContent.includes('Pending review') && !document.querySelector('#project-skill-list').textContent.includes('Lint blocked') && document.querySelector('#project-skill-list').textContent.includes('Blocked')`,
    'A separately supplied public ready outcome reports Working installed while retaining existing-project metadata',
  )
  await flow('project-existing')
  await pointClick('[data-action="project-setup"]')
  await choose('#agent', 'claude')
  await run('studyTimers.projectSetup()')
  await assert(
    `!document.querySelector('#setup-terminal-tabs button') && document.querySelector('#project-readiness').textContent.includes('Pending review')`,
    'Agent selection revokes a pending handoff and rejects its actual late completion',
  )
  await pointClick('[data-action="project-setup"]')
  await click('#settings')
  await click('#enabled')
  await click('[data-action="close"]')
  await run('studyTimers.projectSetup()')
  await assert(
    absent + ` && !document.querySelector('#setup-terminal-tabs button')`,
    'Disable before handoff removes feature UI and rejects late terminal creation',
  )
  await flow('project-existing')
  await pointClick('[data-action="project-setup"]')
  await waitFor(`!!document.querySelector('#setup-terminal-tabs button')`)
  const handedOff = await run(`document.querySelector('#setup-terminal').innerHTML`)
  await click('#settings')
  await click('#enabled')
  await click('[data-action="close"]')
  await assert(
    absent +
      ` && document.querySelector('#setup-terminal').innerHTML===${JSON.stringify(handedOff)} && !document.querySelector('#setup-terminal').hidden`,
    'Disable after handoff removes feature surfaces and demand while preserving the ordinary user-controlled terminal',
  )
  await click('#recover-project-terminal')
  await assert(
    `document.querySelectorAll('#setup-terminal-tabs button').length===1 && document.querySelector('#setup-terminal').textContent.includes('Setup was not restarted') && !document.querySelector('#project-readiness')`,
    'Terminal recovery fixture never replays setup or restores disabled feature observation',
  )
  await flow('project-existing')
  await pointClick('[data-action="project-setup"]')
  await waitFor(`!!document.querySelector('#setup-terminal-tabs button')`)
  await choose('#destination', 'local-review')
  await choose('#project-outcome', 'Ready')
  await click('#finish-project-terminal')
  await assert(
    `document.querySelector('#active-workspace').textContent.includes('agent/database-review') && document.querySelector('#project-readiness').textContent.includes('Pending review') && document.querySelector('#setup-terminal').textContent.includes('Local · /work/hvir')`,
    'A completed terminal from another workspace cannot publish readiness or switch the active selection',
  )
  await choose('#destination', 'remote-main')
  await assert(
    `document.querySelector('#content').textContent.includes('Project setup unavailable over SSH') && !document.querySelector('[data-action="project-setup"]') && !document.querySelector('[data-native]')`,
    'SSH project discovery/setup stays unavailable without local-cwd fallback or remote Working installation',
  )
  await flow('project-empty')
  await assert(
    `document.querySelector('#project-skill-list').textContent.includes('No project skills reported by Skillager') && !document.querySelector('#first-skill-prompt')`,
    'Zero reported project rows are observational and do not claim a complete scan or empty personal library',
  )
  await flow('project-unavailable')
  await assert(
    `document.querySelector('#project-skill-list').textContent.includes('metadata is unavailable') && !document.querySelector('#content').textContent.includes('No project skills reported') && document.querySelector('#project-readiness').textContent.includes('Unknown')`,
    'Unavailable public metadata remains distinct from zero reported rows and does not invent Working readiness',
  )
}
