/* global window, document */
const api = window.live
const canvas = document.querySelector('canvas')
const codes = {
  KeyA: 0,
  KeyS: 1,
  KeyD: 2,
  KeyF: 3,
  KeyH: 4,
  KeyG: 5,
  KeyZ: 6,
  KeyX: 7,
  KeyC: 8,
  KeyV: 9,
  KeyB: 11,
  KeyQ: 12,
  KeyW: 13,
  KeyE: 14,
  KeyR: 15,
  KeyY: 16,
  KeyT: 17,
  Digit1: 18,
  Digit2: 19,
  Digit3: 20,
  Digit4: 21,
  Digit6: 22,
  Digit5: 23,
  Equal: 24,
  Digit9: 25,
  Digit7: 26,
  Minus: 27,
  Digit8: 28,
  Digit0: 29,
  BracketRight: 30,
  KeyO: 31,
  KeyU: 32,
  BracketLeft: 33,
  KeyI: 34,
  KeyP: 35,
  Enter: 36,
  KeyL: 37,
  KeyJ: 38,
  Quote: 39,
  KeyK: 40,
  Semicolon: 41,
  Backslash: 42,
  Comma: 43,
  Slash: 44,
  KeyN: 45,
  KeyM: 46,
  Period: 47,
  Tab: 48,
  Space: 49,
  Backquote: 50,
  Backspace: 51,
  Escape: 53,
  Home: 115,
  PageUp: 116,
  Delete: 117,
  End: 119,
  PageDown: 121,
  ArrowLeft: 123,
  ArrowRight: 124,
  ArrowDown: 125,
  ArrowUp: 126,
}
function call(op, ...args) {
  void api.call(op, ...args).catch((error) => {
    document.title = `Experiment failed: ${String(error)}`
  })
}
canvas.addEventListener('keydown', (event) => {
  if (event.metaKey && event.code === 'KeyV') {
    event.preventDefault()
    call('clipboard-paste')
    return
  }
  if (event.isComposing || !(event.code in codes)) return
  event.preventDefault()
  const mods =
    Number(event.shiftKey) |
    (Number(event.ctrlKey) << 1) |
    (Number(event.altKey) << 2) |
    (Number(event.metaKey) << 3)
  call('key', codes[event.code], mods, event.key.length === 1 ? event.key : '')
})
canvas.addEventListener('paste', (event) => {
  event.preventDefault()
  call('paste', event.clipboardData.getData('text/plain'))
})
canvas.addEventListener(
  'wheel',
  (event) => {
    event.preventDefault()
    call('scroll', -event.deltaX * 2, -event.deltaY * 2)
  },
  { passive: false },
)
for (const [name, pressed] of [
  ['mousedown', true],
  ['mouseup', false],
]) {
  canvas.addEventListener(name, (event) => {
    if (event.button !== 0) return
    const bounds = canvas.getBoundingClientRect()
    call('mouse', event.clientX - bounds.left, event.clientY - bounds.top, pressed)
  })
}
let wide = true
document.querySelector('#resize').onclick = () => {
  wide = !wide
  call('resize', wide ? 100 : 80, 30)
}
document.querySelector('#top').onclick = () => call('binding', 'scroll_to_top')
document.querySelector('#bottom').onclick = () => call('binding', 'scroll_to_bottom')
canvas.focus()
