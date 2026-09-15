const { document } = globalThis
import {
  curationSample,
  curationSource,
  curationRouter,
  standaloneCopyPresent,
  syncCurationSample,
  prepareCurationSample,
  applyCurationSample,
} from './curation-model.mjs'
import {
  curationMenuView,
  curationRouterMenuView,
  curationPickerView,
  curationPreviewView,
  curationSyncView,
} from './curation-views.mjs'

export function createCurationActions(ports) {
  return function curate(name) {
    const {
      state,
      reader,
      render,
      modal,
      closeDialog,
      cancelSearch,
      selectViewer,
      revealSkillInFiles,
      directAdd,
    } = ports.current()
    const $ = (selector) => document.querySelector(selector)
    let preview = ports.preview()
    const retain = (value) => {
      preview = value
      ports.setPreview(value)
    }
    if (!state.enabled || !state.connected) return
    if (!state.curation) {
      if (name !== 'sync-confirm' || !state.empty) return
      state.curation = curationSample({ emptyLibrary: true })
      state.empty = false
    }
    const c = state.curation
    if (name === 'review') {
      reader.revoke()
      state.reviewOpen = true
      return render()
    }
    if (['files-remove', 'review-files'].includes(name))
      return revealSkillInFiles(curationSource(state))
    if (name === 'menu') return modal(curationMenuView(state))
    if (name === 'router-menu') return modal(curationRouterMenuView(state))
    if (name === 'remove-router') {
      retain({ ...prepareCurationSample(state, name), curation: true })
      return modal(curationPreviewView(state, preview))
    }
    if (name === 'sync') return modal(curationSyncView(state))
    if (name === 'sync-status') {
      c.syncUncertain = false
      c.outcomes = c.sources.map((row) => ({
        id: row.id,
        name: row.name,
        agent: row.agent,
        origin: row.origin,
        outcome: row.preserved
          ? `Observed library version: ${row.libraryVersion}`
          : 'No preserved library version observed',
      }))
      return modal(curationSyncView(state))
    }
    if (name === 'sync-confirm') {
      syncCurationSample(state)
      cancelSearch()
      render()
      return modal(curationSyncView(state))
    }
    if (name === 'select-router') {
      c.selectedRouter = true
      state.reviewOpen = false
      state.skillsOpen = true
      return selectViewer('skills')
    }
    if (name === 'reconcile') {
      c.uncertain = false
      c.recoveryRequired = true
      c.lastEffect = `Observed sample: originals retained; staging recovery remains required. Library unchanged; further conversion is unavailable.`
      closeDialog()
      return render()
    }
    if (name === 'apply' && preview?.curation) {
      const failure = applyCurationSample(state, preview)
      if (failure) {
        retain(null)
        return modal(
          `<h2 id="dialog-title">Check this result</h2><p>${failure}</p>${c.uncertain ? '<button data-curate="reconcile">Check result</button>' : ''}<footer><button data-action="close">Close</button></footer>`,
        )
      }
      closeDialog()
      cancelSearch()
      return render()
    }
    if (name === 'add') {
      const menu = $('#dialog').open
      const options = {
        agent: menu ? state.agent : $('#curation-add-agent')?.value || state.agent,
        mode: !menu && $('#curation-mode')?.value === 'Stub' ? 'stub' : 'native',
      }
      closeDialog()
      cancelSearch()
      return directAdd.start(options)
    }
    if (['router', 'set-members', 'ungroup'].includes(name))
      return modal(curationPickerView(state, name))
    if (['router-preview', 'members-preview', 'ungroup-preview'].includes(name)) {
      const router = curationRouter(state)
      const options =
        name === 'router-preview'
          ? {
              routerId: $('#curation-group').value,
              name: $('#curation-name').value,
              replace: $('#curation-replace').checked ? [c.selected] : [],
            }
          : {
              routerId: router.id,
              mode: $('#curation-mode').value,
              members: [...document.querySelectorAll('[data-router-member]:checked')].map(
                (el) => el.dataset.routerMember,
              ),
            }
      if (name === 'members-preview')
        options.replace = options.members.filter(
          (id) =>
            !router.members.includes(id) &&
            standaloneCopyPresent(curationSource(state, id)),
        )
      retain({
        ...prepareCurationSample(
          state,
          name === 'router-preview'
            ? 'router'
            : name === 'members-preview'
              ? 'set-members'
              : 'ungroup',
          options,
        ),
        curation: true,
      })
      return modal(curationPreviewView(state, preview))
    }
    if (['full', 'stub', 'update', 'remove'].includes(name)) {
      retain({ ...prepareCurationSample(state, name), curation: true })
      return modal(curationPreviewView(state, preview))
    }
  }
}
