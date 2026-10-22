import { catalogCli, isStaleCatalogCursor } from './catalog-cli.mjs'
import { libraryPage } from './catalog.mjs'
import { sourcePage, libraryGroupingFailure } from './library-source-catalog.mjs'

/** Source disclosures own metadata traversal; the existing list owns occurrence actions. */
export function bindLibrarySources(document, list, navigation, client, ports) {
  const events = new document.defaultView.AbortController(),
    signal = events.signal
  let revision = 0,
    libraryKey,
    groups = [],
    active = false,
    disposed = false,
    busy = false
  const states = new Map(),
    cli = catalogCli(client, ports.context, () => revision)
  const usable = () => !disposed && active && ports.available()
  const header = (id) =>
    [...list.querySelectorAll('[data-source-toggle]')].find(
      (node) => node.dataset.sourceToggle === id,
    )
  function state(group) {
    if (!states.has(group.id))
      states.set(group.id, {
        group,
        expanded: false,
        rows: [],
        previous: [],
        cursor: undefined,
        next: null,
        loaded: false,
        serial: 0,
        request: undefined,
        loading: false,
        error: '',
      })
    const entry = states.get(group.id)
    entry.group = group
    return entry
  }
  function button(label, action, id) {
    const node = document.createElement('button')
    node.type = 'button'
    node.className = 'hvir-button hvir-focus'
    node.textContent = label
    node.dataset.sourceAction = action
    node.dataset.sourceId = id
    return node
  }
  function draw() {
    if (!usable()) return
    const focused = document.activeElement,
      groupFocus = focused?.dataset.sourceToggle ?? focused?.dataset.sourceId,
      focusAction = focused?.dataset.sourceAction,
      entries = groups.map(state),
      visible = entries.flatMap((entry) => (entry.expanded ? entry.rows : []))
    const arrange = (rows) => {
      const byId = new Map(rows.map((row) => [row.dataset.id, row]))
      return entries.map((entry) => {
        const group = entry.group,
          section = document.createElement('div'),
          toggle = button('', 'toggle', group.id),
          label = document.createElement('span'),
          count = document.createElement('small'),
          content = document.createElement('div')
        section.className = 'library-source'
        section.setAttribute('role', 'listitem')
        toggle.classList.add('library-source-toggle')
        toggle.dataset.sourceToggle = group.id
        toggle.id = `source-toggle-${group.id.slice(7)}`
        toggle.setAttribute('aria-expanded', String(entry.expanded))
        toggle.setAttribute('aria-controls', `source-content-${group.id.slice(7)}`)
        toggle.title = group.detail ?? group.label
        if (group.detail) toggle.setAttribute('aria-description', group.detail)
        label.textContent = group.label
        count.textContent = String(group.count)
        count.className = 'hvir-meta'
        toggle.append(label, count)
        if (
          group.detail &&
          groups.some((other) => other.id !== group.id && other.label === group.label)
        ) {
          const detail = document.createElement('small')
          detail.className = 'hvir-meta library-source-detail'
          detail.textContent = group.detail
          toggle.append(detail)
        }
        content.id = `source-content-${group.id.slice(7)}`
        content.className = 'library-source-content'
        content.hidden = !entry.expanded
        content.setAttribute('role', 'list')
        content.setAttribute('aria-busy', String(entry.loading))
        content.setAttribute('aria-labelledby', toggle.id)
        if (entry.expanded) {
          content.append(
            ...entry.rows.map((row) => {
              const node = byId.get(row.id)
              node.querySelector('small').hidden = true
              return node
            }),
          )
          if (entry.loading || entry.error || (entry.loaded && !entry.rows.length)) {
            const message = document.createElement('p')
            message.className = 'hvir-meta library-source-state'
            message.setAttribute('role', 'status')
            message.textContent = entry.loading
              ? 'Loading…'
              : entry.error || 'No skills in this source.'
            content.append(message)
          }
          if (entry.error) content.append(button('Try again', 'retry', group.id))
          if (entry.previous.length || entry.next) {
            const pager = document.createElement('div')
            pager.className = 'library-source-pages'
            const previous = button('Previous', 'previous', group.id),
              next = button('Next', 'next', group.id),
              position = document.createElement('small')
            previous.disabled = entry.loading || !entry.previous.length
            next.disabled = entry.loading || !entry.next
            position.className = 'hvir-meta'
            position.textContent = `Page ${entry.previous.length + 1}`
            pager.append(previous, position, next)
            content.append(pager)
          }
        }
        section.append(toggle, content)
        return section
      })
    }
    navigation.render(visible, ports.selected()?.id, arrange, true)
    if (groupFocus) {
      const target =
        focusAction && focusAction !== 'toggle'
          ? [...list.querySelectorAll('[data-source-action]')].find(
              (node) =>
                node.dataset.sourceId === groupFocus &&
                node.dataset.sourceAction === focusAction,
            )
          : header(groupFocus)
      ;(target ?? header(groupFocus))?.focus({ preventScroll: true })
    }
  }
  function enqueue(
    entry,
    target = { cursor: entry.cursor, previous: [...entry.previous] },
  ) {
    entry.request = { ...target, serial: ++entry.serial }
    entry.loading = true
    entry.error = ''
  }
  async function load(entry, request, generation) {
    const current = () =>
      usable() &&
      revision === generation &&
      entry.expanded &&
      entry.serial === request.serial &&
      groups.some((group) => group.id === entry.group.id)
    let target = request
    for (let attempt = 0; attempt < 2; attempt++) {
      try {
        const value = await cli([
          'list',
          '--scope',
          'library',
          '--json',
          '--limit',
          '100',
          '--source-group',
          entry.group.id,
          ...(target.cursor ? ['--cursor', target.cursor] : []),
        ])
        if (!current()) return
        const page = sourcePage(value, libraryPage(value), entry.group.id)
        entry.rows = page.rows
        entry.group.count = page.total
        entry.next = page.next
        entry.cursor = target.cursor
        entry.previous = target.previous
        entry.loaded = true
        entry.error = ''
        return
      } catch (error) {
        if (!current()) return
        if (attempt === 0 && target.cursor && isStaleCatalogCursor(error)) {
          target = { ...target, cursor: undefined, previous: [] }
          continue
        }
        entry.error = libraryGroupingFailure(error).message
        return
      }
    }
  }
  async function pump() {
    if (busy || !usable()) return
    const entry = groups.map(state).find((value) => value.expanded && value.request)
    if (!entry) return
    busy = true
    const request = entry.request,
      generation = revision
    entry.request = undefined
    try {
      await load(entry, request, generation)
    } finally {
      if (entry.serial === request.serial) entry.loading = false
      busy = false
      draw()
      void pump()
    }
  }
  function toggle(entry, force) {
    entry.expanded = force ?? !entry.expanded
    if (entry.expanded) {
      if (!entry.loaded || entry.error) enqueue(entry)
    } else {
      entry.serial++
      entry.request = undefined
      entry.loading = false
      navigation.close()
    }
    draw()
    header(entry.group.id)?.focus({ preventScroll: true })
    void pump()
  }
  list.addEventListener(
    'click',
    (event) => {
      const control = event.target.closest('[data-source-action]')
      if (!control || !usable()) return
      const entry = states.get(control.dataset.sourceId)
      if (!entry || !groups.some((group) => group.id === entry.group.id)) return
      const action = control.dataset.sourceAction
      if (action === 'toggle') toggle(entry)
      else if (entry.expanded && !entry.loading) {
        if (action === 'next' && entry.next)
          enqueue(entry, {
            cursor: entry.next,
            previous: [...entry.previous, entry.cursor],
          })
        else if (action === 'previous' && entry.previous.length)
          enqueue(entry, {
            cursor: entry.previous.at(-1),
            previous: entry.previous.slice(0, -1),
          })
        else if (action === 'retry') enqueue(entry)
        draw()
        void pump()
      }
    },
    { signal },
  )
  list.addEventListener(
    'keydown',
    (event) => {
      if (!usable()) return
      const row = event.target.closest('[data-skill-occurrence]')
      if (row && ['ArrowUp', 'ArrowDown'].includes(event.key)) {
        const source = row
            .closest('.library-source')
            .querySelector('[data-source-toggle]'),
          entry = states.get(source.dataset.sourceToggle),
          index = entry.rows.findIndex((item) => item.id === row.dataset.id),
          next =
            event.key === 'ArrowUp' && index === 0
              ? source
              : event.key === 'ArrowDown' && index === entry.rows.length - 1
                ? header(
                    groups[groups.findIndex((group) => group.id === entry.group.id) + 1]
                      ?.id,
                  )
                : undefined
        if (next) {
          event.preventDefault()
          event.stopPropagation()
          next.focus()
        }
        return
      }
      const control = event.target.closest('[data-source-toggle]')
      if (!control) return
      const entry = states.get(control.dataset.sourceToggle),
        index = groups.findIndex((g) => g.id === entry?.group.id)
      if (!entry || index < 0) return
      if (event.key === 'ArrowRight' && !entry.expanded) {
        event.preventDefault()
        toggle(entry, true)
      } else if (event.key === 'ArrowLeft' && entry.expanded) {
        event.preventDefault()
        toggle(entry, false)
      } else if (
        (event.key === 'ArrowRight' || event.key === 'ArrowDown') &&
        entry.expanded &&
        entry.rows.length
      ) {
        event.preventDefault()
        control.nextElementSibling.querySelector('[data-skill-select]')?.focus()
      } else if (['ArrowUp', 'ArrowDown', 'Home', 'End'].includes(event.key)) {
        event.preventDefault()
        const next =
          event.key === 'Home'
            ? 0
            : event.key === 'End'
              ? groups.length - 1
              : Math.max(
                  0,
                  Math.min(
                    groups.length - 1,
                    index + (event.key === 'ArrowDown' ? 1 : -1),
                  ),
                )
        header(groups[next].id)?.focus()
      }
    },
    { signal, capture: true },
  )
  function pause() {
    active = false
    revision++
    for (const entry of states.values()) {
      entry.serial++
      entry.request = undefined
      entry.loading = false
    }
  }
  return {
    pause,
    render(page, library, observe = true) {
      const key = JSON.stringify({ id: library.id, root: library.root })
      if (key !== libraryKey) {
        pause()
        states.clear()
        libraryKey = key
      }
      active = true
      groups = page.groups
      const current = new Set(groups.map((group) => group.id))
      for (const [id, entry] of states)
        if (!current.has(id)) {
          entry.serial++
          entry.request = undefined
          states.delete(id)
        }
      for (const group of groups) {
        const entry = state(group)
        if (entry.expanded && (observe || (!entry.loaded && !entry.loading)))
          enqueue(entry)
      }
      draw()
      void pump()
    },
    dispose() {
      if (disposed) return
      pause()
      disposed = true
      events.abort()
      states.clear()
    },
  }
}
