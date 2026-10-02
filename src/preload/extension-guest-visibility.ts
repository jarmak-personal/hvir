/** Native widget visibility, captured in the isolated world before package scripts. */
export function observeExtensionGuestVisibility(publish: () => void): void {
  // Electron shadows document.visibilityState with the embedder window's state.
  // Chromium's prototype getter still reports this guest's actual native state.
  const visibility = Object.getOwnPropertyDescriptor(
    Document.prototype,
    'visibilityState',
  )?.get?.bind(document)
  if (!visibility) throw new Error('Extension native visibility is unavailable')
  window.addEventListener(
    'visibilitychange',
    (event) => {
      // Electron's compatibility notification and package-dispatched events are
      // untrusted. Our own freeze produces native hidden, not an invalidation.
      if (event.isTrusted && visibility() === 'visible') publish()
    },
    true,
  )
}
