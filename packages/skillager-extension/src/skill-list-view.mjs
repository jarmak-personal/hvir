/** Skill occurrence rows and their one transient action menu; opening is presentation only. */
export function skillRowActions(row, workspace) {
  const original = row.source === 'project' && row.kind === 'Project original',
    local = row.host === 'local',
    managed = row.source === 'project' && row.exposure,
    router = row.kind === 'Installed Router'
  return [
    ...(original && local ? [{ id: 'save', label: 'Save to library…' }] : []),
    ...(!router &&
    local &&
    (row.source === 'library' ||
      row.canonical ||
      (original && ['codex', 'claude'].includes(row.agent)))
      ? [
          { id: 'native', label: 'Use full copy…' },
          { id: 'stub', label: 'Use stub…' },
        ]
          .filter(
            (item) => item.id !== 'stub' || !workspace || workspace.host === 'local',
          )
          .map((item) => ({
            ...item,
            checked: managed ? row.exposure.mode === item.id : undefined,
          }))
      : []),
    ...((original && local) || (managed && local && !router)
      ? [{ id: 'remove', label: 'Remove from project…' }]
      : []),
    ...(router ? [{ id: 'router', label: 'View Router members…' }] : []),
    ...(row.source === 'project' ? [{ id: 'reveal', label: 'Show in Files' }] : []),
  ]
}

