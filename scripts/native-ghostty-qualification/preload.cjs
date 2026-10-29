/* global document, requestAnimationFrame */
const { contextBridge, ipcRenderer, sharedTexture } = require('electron')
let onFrame = () => undefined
contextBridge.exposeInMainWorld('qualification', {
  call: (op, ...args) => ipcRenderer.invoke('qualification:call', op, args),
  observe: (data) => ipcRenderer.send('qualification:observe', data),
  onFrame: (callback) => {
    onFrame = callback
  },
})
sharedTexture.setSharedTextureReceiver(async ({ importedSharedTexture }, metadata) => {
  const frame = importedSharedTexture.getVideoFrame()
  try {
    const canvas = document.querySelector('#native')
    if (canvas.width !== frame.displayWidth) canvas.width = frame.displayWidth
    if (canvas.height !== frame.displayHeight) canvas.height = frame.displayHeight
    canvas.style.width = `${frame.displayWidth / 2}px`
    canvas.style.height = `${frame.displayHeight / 2}px`
    canvas.getContext('2d').drawImage(frame, 0, 0)
    requestAnimationFrame(() => {
      ipcRenderer.send('qualification:draw', metadata)
      onFrame(metadata)
    })
  } finally {
    frame.close()
    importedSharedTexture.release()
  }
})
