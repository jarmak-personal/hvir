const { contextBridge, ipcRenderer } = require('electron')
contextBridge.exposeInMainWorld('qualificationObserve', (data) =>
  ipcRenderer.send('qualification:observation', data),
)