export function bindSkillList(document, list, ports) {
  const window = document.defaultView,
    events = new window.AbortController(),
    signal = events.signal,
    menu = document.createElement('div')
  menu.className = 'skill-row-menu'
  menu.id = 'skill-row-menu'
  menu.setAttribute('role', 'menu')
  menu.setAttribute('aria-label', 'Skill actions')
  menu.hidden = true
  document.body.append(menu)
  let items = [],
    current,
    selectedIdentity,
    exactSelection = false,
    opened,
    disposed = false
  const identity = (item) => JSON.stringify(item)
  const actionsFor = (item) => skillRowActions(item, ports.workspace?.())
  const byId = (id) => items.find((item) => item.id === id)
  const rowNodes = () => [...list.querySelectorAll('[data-skill-occurrence]')]
  const rowFor = (item) => rowNodes().find((node) => node.dataset.id === item?.id)
  function select(item, { focus = false, action = false, choose = false } = {}) {
    if (!item) return
    current = item.id
    if (!exactSelection || choose) selectedIdentity = item.id
    for (const row of rowNodes()) {
      const selected = row.dataset.id === current,
        button = row.querySelector('[data-skill-select]'),
        more = row.querySelector('[data-skill-actions]')
      button.setAttribute(
        'aria-current',
        String(row.dataset.id === (exactSelection ? selectedIdentity : current)),
      )
      button.tabIndex = selected ? 0 : -1
      if (more) more.tabIndex = selected ? 0 : -1
    }
    if (!exactSelection || choose) ports.selected(item)
    if (focus)
      rowFor(item)
        ?.querySelector(action ? '[data-skill-actions]' : '[data-skill-select]')
        ?.focus()
  }
  function close(restore = false) {
    const previous = opened
    opened = undefined
    menu.hidden = true
    menu.replaceChildren()
    rowFor(previous?.item)
      ?.querySelector('[data-skill-actions]')
      ?.setAttribute('aria-expanded', 'false')
    if (restore && previous) {
      const target = previous.trigger?.isConnected
        ? previous.trigger
        : rowFor(previous.item)?.querySelector('[data-skill-select]')
      target?.focus({ preventScroll: true })
    }
  }
  function open(item, trigger, point) {
    if (disposed || !ports.available() || !item) return
    const actions = actionsFor(item)
    if (!actions.length) return
    close()
    opened = {
      item,
      key: identity(item),
      trigger,
      action: trigger?.hasAttribute('data-skill-actions'),
    }
    rowFor(item)
      ?.querySelector('[data-skill-actions]')
      ?.setAttribute('aria-expanded', 'true')
    menu.replaceChildren(
      ...actions.map((action) => {
        const button = document.createElement('button')
        button.type = 'button'
        button.className = 'hvir-button'
        button.dataset.task = action.id
        button.setAttribute(
          'role',
          action.checked === undefined ? 'menuitem' : 'menuitemradio',
        )
        if (action.checked !== undefined)
          button.setAttribute('aria-checked', String(action.checked))
        button.textContent = action.label
        button.disabled = action.checked === true
        button.tabIndex = -1
        return button
      }),
    )
    menu.hidden = false
    const rect = trigger.getBoundingClientRect(),
      bounds = menu.getBoundingClientRect()
    menu.style.left = `${Math.max(4, Math.min(point?.x ?? rect.left, window.innerWidth - bounds.width - 4))}px`
    menu.style.top = `${Math.max(4, Math.min(point?.y ?? rect.bottom, window.innerHeight - bounds.height - 4))}px`
    menu.querySelector('button:not(:disabled)')?.focus({ preventScroll: true })
  }
  list.addEventListener(
    'click',
    (event) => {
      const row = event.target.closest('[data-skill-occurrence]'),
        item = byId(row?.dataset.id)
      if (!item || !ports.available()) return
      const more = event.target.closest('[data-skill-actions]')
      if (more) open(item, more)
      else if (event.target.closest('[data-skill-select]')) {
        close()
        select(item, { choose: true })
        ports.choose(item)
      }
    },
    { signal },
  )
  list.addEventListener(
    'contextmenu',
    (event) => {
      const row = event.target.closest('[data-skill-occurrence]'),
        item = byId(row?.dataset.id)
      if (!item || !ports.available() || !actionsFor(item).length) return
      event.preventDefault()
      event.stopPropagation()
      open(item, row.querySelector('[data-skill-actions]'), {
        x: event.clientX,
        y: event.clientY,
      })
    },
    { signal },
  )
  list.addEventListener(
    'keydown',
    (event) => {
      const row = event.target.closest('[data-skill-occurrence]'),
        item = byId(row?.dataset.id)
      if (!item || !ports.available()) return
      if (event.key === 'ContextMenu' || (event.shiftKey && event.key === 'F10')) {
        event.preventDefault()
        open(item, event.target)
        return
      }
      const index = items.indexOf(item),
        action = event.target.hasAttribute('data-skill-actions')
      let target
      if (event.key === 'ArrowDown') target = items[Math.min(index + 1, items.length - 1)]
      else if (event.key === 'ArrowUp') target = items[Math.max(index - 1, 0)]
      else if (event.key === 'Home') target = items[0]
      else if (event.key === 'End') target = items.at(-1)
      else if (event.key === 'ArrowLeft' || event.key === 'ArrowRight') {
        event.preventDefault()
        row
          .querySelector(
            event.key === 'ArrowRight' ? '[data-skill-actions]' : '[data-skill-select]',
          )
          ?.focus()
        return
      } else return
      event.preventDefault()
      select(target, {
        focus: true,
        action: action && !!rowFor(target)?.querySelector('[data-skill-actions]'),
      })
    },
    { signal },
  )
  menu.addEventListener(
    'click',
    (event) => {
      const button = event.target.closest('button'),
        captured = opened
      if (!captured || !button || button.disabled) return
      const item = byId(captured.item.id),
        task = button.dataset.task
      close(true)
      if (ports.available() && item && identity(item) === captured.key)
        ports.task(item, task, captured.trigger)
    },
    { signal },
  )
  menu.addEventListener(
    'keydown',
    (event) => {
      const buttons = [...menu.querySelectorAll('button:not(:disabled)')],
        index = buttons.indexOf(document.activeElement)
      if (event.key === 'Escape' || event.key === 'Tab') {
        if (event.key === 'Escape') event.preventDefault()
        event.stopPropagation()
        close(true)
        return
      }
      let next
      if (event.key === 'ArrowDown') next = buttons[(index + 1) % buttons.length]
      else if (event.key === 'ArrowUp')
        next = buttons[(index - 1 + buttons.length) % buttons.length]
      else if (event.key === 'Home') next = buttons[0]
      else if (event.key === 'End') next = buttons.at(-1)
      if (next) {
        event.preventDefault()
        event.stopPropagation()
        next.focus()
      }
    },
    { signal },
  )
  document.addEventListener(
    'pointerdown',
    (event) => {
      if (
        opened &&
        !menu.contains(event.target) &&
        !opened.trigger?.contains(event.target)
      )
        close()
    },
    { signal },
  )
  window.addEventListener('resize', () => close(), { signal })
  list.addEventListener('scroll', () => close(), { signal })
  function focusCurrent() {
    const button = rowFor(byId(current))?.querySelector('[data-skill-select]')
    if (button) button.focus({ preventScroll: true })
    else ports.emptyFocus?.()
  }
  return {
    close,
    focusCurrent,
    render(next, selected, arrange, preserveSelection = false) {
      if (disposed) return
      exactSelection = preserveSelection
      selectedIdentity = selected
      const retired = opened && !next.some((item) => identity(item) === opened.key),
        restore = retired && menu.contains(document.activeElement),
        previousIndex = items.findIndex((item) => item.id === current)
      if (retired) close()
      const scroll = list.scrollTop,
        focused = document.activeElement,
        focusId = focused?.closest('[data-skill-occurrence]')?.dataset.id,
        focusAction = focused?.hasAttribute('data-skill-actions')
      items = next
      current = next.some((item) => item.id === selected)
        ? selected
        : next.some((item) => item.id === current)
          ? current
          : next[Math.max(0, Math.min(previousIndex, next.length - 1))]?.id
      const rendered = next.map((item) => {
        const row = document.createElement('div'),
          button = document.createElement('button'),
          name = document.createElement('strong'),
          description = document.createElement('span'),
          meta = document.createElement('small')
        row.className = 'skill-list-row'
        row.dataset.skillOccurrence = ''
        row.dataset.id = item.id
        row.setAttribute('role', 'listitem')
        button.type = 'button'
        button.className = 'hvir-button hvir-row hvir-focus'
        button.dataset.variant = 'selectable'
        button.dataset.skillSelect = ''
        button.dataset.id = item.id
        button.dataset.sourcePath = item.path
        button.dataset.source = item.source
        button.tabIndex = item.id === current ? 0 : -1
        button.setAttribute(
          'aria-current',
          String(item.id === (exactSelection ? selected : current)),
        )
        name.textContent = item.name
        description.textContent = item.description || item.kind
        meta.className = 'hvir-meta'
        meta.textContent =
          item.source === 'project'
            ? `${item.kind.replace('Installed ', '')}${item.exposure?.agent ? ` · ${item.exposure.agent}` : ''}`
            : (item.sourceGroup?.label ?? '')
        if (item.sourceGroup?.detail) meta.title = item.sourceGroup.detail
        button.append(name, description, meta)
        row.append(button)
        if (actionsFor(item).length) {
          const more = document.createElement('button')
          more.type = 'button'
          more.className = 'hvir-button skill-row-more'
          more.dataset.skillActions = ''
          more.textContent = '…'
          more.setAttribute('aria-label', `Actions for ${item.name}`)
          more.setAttribute('aria-haspopup', 'menu')
          more.setAttribute('aria-controls', menu.id)
          more.setAttribute('aria-expanded', 'false')
          more.tabIndex = item.id === current ? 0 : -1
          row.append(more)
        }
        return row
      })
      list.replaceChildren(...(arrange ? arrange(rendered) : rendered))
      list.scrollTop = scroll
      if (opened) {
        const row = rowFor(opened.item)
        opened.trigger = row?.querySelector(
          opened.action ? '[data-skill-actions]' : '[data-skill-select]',
        )
        row?.querySelector('[data-skill-actions]')?.setAttribute('aria-expanded', 'true')
      }
      if (restore || (focusId && !byId(focusId))) focusCurrent()
      else if (focusId)
        rowFor(byId(focusId))
          ?.querySelector(focusAction ? '[data-skill-actions]' : '[data-skill-select]')
          ?.focus({ preventScroll: true })
    },
    dispose() {
      if (disposed) return
      disposed = true
      close()
      events.abort()
      menu.remove()
    },
  }
}
