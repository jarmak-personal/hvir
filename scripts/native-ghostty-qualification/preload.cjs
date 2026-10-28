/* global document, performance, requestAnimationFrame, setTimeout */
const { ipcRenderer, sharedTexture } = require('electron')
let count = 0
let last = 0
let longest = 0
sharedTexture.setSharedTextureReceiver(async ({ importedSharedTexture }, metadata) => {
  const frame = importedSharedTexture.getVideoFrame()
  try {
    const canvas = document.querySelector('canvas')
    if (canvas.width !== frame.displayWidth) canvas.width = frame.displayWidth
    if (canvas.height !== frame.displayHeight) canvas.height = frame.displayHeight
    canvas.getContext('2d').drawImage(frame, 0, 0)
    count++
    const drawnCount = count
    const now = performance.now()
    if (last) longest = Math.max(longest, now - last)
    last = now
    // Deliberately retain the consumer's frame periodically to stress pool exhaustion.
    if (drawnCount >= 180 && drawnCount <= 182)
      await new Promise((resolve) => setTimeout(resolve, 150))
    if (drawnCount % 30 === 0)
      requestAnimationFrame(() =>
        ipcRenderer.send('qualification:observation', {
          event: 'draw-scheduled',
          count: drawnCount,
          longestMs: longest,
          ...metadata,
        }),
      )
  } finally {
    frame.close()
    importedSharedTexture.release()
  }
})
document.addEventListener('DOMContentLoaded', () => {
  document.addEventListener('keydown', (event) => {
    if (event.key.length === 1) ipcRenderer.send('qualification:key', event.key)
    else if (event.key === 'Enter') ipcRenderer.send('qualification:key', '\r\n')
  })
  ipcRenderer.send('qualification:ready')
})
