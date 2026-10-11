/* global window, document */
/** Browser-local helpers. The public bridge remains the only host request surface. */
window.hvirUI = Object.freeze({
  bindPresentation(bridge, root = document.documentElement) {
    let disposed = false
    const apply = (value) => {
      if (disposed) return
      root.dataset.theme = value.appearance
      root.style.colorScheme = value.appearance
      for (const [token, color] of Object.entries(value.colors))
        root.style.setProperty(token, color)
      root.style.setProperty('--hvir-interface-font', value.fontFamily)
      root.style.setProperty('--hvir-monospace-font', value.monospaceFontFamily)
      root.style.setProperty('--hvir-interface-scale', String(value.interfaceScale))
    }
    let unsubscribe = () => {}
    const acquired = bridge.onMessage((message) => {
      if (disposed) return
      if (message.kind === 'hello' || message.kind === 'presentation')
        apply(message.presentation)
      else if (message.kind === 'revoked') dispose()
    })
    unsubscribe = acquired
    if (disposed) unsubscribe()
    function dispose() {
      if (disposed) return
      disposed = true
      unsubscribe()
    }
    return dispose
  },
  bindList(list, onSelect) {
    let disposed = false
    const rows = () => {
      const visibility = new Map()
      const visible = (node) => {
        if (!node) return true
        if (visibility.has(node)) return visibility.get(node)
        const style = window.getComputedStyle(node)
        const result =
          !node.hidden &&
          style.display !== 'none' &&
          style.visibility !== 'hidden' &&
          visible(node.parentElement)
        visibility.set(node, result)
        return result
      }
      return [...list.children].filter(
        (row) =>
          row.getAttribute('role') === 'option' &&
          !row.disabled &&
          row.getAttribute('aria-disabled') !== 'true' &&
          visible(row),
      )
    }
    const select = (row, focus, options) => {
      if (disposed || !row || !options.includes(row)) return
      for (const option of options) {
        option.tabIndex = option === row ? 0 : -1
        option.setAttribute('aria-selected', String(option === row))
      }
      if (focus) row.focus()
      onSelect(row)
    }
    const click = (event) =>
      select(event.target.closest('[role="option"]'), false, rows())
    const keydown = (event) => {
      const options = rows()
      const index = options.indexOf(event.target.closest('[role="option"]'))
      if (index < 0) return
      let target
      if (event.key === 'ArrowDown')
        target = options[Math.min(index + 1, options.length - 1)]
      else if (event.key === 'ArrowUp') target = options[Math.max(index - 1, 0)]
      else if (event.key === 'Home') target = options[0]
      else if (event.key === 'End') target = options.at(-1)
      else return
      if (target) {
        event.preventDefault()
        select(target, true, options)
      }
    }
    const refresh = () => {
      if (disposed) return
      const options = rows()
      const selected =
        options.find((row) => row.getAttribute('aria-selected') === 'true') ?? options[0]
      for (const row of options) row.tabIndex = row === selected ? 0 : -1
    }
    list.addEventListener('click', click)
    list.addEventListener('keydown', keydown)
    refresh()
    return Object.freeze({
      refresh,
      dispose() {
        if (disposed) return
        disposed = true
        list.removeEventListener('click', click)
        list.removeEventListener('keydown', keydown)
      },
    })
  },
})
