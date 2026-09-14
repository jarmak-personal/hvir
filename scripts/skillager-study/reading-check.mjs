import { selectedDocument } from './reading.mjs'
import { initialState } from './model.mjs'
import { curationSample } from './curation-model.mjs'
// Browser interaction of closed sample responses, not production read/search proof.
import nodeAssert from 'node:assert/strict'
import { publicSearchSample } from './search-sample.mjs'
export async function checkReadingStudy({
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
  const submit = async () => {
    await click('#search-form button[type="submit"]')
    await waitFor(
      `!document.querySelector('.search-status').textContent.includes('Searching Skillager')`,
    )
  }
  const body = `document.querySelector('#skill-current-body')`
  await flow('reading-search')
  await assert(
    `document.querySelector('#reading-count').textContent==='0 explicit sample reads' && !${body}`,
    'Metadata arrival does not read sample bodies',
  )
  await pointClick('[data-expand="library:merge"]')
  await click('[data-action="refresh"]')
  await run(`document.querySelector('[data-curation-select="merge"]').focus()`)
  await assert(
    `document.querySelector('#reading-count').textContent==='0 explicit sample reads'`,
    'Disclosure, refresh and keyboard focus remain metadata-only',
  )
  await call('Input.dispatchKeyEvent', {
    type: 'keyDown',
    text: '\r',
    unmodifiedText: '\r',
    nativeVirtualKeyCode: 13,
    key: 'Enter',
    code: 'Enter',
    windowsVirtualKeyCode: 13,
  })
  await call('Input.dispatchKeyEvent', {
    type: 'keyUp',
    key: 'Enter',
    code: 'Enter',
    windowsVirtualKeyCode: 13,
  })
  await assert(
    `document.querySelector('#reading-count').textContent==='1 explicit sample reads'`,
    'Keyboard row activation starts exactly one selected sample read',
  )
  await waitFor(body)
  await assert(
    `${body}.textContent.includes('original-v1') && document.querySelector('.skill-reading').textContent.includes('Project original') && document.querySelector('.skill-reading').textContent.includes('/.agents/skills/merge/SKILL.md') && !document.querySelector('#dialog').open && !document.querySelector('#curation-body')`,
    'Explicit keyboard activation reads the selected original current file without review or mutation',
  )
  await capture('reading-project-original')
  await pointClick('[data-action="canonical-definition"]')
  await waitFor(body)
  await assert(
    `${body}.textContent.includes('accepted-v2') && document.querySelector('.skill-reading').textContent.includes('Your library') && document.querySelector('.skill-reading').textContent.includes('/skills/synced-merge/SKILL.md')`,
    'Separate proven canonical navigation reads the actual current library definition',
  )
  await capture('reading-library-definition')
  const count = await run(`document.querySelector('#reading-count').textContent`)
  await click('[data-action="refresh"]')
  await assert(
    `document.querySelector('#reading-count').textContent===${JSON.stringify(count)}`,
    'Metadata refresh retains the ordinary read without another body request',
  )
  await submit()
  await assert(
    `document.querySelectorAll('.explorer-search-results [data-curation-select]').length===0 && document.querySelector('.search-status').textContent.includes('Installed skills are hidden') && document.querySelector('[data-action="include-installed"]')`,
    'All three installed identities are hidden by default with an immediate Include installed action',
  )
  await choose('#browse-agent', 'claude')
  await submit()
  await assert(
    `document.querySelectorAll('.explorer-search-results [data-curation-select]').length===0`,
    'Preferred agent does not narrow installed exclusion across agents',
  )
  await pointClick('[data-action="include-installed"]')
  await waitFor(
    `document.querySelectorAll('.explorer-search-results [data-curation-select]').length===3`,
  )
  await assert(
    `[...document.querySelectorAll('.explorer-search-results [data-row-scope]')].every(row=>row.dataset.rowScope==='library')`,
    'Including installed returns three proven groups represented by current accepted canonical entries',
  )
  await capture('reading-search-three-groups')
  await click('#show-copies')
  await assert(
    `document.querySelectorAll('.explorer-search-results [data-curation-select]').length===3 && document.querySelector('#search-disclosure > summary').textContent.includes('One per skill')`,
    'Editing Advanced does not relabel the submitted groups',
  )
  await submit()
  await assert(
    `document.querySelectorAll('.explorer-search-results [data-curation-select]').length===6 && document.querySelectorAll('.explorer-search-results [data-row-scope="library"]').length===3 && document.querySelectorAll('.explorer-search-results [data-row-scope="workspace"]').length===3 && document.querySelector('.explorer-search-results [data-curation-row="merge"]').textContent.includes('Original · Codex') && document.querySelector('.explorer-search-results [data-curation-row="review"]').textContent.includes('Original · Claude Code')`,
    'Show separate copies returns six exact original/library occurrences',
  )
  await pointClick('#search-disclosure > summary')
  await capture('reading-search-six-occurrences')
  for (const occurrence of ['library:merge', 'original:merge']) {
    await pointClick(
      `.explorer-search-results [data-curation-menu][data-occurrence="${occurrence}"]`,
    )
    await assert(
      `document.querySelector('[data-curate="full"]').disabled && document.querySelector('[data-curate="stub"]').disabled && document.querySelector('#dialog').textContent.includes('before conversion') && document.querySelector('[data-curate="full"]').textContent==='Use as full skill…' && document.querySelector('[data-curate="stub"]').textContent==='Use as stub…'`,
      'Both result occurrences retain clear full/stub labels and the existing preservation refusal for differing versions',
    )
    await pointClick('#dialog [data-action="close"]')
  }
  await pointClick('#search-disclosure > summary')
  await click('#show-copies')
  await run(
    `document.querySelector('#search').value='original-only';document.querySelector('#search').dispatchEvent(new Event('input',{bubbles:true}))`,
  )
  await submit()
  await assert(
    `document.querySelectorAll('.explorer-search-results [data-curation-select]').length===3 && document.querySelector('.explorer-search-results').textContent.includes('selected library definition did not match')`,
    'A preferred canonical representative names the original occurrence that matched',
  )
  await click('#show-copies')
  await submit()
  await assert(
    `document.querySelectorAll('.explorer-search-results [data-curation-select]').length===6 && document.querySelector('.explorer-search-results [data-library-row="merge"]').textContent.includes('Match from Project native') && document.querySelector('.explorer-search-results [data-library-row="merge"]').textContent.includes('selected library definition did not match')`,
    'Separate copies include the nonmatching canonical occurrence and disclose its actual matched original',
  )
  await click('#show-copies')
  await submit()
  await pointClick('#search-disclosure > summary')
  await pointClick('.explorer-search-results [data-curation-select="merge"]')
  await waitFor(body)
  await click('#curation-edit-library')
  await pointClick('.explorer-search-results [data-curation-select="merge"]')
  await assert(
    `!${body} && document.querySelector('.skill-reading').textContent.includes('changed since the search observation')`,
    'A changed canonical file cannot masquerade as the accepted search version',
  )
  await pointClick('#search-disclosure > summary')
  await submit()
  await assert(
    `!document.querySelector('.explorer-search-results [data-library-row="merge"]') && document.querySelector('.explorer-search-results [data-curation-row="merge"]')`,
    'Pending canonical state chooses an eligible original instead of historical accepted library bytes',
  )
  await flow('curation')
  await pointClick('[data-curation-select="draft"]')
  await waitFor(body)
  await assert(
    `document.querySelector('.skill-reading').textContent.includes('Pending current file') && !document.querySelector('#curation-body')`,
    'An unapproved project draft is readable without starting approval',
  )
  await pointClick('#explorer-workspace [data-curation-select="managed"]')
  await waitFor(body)
  await assert(
    `document.querySelector('.skill-reading').textContent.includes('Installed Full') && ${body}.textContent.includes('approved-v1')`,
    'Installed Full reads the actual older project copy',
  )
  await click('[data-curation-menu="native-codex"]')
  await click('[data-curate="stub"]')
  await click('[data-curate="apply"]')
  await pointClick('#explorer-workspace [data-curation-select="native-codex"]')
  await waitFor(body)
  await assert(
    `document.querySelector('.skill-reading').textContent.includes('Installed Stub') && ${body}.textContent.includes('installed stub')`,
    'Installed Stub selection shows actual activation instructions',
  )
  await pointClick('[data-curation-router="review-router"]')
  await waitFor(body)
  await assert(
    `document.querySelector('.skill-reading').textContent.includes('Installed Router') && ${body}.textContent.includes('installed router')`,
    'Router activation reads the router file, not a canonical member body',
  )
  await flow('reading-search')
  await click('#reading-delay')
  await pointClick('[data-curation-select="merge"]')
  await assert(
    `document.querySelector('.skill-reading [role="status"]').textContent==='Reading selected file…'`,
    'The active tab departure exercises a currently pending read',
  )
  await run('studyTimers.canceledRead=studyTimers.read')
  await pointClick('.viewer-tabs [data-viewer="document"]')
  await run('studyTimers.canceledRead()')
  await assert(
    `!${body} && document.querySelector('#reading-count').textContent==='1 explicit sample reads'`,
    'Leaving the active tab revokes the pending read and rejects late publication',
  )
  await pointClick('[data-viewer="skills"]')
  await waitFor(body)
  await assert(
    `document.querySelector('#reading-count').textContent==='2 explicit sample reads'`,
    'Explicit retained-tab activation starts its own current-file read',
  )
  await flow('reading-search')
  await click('#reading-delay')
  await pointClick('[data-curation-select="merge"]')
  await assert(
    `document.querySelector('.skill-reading [role="status"]').textContent==='Reading selected file…'`,
    'Disable exercises a currently pending read',
  )
  await run('studyTimers.canceledRead=studyTimers.read')
  await click('#settings')
  await click('#enabled')
  await run('studyTimers.canceledRead()')
  await assert(
    `!${body} && document.querySelector('#skills-view').innerHTML===''`,
    'Disable rejects the pending body completion and clears feature content',
  )
  await click('[data-action="close"]')
  for (const departure of ['workspace', 'connection']) {
    await flow('reading-search')
    await click('#reading-delay')
    await pointClick('[data-curation-select="merge"]')
    await assert(
      `document.querySelector('.skill-reading [role="status"]').textContent==='Reading selected file…'`,
      'Context departure exercises its own currently pending read',
    )
    await run('studyTimers.canceledRead=studyTimers.read')
    if (departure === 'workspace') await choose('#destination', 'local-review')
    else {
      await click('#settings')
      await click('[data-action="change-library"]')
    }
    await run('studyTimers.canceledRead()')
    await assert(
      `!${body}`,
      'Workspace or library reconnection rejects a late selected-body completion',
    )
    if (departure === 'connection') await click('[data-action="close"]')
  }
  await flow('reading-legacy')
  await choose('#browse-agent', 'claude')
  await submit()
  await assert(
    `document.querySelector('[data-action="legacy-search"]') && !document.querySelector('.explorer-search-results [data-curation-select]')`,
    'Unsupported search contract offers an explicit legacy choice',
  )
  await pointClick('[data-action="legacy-search"]')
  await waitFor(
    `document.querySelectorAll('.explorer-search-results [data-curation-select]').length===6`,
  )
  await assert(
    `document.querySelector('.search-status').textContent.includes('Legacy results · Installed included · Prefer Claude') && document.querySelector('.search-status').textContent.includes('Older Skillager may group agent variants') && document.querySelector('#browse-agent').value==='claude' && !document.querySelector('.explorer-search-results').textContent.includes('Separate copies')`,
    'Legacy results include installed skills, retain the actual agent preference and disclose possible native variant grouping',
  )
  await flow('reading-unknown')
  await submit()
  await assert(
    `document.querySelector('[data-action="include-installed"]') && !document.querySelector('[data-action="legacy-search"]') && !document.querySelector('.explorer-search-results [data-curation-select]')`,
    'Unknown installed presence offers explicit Include installed without discarding supported grouping',
  )
  await pointClick('[data-action="include-installed"]')
  await waitFor(
    `document.querySelectorAll('.explorer-search-results [data-curation-select]').length===3`,
  )
  await assert(
    `document.querySelector('.search-status').textContent.includes('Including installed · One per skill') && document.querySelector('#include-installed').checked`,
    'Explicit Include installed resolves unknown-presence filtering while preserving three proven groups',
  )
  await flow('project-existing')
  await pointClick('[data-native="project-blocked"]')
  await waitFor(body)
  await assert(
    `document.querySelector('.skill-reading').textContent.includes('Blocked') && document.querySelector('.skill-reading').textContent.includes('/.claude/skills/project-blocked/SKILL.md') && !document.querySelector('#dialog').open`,
    'Explicit blocked project content is readable without approval or exposure',
  )
  await flow('search')
  await waitFor(
    `document.querySelector('.search-status').textContent.includes('3 results returned')`,
  )
  await pointClick('.explorer-search-results [data-select="migration-review"]')
  await waitFor(body)
  await assert(
    `document.querySelector('.skill-reading').textContent.includes('Your library') && ${body}.textContent.includes('c82a19f') && !${body}.textContent.includes('7da204b')`,
    'A direct canonical search result reads its selected library version rather than its older installed copy',
  )
  await pointClick('#details [data-action="read"]')
  await assert(
    `document.querySelector('#skills-view').textContent.includes('Reviewed snapshot: c82a19f') && !${body}`,
    'Explicit review owns its retained snapshot rather than the ordinary read',
  )
  await pointClick('[data-action="metadata"]')
  await waitFor(body)
  await assert(
    `${body}.textContent.includes('c82a19f') && document.querySelector('.skill-reading').textContent.includes('Current file')`,
    'Back to current file explicitly reads the selected document after leaving verified review',
  )
  await pointClick('.explorer-search-results [data-select="deadlock-analysis"]')
  await assert(
    `!${body} && document.querySelector('.skill-reading').textContent.includes('no confined project or library document grant')`,
    'An external search match never widens the explicit library or project document grant',
  )
  const memberState = initialState()
  memberState.curation = curationSample()
  memberState.curation.selected = 'global'
  memberState.curation.routers.push({
    ...memberState.curation.routers[0],
    id: 'second-router',
    name: 'Second router',
  })
  nodeAssert.match(selectedDocument(memberState).unavailable, /concrete installed router/)
  memberState.curation.selectedMemberRouter = 'second-router'
  nodeAssert.match(selectedDocument(memberState).path, /second-router\/SKILL.md$/)
  await assert(
    'true',
    'A member shared by two sample routers requires the explicitly selected concrete router body',
  )
  // Finite closed fixtures exercise the study response model, not production capacity.
  const candidates = Array.from({ length: 80 }, (_, i) => ({
    id: `s${i}`,
    occurrenceId: `o${i}`,
    identity: `i${i}`,
    searchText: 'skill',
    canonical: true,
  }))
  const state = {
    curation: {
      sources: candidates
        .slice(0, 60)
        .map((row) => ({ logicalIdentity: row.identity, projectPresent: true })),
    },
  }
  const result = publicSearchSample(
    state,
    { query: 'skill', scope: 'available', includeInstalled: false },
    candidates,
  )
  nodeAssert.equal(result.rows.length, 20)
  nodeAssert.equal(result.rows[0].id, 's60')
  const unknown = publicSearchSample(
    { curation: { sources: [] } },
    { query: 'same', scope: 'available' },
    [
      { id: 'a', occurrenceId: 'a', searchText: 'same' },
      { id: 'b', occurrenceId: 'b', searchText: 'same' },
    ],
  )
  nodeAssert.equal(unknown.rows.length, 2)
  await assert(
    'true',
    'Closed sample responses filter installed identities before a saturated window and keep equal-name unproven sources distinct',
  )
}
