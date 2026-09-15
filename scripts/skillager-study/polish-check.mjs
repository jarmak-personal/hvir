import nodeAssert from 'node:assert/strict'
import { initialState, skillFor } from './model.mjs'
import { prepareDirectAddSample, completeDirectAddSample } from './direct-add.mjs'

// Closed illustration evidence; no CLI, host or filesystem guarantees are claimed.
export async function checkPolishStudy({
  flow,
  click,
  pointClick,
  choose,
  run,
  call,
  assert,
  waitFor,
  capture,
}) {
  const ready = () => ({
    ...initialState(),
    enabled: true,
    connected: true,
    selected: 'incident-notes',
  })
  const options = { agent: 'codex', mode: 'native' }
  const changes = [
    (s) => {
      skillFor(s).version = 'different-accepted-hash'
    },
    (s) => {
      skillFor(s).accepted = false
    },
    (s) => {
      s.exposures['local-main/codex']['incident-notes'] = {
        version: 'other',
        mode: 'native',
      }
    },
    (s) => {
      s.unmanagedTargets['local-main/codex'] = { 'incident-notes': true }
    },
    (s) => {
      s.library = { ...s.library, id: 'foreign-library' }
    },
    (s) => {
      s.destination = 'local-review'
      s.generation++
    },
    (s) => {
      s.connected = false
    },
  ]
  for (const change of changes) {
    const state = ready(),
      plan = prepareDirectAddSample(state, options)
    nodeAssert.equal(plan.sourceHash, 'e417ab2')
    change(state)
    const before = JSON.stringify(state.exposures)
    nodeAssert.ok(completeDirectAddSample(state, plan))
    nodeAssert.equal(JSON.stringify(state.exposures), before)
  }
  for (const agent of ['codex', 'claude'])
    for (const mode of ['native', 'stub']) {
      const state = ready()
      skillFor(state).trust = 'pinned'
      const plan = prepareDirectAddSample(state, { agent, mode })
      nodeAssert.equal(completeDirectAddSample(state, plan), null)
      nodeAssert.deepEqual(state.exposures[`local-main/${agent}`]['incident-notes'], {
        version: 'e417ab2',
        mode,
      })
    }
  const remote = {
    ...ready(),
    destination: 'remote-main',
    samplePrerequisites: ['Python 3.12'],
  }
  nodeAssert.ok(prepareDirectAddSample(remote, { ...options, mode: 'stub' }).refusal)
  const remotePlan = prepareDirectAddSample(remote, options)
  nodeAssert.match(completeDirectAddSample(remote, remotePlan), /not checked/)
  nodeAssert.equal(remote.exposures['remote-main/codex']?.['incident-notes'], undefined)
  const uncertain = { ...ready(), sampleDirectOutcome: 'uncertain' }
  nodeAssert.match(
    completeDirectAddSample(uncertain, prepareDirectAddSample(uncertain, options)),
    /uncertain/,
  )
  uncertain.refreshError = null
  nodeAssert.ok(prepareDirectAddSample(uncertain, options).refusal)
  const retained = { ...ready(), refreshError: 'Metadata unavailable' }
  nodeAssert.equal(prepareDirectAddSample(retained, options).sourceHash, 'e417ab2')
  await assert(
    'true',
    'Direct Add sample owner binds source hash, accepted state, exact absent target/context; pinned accepted create remains allowed and uncertainty/prerequisites stop automatic writes',
  )

  await flow('initial-loading')
  await assert(
    `document.querySelector('.initial-observation') && !document.querySelector('#first-skill-prompt')`,
    'Initial metadata loading does not claim an empty library',
  )
  await waitFor(
    `!document.querySelector('.initial-observation') && document.querySelector('#explorer-library [data-skill]')`,
  )
  await flow('curation')
  await click('#curation-long-project')
  await click('#explorer-workspace [data-curation-select="observed-15"]')
  await waitFor(`document.querySelector('#skill-current-body')`)
  await run(
    `window.polishRow = document.querySelector('#explorer-workspace [data-curation-select="observed-15"]'); polishRow.focus(); polishRow.scrollIntoView({block:'center'}); window.polishBefore = {scroll:document.querySelector('#explorer-workspace .explorer-scroll').scrollTop, text:document.querySelector('#explorer-workspace .explorer-scroll').textContent, count:document.querySelector('#reading-count').textContent, height:polishRow.closest('.skill-row').getBoundingClientRect().height}; document.querySelector('#polish-refresh').click()`,
  )
  await assert(
    `document.querySelector('.header-refresh').getAttribute('aria-busy')==='true' && document.activeElement===polishRow && document.querySelector('#explorer-workspace .explorer-scroll').scrollTop===polishBefore.scroll`,
    'Background checking retains exact focused row and scroll with activity in a fixed header control',
  )
  await waitFor(
    `document.querySelector('.header-refresh').getAttribute('aria-busy')==='false'`,
  )
  await assert(
    `document.activeElement===polishRow && document.querySelector('#explorer-workspace .explorer-scroll').textContent===polishBefore.text && document.querySelector('#reading-count').textContent===polishBefore.count && polishRow.closest('.skill-row').getBoundingClientRect().height===polishBefore.height`,
    'Successful refresh does not rebuild unchanged rows, change their labels or reread the body',
  )
  await run(
    `document.querySelector('#polish-refresh-error').click(); document.querySelector('#polish-refresh').click()`,
  )
  await waitFor(
    `document.querySelector('#observation-notice').textContent.includes('Stale observation')`,
  )
  await assert(
    `document.activeElement===polishRow && document.querySelector('#explorer-workspace .explorer-scroll').textContent===polishBefore.text && document.querySelector('#explorer-workspace .explorer-scroll').scrollTop===polishBefore.scroll && !document.querySelector('.project-setup')`,
    'Failed refresh retains list/focus/scroll and marks it stale without reopening setup',
  )
  await capture('polish-stale-observation')
  await run(
    `document.querySelector('#polish-refresh-error').click(); document.querySelector('#polish-refresh').click(); window.departedRefresh=studyTimers.refresh`,
  )
  await assert(
    `typeof departedRefresh==='function' && document.querySelector('.header-refresh').getAttribute('aria-busy')==='true'`,
    'The departed observation proof captures this actual pending refresh callback',
  )
  await choose('#destination', 'local-review')
  await waitFor(
    `document.querySelector('.header-refresh').getAttribute('aria-busy')==='false'`,
  )
  await run(
    `window.currentObservation=document.querySelector('#skills-rail').innerHTML; departedRefresh()`,
  )
  await assert(
    `document.querySelector('#active-workspace').textContent.includes('database-review') && document.querySelector('#skills-rail').innerHTML===currentObservation && !document.querySelector('#observation-notice').textContent.includes('Stale observation')`,
    'A replacement workspace gets its own observation; replaying the specific departed refresh cannot publish stale status',
  )

  await call('Emulation.setDeviceMetricsOverride', {
    width: 1000,
    height: 900,
    deviceScaleFactor: 1,
    mobile: false,
  })
  await flow('curation')
  await pointClick('#explorer-library [data-curation-select="environment"]')
  await waitFor(`document.querySelector('#skill-current-body')`)
  await pointClick('[data-reading="source"]')
  await run(
    `document.querySelector('#skills-view').scrollTop=120; window.polishScroll=document.querySelector('#skills-view').scrollTop; window.polishReadCount=document.querySelector('#reading-count').textContent`,
  )
  await assert(
    `polishScroll>0`,
    'The reader collapse test starts at a real nonzero viewer position',
  )
  await click('[data-reading="collapse"]')
  await assert(
    `document.querySelector('.instructions-body').hidden`,
    'Instructions disclosure hides the entire body',
  )
  await click('[data-reading="collapse"]')
  await assert(
    `document.querySelector('[data-reading="source"]').getAttribute('aria-pressed')==='true' && document.querySelector('#skills-view').scrollTop===polishScroll && document.querySelector('#reading-count').textContent===polishReadCount`,
    'Collapse and expand preserve the same tab’s source mode, nonzero reading position and retained read',
  )
  await capture('polish-source-narrow')
  await pointClick('[data-reading="rendered"]')
  await run(`document.querySelector('#skills-view').scrollTop=0`)
  await choose('#polish-theme', 'light')
  await assert(
    `document.documentElement.scrollWidth<=1000 && document.querySelector('.instruction-prose').getBoundingClientRect().width<=document.querySelector('#skills-view').getBoundingClientRect().width`,
    'Light compact reader constrains prose without horizontal page overflow',
  )
  await capture('polish-light-reader')
  await choose('#polish-theme', 'dark')
  await call('Emulation.setDeviceMetricsOverride', {
    width: 1440,
    height: 1040,
    deviceScaleFactor: 1,
    mobile: false,
  })
  await capture('polish-reader')
  await call('Emulation.setDeviceMetricsOverride', {
    width: 1152,
    height: 832,
    deviceScaleFactor: 1.25,
    mobile: false,
  })
  await pointClick('[data-reading="source"]')
  await assert(
    `devicePixelRatio===1.25 && document.documentElement.scrollWidth<=innerWidth && document.querySelector('#skill-current-body').tagName==='PRE'`,
    'A 125% density viewport keeps the actual reader mode control reachable and source contained',
  )
  await capture('polish-scaled-reader')
  await call('Emulation.setDeviceMetricsOverride', {
    width: 1440,
    height: 1040,
    deviceScaleFactor: 1,
    mobile: false,
  })
  await flow('curation')
  await pointClick('#explorer-library [data-curation-select="environment"]')
  await choose('#browse-agent', 'claude')
  await choose('#curation-add-agent', 'claude')
  await choose('#curation-mode', 'Stub')
  await pointClick('[data-curate="menu"]')
  await assert(
    `document.querySelector('#dialog').textContent.includes('Codex · Full skill · not in this project')`,
    'The menu names its concrete Add shortcut separately from the detail controls’ unsubmitted choices',
  )
  await pointClick('#dialog [data-curate="add"]')
  await waitFor(
    `document.querySelector('.add-result')?.textContent.includes('Added to Codex')`,
  )
  await assert(
    `document.querySelector('[data-curation-row="environment"] [aria-label="Codex · Full"]')`,
    'Menu Add follows its displayed agent and mode, never hidden controls behind the dialog',
  )
  for (const departure of ['workspace', 'disable']) {
    await flow('add')
    await pointClick('[data-action="preview-add"]')
    await run(`window.departedAdd=studyTimers.add`)
    await assert(
      `typeof departedAdd==='function' && document.querySelector('.add-result').textContent.includes('Preparing exact')`,
      'The Add departure proof captures this actual pending create-only callback',
    )
    if (departure === 'workspace') await choose('#destination', 'local-review')
    else {
      await click('#settings')
      await click('#enabled')
    }
    await run(
      `window.afterAddDeparture=document.querySelector('.frame').innerHTML; departedAdd()`,
    )
    await assert(
      `document.querySelector('.frame').innerHTML===afterAddDeparture`,
      `Replaying the canceled Add after ${departure} cannot publish or target a replacement context`,
    )
    if (departure === 'workspace') {
      await choose('#destination', 'local-main')
      await assert(
        `document.querySelector('[data-action="preview-add"]') && !document.querySelector('#explorer-workspace [data-skill="incident-notes"]')`,
        'The canceled Add left the original destination absent and requires another explicit Add',
      )
    } else await click('[data-action="close"]')
  }
  await flow('browse')
  await click('#reading-delay')
  await click('#explorer-library [data-select="incident-notes"]')
  await assert(
    `document.querySelector('.instructions-body').textContent.includes('Reading selected file') && document.querySelector('#reading-count').textContent==='1 explicit sample reads'`,
    'The final Add starts while an ordinary read of its exact selected library source is pending',
  )
  await pointClick('[data-action="preview-add"]')
  await assert(
    `!document.querySelector('#dialog').open`,
    'A deliberate Add uses the visible exact controls without opening a modal',
  )
  await waitFor(
    `document.querySelector('.add-result')?.textContent.includes('Added to Codex')`,
  )
  await waitFor(`document.querySelector('#skill-current-body')`)
  await assert(
    `document.querySelector('#reading-count').textContent==='1 explicit sample reads' && document.querySelector('.skill-reading').textContent.includes('Your library')`,
    'Add at the unchanged destination neither strands nor restarts the independent ordinary read',
  )
  await assert(
    `document.querySelector('[data-action="remove"]') && !document.querySelector('#skills-view').textContent.includes('Undo')`,
    'Successful Add offers protected Remove from project without promising Undo',
  )
  await capture('polish-added')
  await pointClick('[data-action="remove"]')
  await assert(
    `document.querySelector('#dialog').open && document.querySelector('.complete-effects') && !document.querySelector('#dialog .diff')`,
    'Removal retains explicit review and a complete file list without an empty comparison',
  )
  await assert(
    `(()=>{const dialog=document.querySelector('#dialog'),technical=dialog.querySelector('.technical-details'),visible=dialog.cloneNode(true);visible.querySelector('.technical-details').remove();return !technical.open&&technical.textContent.includes('/home/example/.skillager/library/skills/incident-notes')&&technical.textContent.includes('/work/hvir/.agents/skills/lib-incident-notes')&&technical.textContent.includes('e417ab2')&&visible.textContent.includes('Local · hvir / main · Codex')&&visible.textContent.includes('Remove SKILL.md')&&!visible.textContent.includes('/work/')&&!visible.textContent.includes('e417ab2')})()`,
    'Removal leads with skill/project/agent and relative effects; exact paths and versions remain reachable in technical details',
  )
  await capture('polish-remove')
  await click('[data-action="close"]')
  await click('#settings')
  await capture('polish-settings')
  await click('#enabled')
  await assert(
    `document.querySelectorAll('#dialog input').length===1 && !document.querySelector('#dialog .connection-details') && !document.querySelector('#skills-nav')`,
    'Disabled settings retain only the enable field while feature surfaces are revoked',
  )
  await capture('polish-disabled-settings')
  await click('[data-action="close"]')
}
