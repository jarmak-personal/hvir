/* global URLSearchParams, location, document, requestAnimationFrame, setTimeout, performance */
const { contextBridge, ipcRenderer, sharedTexture } = require('electron')
const query = new URLSearchParams(location.search)
const session = query.get('session')
const generation = Number(query.get('generation'))
const delayMs = Number(query.get('delay')) || 0
contextBridge.exposeInMainWorld('live', {
  call: (op, ...args) => ipcRenderer.invoke('qualification:live', generation, op, args),
})
let lastSerial = 0
sharedTexture.setSharedTextureReceiver(async ({ importedSharedTexture }, metadata) => {
  let frame
  try {
    if (metadata.session !== session || metadata.generation !== generation)
      throw new Error('Foreign or stale frame reached receiver')
    if (metadata.serial <= lastSerial) throw new Error('Nonmonotonic native frame')
    lastSerial = metadata.serial
    if (delayMs) await new Promise((resolve) => setTimeout(resolve, delayMs))
    frame = importedSharedTexture.getVideoFrame()
    const canvas = document.querySelector('canvas')
    canvas.width = frame.displayWidth
    canvas.height = frame.displayHeight
    canvas.style.width = `${frame.displayWidth / 2}px`
    canvas.style.height = `${frame.displayHeight / 2}px`
    canvas.getContext('2d').drawImage(frame, 0, 0)
    requestAnimationFrame(() =>
      ipcRenderer.send('qualification:live-draw', {
        ...metadata,
        receiverTime: performance.now(),
      }),
    )
  } catch (error) {
    ipcRenderer.send('qualification:live-failure', generation, String(error))
  } finally {
    frame?.close()
    importedSharedTexture.release()
  }
})
let previous = performance.now()
function heartbeat() {
  const now = performance.now()
  ipcRenderer.send('qualification:live-heartbeat', generation, now - previous)
  previous = now
  requestAnimationFrame(heartbeat)
}
requestAnimationFrame(heartbeat)
