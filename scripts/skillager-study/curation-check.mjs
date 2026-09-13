// Curation-specific synthetic presentation checks; reuse the one browser lifecycle.
export async function checkCurationStudy({
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
  const key = async (key, code = key) => {
    await call('Input.dispatchKeyEvent', {
      type: 'keyDown',
      text: '\r',
      unmodifiedText: '\r',
      key,
      code,
      windowsVirtualKeyCode: 13,
      nativeVirtualKeyCode: 13,
    })
    await call('Input.dispatchKeyEvent', {
      type: 'keyUp',
      key,
      code,
      windowsVirtualKeyCode: 13,
      nativeVirtualKeyCode: 13,
    })
  }
  await flow('curation')
  await assert(
    `!document.querySelector('#search-disclosure').open && !document.querySelector('#search-advanced').open && document.querySelector('#browse-agent').value==='all' && !document.querySelector('.project-setup') && document.querySelectorAll('[data-curation-row]').length===5`,
    'Connected curation starts with skills, collapsed search/Advanced and all agent-qualified copies',
  )
  await pointClick('[data-curation-select="native-codex"]')
  const detail = await run(`document.querySelector('#skills-view').textContent`)
  await run(`document.querySelector('#search-disclosure > summary').focus()`)
  await key('Enter')
  await assert(
    `document.querySelector('#search-disclosure').open && !document.querySelector('#search-advanced').open`,
    'Keyboard activation opens only the first search level',
  )
  await pointClick('#search-advanced > summary')
  await choose('#browse-agent', 'claude')
  await assert(
    `document.querySelectorAll('[data-curation-row]').length===2 && document.querySelector('#explorer-library [data-library-row="native-codex"]') && document.querySelector('#skills-view').textContent===${JSON.stringify(detail)} && document.querySelector('#agent').value==='codex'`,
    'Agent browsing filters project copies while retaining reusable library rows, open details and the exact action agent',
  )
  await choose('#browse-agent', 'all')
  await pointClick('#search')
  await call('Input.insertText', { text: 'Release' })
  await pointClick('#search-form button[type="submit"]')
  await waitFor(
    `document.querySelector('.explorer-search-results .curation-search-status').textContent.includes('2 results')`,
  )
  await assert(
    `(()=>{const ids=[...document.querySelectorAll('[id]')].map(el=>el.id);return ids.length===new Set(ids).size})()`,
    'Search and both retained explorer sections have unique element IDs',
  )
  await pointClick('#search-disclosure > summary')
  await assert(
    `!document.querySelector('#search-disclosure').open && document.querySelector('#search-disclosure > summary').textContent.includes('Release') && document.querySelector('.explorer-search-results [data-library-row="native-codex"]') && document.querySelector('.explorer-search-results [data-curation-row="native-claude"]')`,
    'Collapsed controls retain the submitted query and both same-named agent identities',
  )
  await assert(
    `['library','workspace'].every(scope=>document.querySelector('#explorer-'+scope+' .explorer-scroll').hidden && document.querySelector('[data-perspective="'+scope+'"]').getAttribute('aria-expanded')==='false')`,
    'Search keeps section headings available while their collapsed glyph, aria state and content visibility agree',
  )
  await flow('curation')
  await pointClick('[data-curation-select="native-codex"]')
  await capture('curation-skills-first')
  await run(`document.querySelector('[data-curation-menu="native-codex"]').focus()`)
  await key('Enter')
  await assert(
    `document.querySelector('#dialog').textContent.includes('Full') && document.querySelector('#dialog').textContent.includes('Stub') && document.querySelector('#dialog').textContent.includes('Group in router')`,
    'Keyboard row action trigger exposes Full, Stub and router choices for the selected native source',
  )
  await pointClick('[data-curate="stub"]')
  await assert(
    `document.querySelector('#dialog').textContent.includes('Codex') && document.querySelector('#dialog').textContent.includes('/.agents/skills/native-codex') && document.querySelector('#dialog').textContent.includes('/skills/synced-native-codex')`,
    'Native conversion previews the exact original agent target, preserved library version and effects',
  )
  await run(`document.querySelector('#curation-change-source').click()`)
  await pointClick('[data-curate="apply"]')
  await assert(
    `document.querySelector('#dialog').textContent.includes('changed') && !document.querySelector('[data-curate="apply"]')`,
    'An external source change invalidates the existing conversion preview',
  )
  await flow('curation')
  await pointClick('[data-curation-select="native-codex"]')
  await assert(
    `!document.querySelector('#curation-body')`,
    'Curation selection starts with metadata only',
  )
  await pointClick('[data-curate="review"]')
  await assert(
    `document.querySelector('#curation-body').textContent.includes('native-codex')`,
    'Explicit review opens only the selected sample content',
  )
  await click('[data-curation-menu="native-claude"]')
  await pointClick('[data-action="close"]')
  await assert(
    `!document.querySelector('#curation-body') && document.querySelector('[data-curate="review-files"]')`,
    'Another source’s action menu revokes the previous body review',
  )
  await flow('curation')
  await click('[data-curation-menu="extra-files"]')
  await assert(
    `document.querySelector('#dialog').textContent.includes('notes.local.txt') && document.querySelector('[data-curate="stub"]').disabled`,
    'Approved-content preservation does not authorize discarding extra original files',
  )
  await flow('curation')
  await click('[data-curation-menu="native-claude"]')
  await assert(
    `document.querySelector('[data-curate="stub"]').disabled && document.querySelector('#dialog').textContent.includes('Sync this approved source')`,
    'An approved native source still needs verified library preservation before conversion',
  )
  await pointClick('#dialog [data-curate="sync"]')
  await pointClick('[data-curate="sync-confirm"]')
  await assert(
    `['Project native','Environment','Package','Collection','Global','Created','Updated','Unchanged','Conflict','Skipped','Failed'].every(text=>document.querySelector('#sync-outcomes').textContent.includes(text))`,
    'Explicit backfill reports per-source creation, unchanged, conflict and skipped outcomes across source types',
  )
  await capture('curation-sync-outcomes')
  await pointClick('[data-action="close"]')
  await run(`document.querySelector('#curation-edit-library').click()`)
  await pointClick('[data-curate="menu"]')
  await pointClick('#dialog [data-curate="sync"]')
  await pointClick('[data-curate="sync-confirm"]')
  await assert(
    `document.querySelector('#sync-outcomes').textContent.includes('Conflict') && document.querySelector('[data-library-row="native-claude"]').textContent.includes('Review') && document.querySelector('#skills-view').textContent.includes('edited-v3')`,
    'Explicit sync preserves a pending canonical edit and its unaccepted version',
  )
  await pointClick('[data-action="close"]')
  await run(`document.querySelector('#curation-approve').click()`)
  await assert(
    `document.querySelector('[data-library-row="draft"]') && document.querySelector('[data-library-row="collection"]').textContent.includes('Conflict') && document.querySelector('[data-library-row="native-claude"]').textContent.includes('Review') && document.querySelector('#skills-view').textContent.includes('edited-v3')`,
    'Approval-triggered sync preserves pending and conflicting canonical copies while adding the newly approved source',
  )
  await flow('curation')
  const routerPoint = await run(
    `(()=>{const row=document.querySelector('[data-router-row="review-router"]');row.scrollIntoView({block:'nearest'});const r=row.getBoundingClientRect();return {x:r.x+r.width/2,y:r.y+r.height/2}})()`,
  )
  await call('Input.dispatchMouseEvent', {
    type: 'mousePressed',
    ...routerPoint,
    button: 'right',
    clickCount: 1,
  })
  await call('Input.dispatchMouseEvent', {
    type: 'mouseReleased',
    ...routerPoint,
    button: 'right',
    clickCount: 1,
  })
  await assert(
    `['Edit members','Ungroup','Remove router from this project'].every(text=>document.querySelector('#dialog').textContent.includes(text))`,
    'Actual router right-click exposes the same Edit, Ungroup and router-only removal actions as its keyboard-accessible trigger',
  )
  await pointClick('#dialog [data-curate="remove-router"]')
  await assert(
    `document.querySelector('#dialog').textContent.includes('no standalone copies created') && document.querySelector('#dialog').textContent.includes('retained with its curated members')`,
    'Existing router-only removal discloses no standalone restoration and retains the tag',
  )
  await pointClick('[data-curate="apply"]')
  await assert(
    `!document.querySelector('.router-group') && document.querySelector('[data-library-row="global"]') && document.querySelector('[data-curation-row="native-codex"]')`,
    'Router-only removal retains the library and unrelated standalone copies',
  )
  const groupInExisting = async () => {
    await click('[data-curation-menu="native-codex"]')
    await pointClick('[data-curate="router"]')
    await choose('#curation-group', 'review-router')
    await assert(
      `document.querySelector('#curation-name').disabled && document.querySelector('#router-existing-members').textContent.includes('Global review') && document.querySelector('#curation-replace').checked`,
      'Choosing a provided named group shows its existing members and the exact selected standalone copy',
    )
    await pointClick('[data-curate="router-preview"]')
  }
  await flow('curation')
  await groupInExisting()
  await run(`document.querySelector('#curation-change-router').click()`)
  await pointClick('[data-curate="apply"]')
  await assert(
    `document.querySelector('#dialog').textContent.includes('membership changed')`,
    'Changed router membership refuses the previous grouping plan',
  )
  await flow('curation')
  await run(`document.querySelector('#curation-shared-tag').click()`)
  await groupInExisting()
  await assert(
    `document.querySelector('#dialog').textContent.includes('Another agent or router uses this tag') && !document.querySelector('[data-curate="apply"]')`,
    'Shared-tag membership changes refuse without changing another agent or router',
  )
  await flow('curation')
  await groupInExisting()
  await assert(
    `document.querySelector('#dialog').textContent.includes('Project tag review-toolkit: change') && document.querySelector('#dialog').textContent.includes('Remove selected standalone') && document.querySelector('[data-curation-row="native-codex"]')`,
    'Group preview discloses the visible tag change and selected-copy removal before any sample writes',
  )
  await capture('curation-router-preview')
  await pointClick('[data-curate="apply"]')
  await pointClick('[data-curation-router="review-router"]')
  await assert(
    `document.querySelector('.router-group').textContent.includes('Release review') && document.querySelector('#skills-view').textContent.includes('native-codex') && document.querySelector('[data-curation-row="native-claude"]').textContent.includes('Full')`,
    'Router membership uses provided identities and leaves the other agent copy unchanged',
  )
  await pointClick('[data-curate="set-members"]')
  await pointClick('[data-router-member="native-codex"]')
  await choose('#curation-mode', 'Stub')
  await pointClick('[data-curate="members-preview"]')
  await assert(
    `document.querySelector('#dialog').textContent.includes('Create or reuse unchanged Stub') && document.querySelector('#dialog').textContent.includes('Project tag review-toolkit: change')`,
    'Editing the complete member set previews the departing member’s chosen Stub copy and tag effects',
  )
  await pointClick('[data-curate="apply"]')
  await assert(
    `document.querySelector('[data-curation-row="native-codex"]').textContent.includes('Stub') && !document.querySelector('.router-group').textContent.includes('Release review')`,
    'Membership apply preserves the departed source as the chosen standalone copy',
  )
  await pointClick('[data-curation-router="review-router"]')
  await pointClick('[data-curate="ungroup"]')
  await choose('#curation-mode', 'Full skill')
  await pointClick('[data-curate="ungroup-preview"]')
  await assert(
    `document.querySelector('#dialog').textContent.includes('review-router/SKILL.md') && document.querySelector('#dialog').textContent.includes('retained with its curated members; no tag-file write') && document.querySelector('#dialog').textContent.includes('Create or reuse unchanged Full skill')`,
    'Ungrouping discloses the chosen standalone mode, router removal and retained project tag together',
  )
  await pointClick('[data-curate="apply"]')
  await assert(
    `!document.querySelector('.router-group') && document.querySelector('[data-curation-row="global"]').textContent.includes('Full') && document.querySelector('#skills-view').textContent.includes('Project tag retained')`,
    'Confirmed ungrouping restores standalone copies while retaining the tag and preserved library content',
  )
  await flow('curation')
  await click('[data-curation-menu="native-codex"]')
  await pointClick('[data-curate="router"]')
  await assert(
    `document.querySelector('#curation-name').value==='New router' && !document.querySelector('#curation-name').disabled`,
    'Creating a group offers an editable New router name',
  )
  await pointClick('#curation-name')
  await run(`document.querySelector('#curation-name').select()`)
  await call('Input.insertText', { text: 'Release helpers' })
  await pointClick('#curation-replace')
  await pointClick('[data-curate="router-preview"]')
  await assert(
    `document.querySelector('#dialog').textContent.includes('returned tag release-helpers') && document.querySelector('#dialog').textContent.includes('Project tag release-helpers: create') && !document.querySelector('#dialog').textContent.includes('Remove selected standalone')`,
    'New-name resolution previews the exact returned tag while an unchecked copy remains standalone',
  )
  await pointClick('[data-curate="apply"]')
  await assert(
    `document.querySelectorAll('.router-group').length===2 && document.querySelector('[data-curation-row="native-codex"]').textContent.includes('Full') && document.querySelector('[data-curation-router="review-router"]')`,
    'Creating another named router retains the unrelated group and unselected standalone copy',
  )
  await click('[data-curation-menu="native-codex"]')
  await pointClick('[data-curate="router"]')
  await run(`document.querySelector('#curation-name').value='Release helpers'`)
  await pointClick('[data-curate="router-preview"]')
  await assert(
    `document.querySelector('#dialog').textContent.includes('already exists') && !document.querySelector('[data-curate="apply"]')`,
    'A conflicting requested name requires a new choice instead of silently renaming on apply',
  )
  await pointClick('[data-action="close"]')
  await run(`document.querySelector('#curation-change-source').click()`)
  await pointClick('[data-curation-router="router-release-helpers"]')
  await pointClick('[data-curate="set-members"]')
  await pointClick('[data-router-member="native-codex"]')
  await choose('#curation-mode', 'Stub')
  await pointClick('[data-curate="members-preview"]')
  await assert(
    `document.querySelector('#dialog').textContent.includes('retained standalone copy has a different mode') && !document.querySelector('#dialog [data-curate="apply"]')`,
    'Restoring Stub cannot adopt or overwrite the retained unmanaged Full copy on membership authority',
  )
  await pointClick('[data-action="close"]')
  await pointClick('[data-curate="set-members"]')
  await pointClick('[data-router-member="native-codex"]')
  await choose('#curation-mode', 'Remove from project')
  await pointClick('[data-curate="members-preview"]')
  await assert(
    `document.querySelector('#dialog').textContent.includes('keep its existing Full skill standalone') && document.querySelector('#dialog').textContent.includes('without adoption or approval')`,
    'Membership-only departure previews retaining the standalone copy despite its changed original approval',
  )
  await pointClick('[data-curate="apply"]')
  await pointClick('[data-curation-select="native-codex"]')
  await assert(
    `document.querySelector('[data-curation-row="native-codex"]').textContent.includes('Full') && document.querySelector('#curation-approval').textContent==='Original needs review' && document.querySelector('#skills-view').textContent.includes('Full skill · Original source') && !document.querySelector('[data-router-row="router-release-helpers"]') && document.querySelector('[data-library-row="native-codex"]')`,
    'Removing only membership retains the Full unmanaged standalone, its pending original state and canonical library copy',
  )
  await flow('curation')
  await click('[data-curation-menu="native-codex"]')
  await pointClick('[data-curate="stub"]')
  await run(`document.querySelector('#curation-interrupt').click()`)
  await pointClick('[data-curate="apply"]')
  await assert(
    `document.querySelector('#dialog').textContent.includes('Some files may have changed') && !document.querySelector('[data-curate="apply"]')`,
    'Interrupted conversion reports uncertainty and removes the retryable preview',
  )
  await pointClick('[data-curate="reconcile"]')
  await assert(
    `document.querySelector('#skills-view').textContent.includes('originals retained; staging recovery remains required')`,
    'Explicit reconciliation reports observed originals and required recovery without inventing a completed conversion',
  )
  await click('[data-curation-menu="native-codex"]')
  await assert(
    `document.querySelector('[data-curate="stub"]').disabled && document.querySelector('#dialog').textContent.includes('recovery is still required')`,
    'Observed incomplete recovery keeps subsequent conversion unavailable',
  )
  await pointClick('[data-action="close"]')
  await pointClick('[data-router-menu="review-router"]')
  await pointClick('#dialog [data-curate="remove-router"]')
  await assert(
    `document.querySelector('#dialog').textContent.includes('recovery is still required') && !document.querySelector('#dialog [data-curate="apply"]')`,
    'Router-only removal also respects unresolved recovery despite requiring no accepted source body',
  )
  await flow('empty')
  const emptyInventory = await run(`document.querySelector('#content').innerHTML`)
  await assert(
    `document.querySelector('[data-action="sync-approved"]') && !document.querySelector('#explorer-workspace .curation-list')`,
    'An observed empty personal inventory has a visible explicit Sync approved skills action',
  )
  await pointClick('[data-action="sync-approved"]')
  await assert(
    `!document.querySelector('#sync-outcomes') && document.querySelector('#content').innerHTML===${JSON.stringify(emptyInventory)}`,
    'Opening backfill guidance does not sync or replace the observed inventory',
  )
  await pointClick('[data-action="close"]')
  await assert(
    `document.querySelector('#content').innerHTML===${JSON.stringify(emptyInventory)} && document.querySelector('#curation-lab').hidden`,
    'Canceling empty-library backfill preserves the existing inventory and onboarding',
  )
  await pointClick('[data-action="sync-approved"]')
  await pointClick('[data-curate="sync-confirm"]')
  await pointClick('[data-action="close"]')
  await assert(
    `document.querySelectorAll('[data-curation-row]').length>0 && [...document.querySelectorAll('summary')].some(el=>el.textContent==='Library actions') && !document.querySelector('[data-action="sync-approved"]')`,
    'Completed backfill shows the populated library with compact library actions and no onboarding card',
  )
  await pointClick('#search-disclosure > summary')
  await pointClick('#search')
  await call('Input.insertText', { text: 'no-such-skill' })
  await pointClick('#search-form button[type="submit"]')
  await waitFor(
    `document.querySelector('.explorer-search-results .curation-search-status').textContent.includes('0 results')`,
  )
  await assert(
    `document.querySelector('.explorer-search-results').textContent.includes('No skills match this view') && !document.querySelector('[data-action="sync-approved"]') && !document.querySelector('#content').textContent.includes('has no preserved skills')`,
    'Filtered no-match results never imply an empty library or repeat its onboarding action',
  )
  await pointClick('#library-nav')
  await assert(
    `!document.querySelector('.explorer-search-results') && document.querySelector('#library-nav').getAttribute('aria-expanded')==='true' && !document.querySelector('#explorer-library .explorer-scroll').hidden`,
    'Your library header leaves submitted search and opens its actual inventory directly',
  )
  await flow('curation')
  await click('#explorer-library [data-curation-menu="native-codex"]')
  await pointClick('#dialog [data-curate="sync"]')
  await run(`document.querySelector('#curation-interrupt-sync').click()`)
  await pointClick('[data-curate="sync-confirm"]')
  await assert(
    `document.querySelector('#sync-outcomes').textContent.includes('Uncertain') && !document.querySelector('[data-curate="sync-confirm"]')`,
    'Lost sync completion requires observation rather than an automatic write retry',
  )
  await pointClick('[data-curate="sync-status"]')
  await assert(
    `document.querySelector('#sync-outcomes').textContent.includes('Observed library version') && !document.querySelector('#sync-outcomes').textContent.includes('Created')`,
    'Read-only sync reconciliation reports current sample state without inventing operation history',
  )
  await flow('curation')
  await run(`document.querySelector('#curation-unsupported').click()`)
  await click('[data-curation-menu="native-codex"]')
  await assert(
    `document.querySelector('[data-curate="stub"]').disabled && document.querySelector('#dialog').textContent.includes('installed version cannot prepare')`,
    'Unsupported conversion contracts remain discoverable with an explicit reason and disabled actions',
  )
  await flow('curation')
  await click('#explorer-library [data-curation-select="environment"]')
  await run(
    `document.querySelector('#curation-change-source').click();document.querySelector('#curation-block-origin').click()`,
  )
  await pointClick('#search-disclosure > summary')
  await pointClick('#search-advanced > summary')
  await choose('#search-scope', 'personal')
  await pointClick('#search')
  await call('Input.insertText', { text: 'Environment' })
  await pointClick('#search-form button[type="submit"]')
  await waitFor(
    `document.querySelector('.explorer-search-results .curation-search-status').textContent.includes('1 results')`,
  )
  await pointClick('.explorer-search-results [data-curation-select="environment"]')
  await assert(
    `document.querySelector('.explorer-search-results [data-library-row="environment"]') && !document.querySelector('.explorer-search-results [data-library-row="pending-library"]')`,
    'Canonical search uses canonical approval and identifies its returned source despite original drift',
  )
  await pointClick('[data-curate="menu"]')
  await assert(
    `!document.querySelector('[data-curate="add"]').disabled && document.querySelector('#curation-approval').textContent.includes('Accepted library version')`,
    'A changed or blocked original does not revoke an independently accepted canonical library copy',
  )
  await pointClick('[data-curate="add"]')
  await pointClick('[data-curate="add-preview"]')
  await run(`document.querySelector('#curation-change-source').click()`)
  await pointClick('[data-curate="apply"]')
  await assert(
    `document.querySelector('[data-curation-row="environment"]') && !document.querySelector('#dialog').open`,
    'Canonical Add remains bound to its accepted library version when unrelated original content changes again',
  )
  await run(`document.querySelector('#curation-edit-library').click()`)
  await pointClick('#explorer-workspace [data-curation-select="environment"]')
  await assert(
    `document.querySelector('#curation-approval').textContent==='Accepted project copy · approved-v1'`,
    'The selected managed copy retains its own accepted version while the canonical working tree has pending edits',
  )
  await pointClick('[data-curate="menu"]')
  await assert(
    `!document.querySelector('[data-curate="remove"]').disabled && document.querySelector('[data-curate="update"]').disabled`,
    'Managed removal depends on the unchanged target; pending canonical edits still block Update',
  )
  await pointClick('[data-curate="remove"]')
  await pointClick('[data-curate="apply"]')
  await assert(
    `!document.querySelector('[data-curation-row="environment"]') && document.querySelector('[data-library-row="environment"]').textContent.includes('Review')`,
    'Removing an unchanged managed copy preserves the still-pending canonical edit without approving it',
  )
  await click('#explorer-library [data-curation-menu="collection"]')
  await assert(
    `!document.querySelector('[data-curate="add"]').disabled`,
    'An independently accepted canonical customization remains addable despite its sync conflict',
  )
  await pointClick('[data-action="close"]')
  await click('#explorer-library [data-curation-menu="pending-library"]')
  await assert(
    `document.querySelector('[data-curate="add"]').disabled && document.querySelector('#curation-approval').textContent==='Library changes need review'`,
    'A pending canonical customization never inherits the original source approval',
  )
  await pointClick('[data-action="close"]')
  await click('[data-curation-select="native-codex"]')
  await run(`document.querySelector('#curation-change-source').click()`)
  await pointClick('[data-curate="menu"]')
  await assert(
    `document.querySelector('[data-curate="stub"]').disabled && document.querySelector('[data-curate="files-remove"]')`,
    'Native conversion and preserved-native removal still refuse stale original-to-canonical proof',
  )
  await flow('curation')
  await pointClick('[data-expand="library:native-codex"]')
  await assert(
    `document.querySelector('#explorer-library .explorer-child').textContent.includes('Codex') && !document.querySelector('#curation-body')`,
    'Expanding a verified source relation shows its exact project copy without reading content',
  )
  await pointClick('[data-curation-select="native-codex"]')
  const selected = await run(`document.querySelector('#skills-view').innerHTML`)
  await pointClick('#library-nav')
  await assert(
    `document.querySelector('#library-nav').getAttribute('aria-expanded')==='false' && document.querySelector('#workspace-nav').getAttribute('aria-expanded')==='true' && document.querySelector('#skills-view').innerHTML===${JSON.stringify(selected)}`,
    'Collapsing Your library preserves the independently open project and selected viewer',
  )
  await run(`document.querySelector('#library-nav').focus()`)
  await key('Enter')
  await assert(
    `document.querySelector('#library-nav').getAttribute('aria-expanded')==='true'`,
    'Keyboard activation expands the library section',
  )
  await flow('curation')
  const libraryPoint = await run(
    `(()=>{const el=document.querySelector('[data-library-row="environment"]');el.scrollIntoView({block:'nearest'});const r=el.getBoundingClientRect();return {x:r.x+r.width/2,y:r.y+r.height/2}})()`,
  )
  await call('Input.dispatchMouseEvent', {
    type: 'mousePressed',
    ...libraryPoint,
    button: 'right',
    clickCount: 1,
  })
  await call('Input.dispatchMouseEvent', {
    type: 'mouseReleased',
    ...libraryPoint,
    button: 'right',
    clickCount: 1,
  })
  await assert(
    `document.querySelector('#dialog').open && document.querySelector('#dialog-title').textContent.includes('Environment checks')`,
    'Library context menu uses the same exact selection and actions as its row trigger',
  )
  await pointClick('#dialog [data-curate="sync"]')
  await pointClick('[data-curate="sync-confirm"]')
  await pointClick('[data-action="close"]')
  await click('#explorer-library [data-curation-menu="environment"]')
  await pointClick('[data-curate="add"]')
  await choose('#curation-add-agent', 'claude')
  await choose('#curation-mode', 'Stub')
  await pointClick('[data-curate="add-preview"]')
  await assert(
    `document.querySelector('#dialog').textContent.includes('/work/hvir/.claude/skills/lib-environment') && document.querySelector('#dialog').textContent.includes('absent') && document.querySelector('#dialog').textContent.includes('approved-v2')`,
    'Library Add previews the active project, chosen agent/mode and exact accepted source',
  )
  await pointClick('[data-curate="apply"]')
  await assert(
    `document.querySelector('[data-curation-row="environment"]').textContent.includes('Claude') && document.querySelector('[data-curation-row="environment"]').textContent.includes('Stub') && document.querySelector('[data-library-row="environment"]')`,
    'Add publishes the selected project copy and retains its library entry',
  )
  await flow('curation')
  await click('[data-curation-menu="managed"]')
  await pointClick('[data-curate="update"]')
  await assert(
    `document.querySelector('#dialog').textContent.includes('approved-v1') && document.querySelector('#dialog').textContent.includes('approved-v2')`,
    'Update discloses the old project version and the accepted library version together',
  )
  await pointClick('[data-curate="apply"]')
  await assert(
    `!document.querySelector('[data-curation-row="managed"]').textContent.includes('Update')`,
    'Explicit Update advances only the selected managed copy',
  )
  await flow('curation')
  await click('[data-curation-menu="native-codex"]')
  await pointClick('[data-curate="remove"]')
  await assert(
    `document.querySelector('#dialog').textContent.includes('Remove the exact original') && document.querySelector('#dialog').textContent.includes('Complete approved original bytes')`,
    'Approved native removal previews exact original tree effects and canonical preservation',
  )
  await pointClick('[data-curate="apply"]')
  await assert(
    `!document.querySelector('[data-curation-row="native-codex"]') && document.querySelector('[data-library-row="native-codex"]') && document.querySelector('[data-curation-row="native-claude"]')`,
    'Removing the selected project occurrence preserves the library and another agent copy',
  )
  await pointClick('[data-curation-router="review-router"]')
  await pointClick('[data-curate="set-members"]')
  await pointClick('[data-router-member="native-codex"]')
  await pointClick('[data-curate="members-preview"]')
  await assert(
    `document.querySelector('#dialog').textContent.includes('No standalone copy to remove at /work/hvir/.agents/skills/native-codex') && !document.querySelector('#dialog').textContent.includes('Remove selected standalone')`,
    'Adding an absent member previews router membership with no invented standalone removal',
  )
  await pointClick('[data-curate="apply"]')
  await assert(
    `document.querySelector('.router-group').textContent.includes('Release review') && !document.querySelector('[data-curation-row="native-codex"]') && document.querySelector('[data-library-row="native-codex"]')`,
    'An absent source becomes a router member without a standalone copy or library deletion',
  )
  await flow('curation')
  const ordinary = await run(
    `JSON.stringify([document.querySelector('#terminal-pane').innerHTML,document.querySelector('#document-view').innerHTML])`,
  )
  await click('[data-curation-menu="draft"]')
  await pointClick('[data-curate="files-remove"]')
  await assert(
    `!document.querySelector('#files-rail').hidden && document.querySelector('#files-selection').textContent.includes('/work/hvir/.claude/skills/draft') && !document.querySelector('#dialog').open`,
    'Unwanted pending content navigates to its exact folder in Files without approval or deletion',
  )
  await pointClick('[data-action="files-trash"]')
  await assert(
    `document.querySelector('#dialog-title').textContent==='Move to Trash' && document.querySelector('#dialog').textContent.includes('recovered from Trash')`,
    'Files owns the separate removal confirmation and actual sample-host recovery disclosure',
  )
  await pointClick('[data-action="close"]')
  await assert(
    `document.querySelector('[data-curation-row="draft"]') && !document.querySelector('[data-library-row="draft"]')`,
    'Canceling Files confirmation retains the unwanted original without accepting it',
  )
  await pointClick('[data-action="files-trash"]')
  await pointClick('[data-action="files-trash-confirm"]')
  await pointClick('[data-rail="skills"]')
  await assert(
    `!document.querySelector('[data-curation-row="draft"]') && !document.querySelector('[data-library-row="draft"]') && JSON.stringify([document.querySelector('#terminal-pane').innerHTML,document.querySelector('#document-view').innerHTML])===${JSON.stringify(ordinary)}`,
    'Files removal leaves unwanted content unapproved and preserves ordinary viewer/terminal content',
  )
  await flow('curation')
  await groupInExisting()
  await pointClick('[data-curate="apply"]')
  await pointClick('[data-curation-router="review-router"]')
  await run(`document.querySelector('#curation-change-source').click()`)
  await pointClick('[data-curate="set-members"]')
  await pointClick('[data-router-member="native-codex"]')
  await choose('#curation-mode', 'Remove from project')
  await pointClick('[data-curate="members-preview"]')
  await assert(
    `document.querySelector('#dialog').textContent.includes('create no standalone copy')`,
    'Removing router membership is distinct from restoring a Full or Stub copy',
  )
  await pointClick('[data-curate="apply"]')
  await assert(
    `!document.querySelector('[data-curation-row="native-codex"]') && document.querySelector('[data-library-row="native-codex"]') && !document.querySelector('.router-group').textContent.includes('Release review')`,
    'Member removal retains canonical content and the other router members',
  )
  await flow('curation')
  await call('Emulation.setDeviceMetricsOverride', {
    width: 920,
    height: 760,
    deviceScaleFactor: 1,
    mobile: false,
  })
  await pointClick('[data-curation-select="native-codex"]')
  await assert(
    `(()=>{const rows=[...document.querySelectorAll('#explorer-workspace .skill-row,#explorer-library .skill-row')]; const visible=rows.filter(row=>{const r=row.getBoundingClientRect(),v=row.closest('.explorer-scroll').getBoundingClientRect();return r.height>0&&r.top>=v.top&&r.bottom<=Math.min(v.bottom,innerHeight)});return visible.length>=8&&visible.every(row=>row.getBoundingClientRect().height<=28)&&document.documentElement.scrollWidth<=innerWidth})()`,
    'Compact explorer shows at least eight one-line skill rows across project/library sections without horizontal overflow',
  )
  await assert(
    `['draft','managed'].every(id=>{const row=document.querySelector('[data-curation-row="'+id+'"]'),status=row.querySelector('.row-status'),r=status.getBoundingClientRect();return status.textContent===(id==='draft'?'Review':'Update')&&r.width>0&&r.right<=row.getBoundingClientRect().right})`,
    'Compact actionable Review and Update labels remain visible independently of truncated names and agent text',
  )
  await capture('curation-compact')
  await run(`document.querySelector('#curation-long-project').click()`)
  await run(
    `document.querySelector('#explorer-workspace .explorer-scroll').scrollTop=10000`,
  )
  await assert(
    `(()=>{const header=document.querySelector('#library-nav').getBoundingClientRect();return header.top>=0&&header.bottom<innerHeight&&document.querySelectorAll('[data-curation-row]').length===45})()`,
    'Your library stays reachable when a long observed project list is scrolled to its end',
  )
  await pointClick('#library-nav')
  await pointClick('#library-nav')
  await capture('explorer-long-project')
  await call('Emulation.setDeviceMetricsOverride', {
    width: 1440,
    height: 1000,
    deviceScaleFactor: 1,
    mobile: false,
  })
}
