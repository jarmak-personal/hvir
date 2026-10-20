/* global AbortController */
import { libraryPage, searchPage, searchArgs } from './catalog.mjs'
import { exposureRequest } from './exposure-contract.mjs'
import { isStaleCatalogCursor } from './catalog-cli.mjs'
import { isCanonicalSkillId } from './public-metadata.mjs'

/** Temporary membership picker: one public page plus exact retained selections. */
export function bindExposureMembers(document, client, ports) {
  const el = (id) => document.getElementById(`exposure-${id}`)
  let selected = new Map(),
    page,
    query = '',
    cursor,
    previous = [],
    generation = 0,
    loading = false,
    active = false,
    pageEvents,
    selectionEvents
  const on = (id, event, work) =>
    el(id).addEventListener(event, work, { signal: client.signal })
  function summary() {
    selectionEvents?.abort()
    selectionEvents = new AbortController()
    el('selected-count').textContent = `${selected.size} selected`
    el('selected-members').replaceChildren()
    for (const row of selected.values()) {
      const item = document.createElement('li'),
        button = document.createElement('button')
      button.className = 'hvir-button'
      button.textContent = row.name ?? row.id
      button.title = `${ports.library().id} · ${row.id}`
      button.setAttribute('aria-label', `Remove ${row.name ?? row.id} from selection`)
      button.addEventListener('click', () => choose(row, false), {
        signal: selectionEvents.signal,
      })
      item.append(button)
      el('selected-members').append(item)
    }
  }
  function choose(row, checked) {
    if (!active) return
    if (loading || !ports.available()) {
      summary()
      render()
      return
    }
    const next = new Map(selected)
    if (checked) next.set(row.id, row)
    else next.delete(row.id)
    try {
      // Reuse complete request admission rather than silently dropping off-page choices.
      exposureRequest(
        JSON.stringify({
          schema: 'skillager.exposure-request.v1',
          action: 'group',
          library_id: ports.library().id,
          members: [...next.keys()],
          replace: [],
        }),
      )
      selected = next
      summary()
      ports.changed()
    } catch (error) {
      ports.say(error.message)
    }
    render()
  }
  function render() {
    pageEvents?.abort()
    pageEvents = new AbortController()
    el('member-results').replaceChildren()
    for (const row of page?.rows ?? []) {
      const label = document.createElement('label'),
        input = document.createElement('input'),
        name = document.createElement('span')
      input.type = 'checkbox'
      input.checked = selected.has(row.id)
      input.disabled = loading
      input.dataset.skillId = row.id
      input.addEventListener('change', () => choose(row, input.checked), {
        signal: pageEvents.signal,
      })
      name.textContent = row.name
      label.title = `${ports.library().id} · ${row.id}\n${row.description ?? ''}`
      label.append(input, name)
      el('member-results').append(label)
    }
    el('member-previous').disabled = loading || !previous.length
    el('member-next').disabled = loading || !page?.next
    el('member-search-button').disabled = loading
    el('member-page').textContent = loading ? 'Loading…' : `Page ${previous.length + 1}`
  }
  async function load(nextQuery, nextCursor, history) {
    if (!active || !ports.available()) return
    const revision = ++generation
    loading = true
    render()
    try {
      const io = ports.io(),
        value = nextQuery
          ? searchPage(await io.run(searchArgs(nextQuery, { cursor: nextCursor ?? '' })))
          : libraryPage(
              await io.run([
                'list',
                '--scope',
                'library',
                '--json',
                '--limit',
                '50',
                ...(nextCursor ? ['--cursor', nextCursor] : []),
              ]),
            )
      if (!active || !ports.available() || revision !== generation) return
      // Search rows retain occurrence IDs; membership uses the public canonical pair.
      if (nextQuery)
        value.rows = value.rows.map((row) => {
          if (row.canonical?.library_id !== ports.library().id)
            throw new Error('Member search did not identify this exact library.')
          return { ...row, id: row.canonical.skill_id }
        })
      if (
        value.rows.some(
          (row) =>
            row.source !== 'library' ||
            row.host !== 'local' ||
            !isCanonicalSkillId(row.id) ||
            !row.path.startsWith(`${ports.library().root.path}/`),
        ) ||
        new Set(value.rows.map((row) => row.id)).size !== value.rows.length
      )
        throw new Error(
          'Member choices no longer belong to this library. Refresh the task.',
        )
      page = value
      query = nextQuery
      cursor = nextCursor
      previous = history
      for (const row of page.rows) if (selected.has(row.id)) selected.set(row.id, row)
      summary()
    } catch (error) {
      if (active && ports.available() && revision === generation) {
        if (nextCursor && isStaleCatalogCursor(error)) {
          // One metadata-only restart; first-page failures cannot recurse.
          ports.say('Skills changed; showing first page.')
          await load(nextQuery, undefined, [])
        } else ports.say(error.message)
      }
    } finally {
      if (revision === generation) {
        loading = false
        render()
      }
    }
  }
  on('member-search', 'submit', (event) => {
    event.preventDefault()
    void load(el('member-query').value.trim(), undefined, [])
  })
  on('member-next', 'click', () => {
    if (page?.next) void load(query, page.next, [...previous, cursor])
  })
  on('member-previous', 'click', () => {
    if (previous.length) void load(query, previous.at(-1), previous.slice(0, -1))
  })
  return {
    ids: () => [...selected.keys()],
    start(rows) {
      generation++
      active = true
      selected = new Map(rows.map((row) => [row.id, row]))
      page = undefined
      query = ''
      cursor = undefined
      previous = []
      el('member-query').value = ''
      summary()
      void load('', undefined, [])
    },
    stop() {
      active = false
      generation++
      loading = false
      pageEvents?.abort()
      selectionEvents?.abort()
      selected.clear()
      page = undefined
      el('member-results').replaceChildren()
      el('selected-members').replaceChildren()
    },
  }
}
