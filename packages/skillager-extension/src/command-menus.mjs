/** Package-local command disclosures share the guest client's listener lifetime. */
export function bindCommandMenus(document, signal) {
  for (const menu of document.querySelectorAll('details.skill-more')) {
    menu.addEventListener(
      'click',
      (event) => {
        const button = event.target.closest('button')
        if (!button || button.disabled || !button.closest('.skill-menu')) return
        menu.open = false
        menu.querySelector(':scope > summary').focus()
      },
      { capture: true, signal },
    )
    menu.addEventListener(
      'keydown',
      (event) => {
        if (event.key !== 'Escape' || !menu.open) return
        event.preventDefault()
        event.stopPropagation()
        menu.open = false
        menu.querySelector(':scope > summary').focus()
      },
      { signal },
    )
  }
}
