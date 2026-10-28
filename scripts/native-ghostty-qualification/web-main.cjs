/* global __dirname, process, console, setTimeout, clearTimeout */
// Isolated baseline using hvir's exact installed ghostty-web artifact, not the full workbench.
const { app, BrowserWindow, ipcMain } = require('electron')
const { join } = require('node:path')
const { writeFileSync } = require('node:fs')
let window
let deadline
const observations = []
ipcMain.on('qualification:observation', (_event, data) => {
  observations.push(data)
  console.log(JSON.stringify(data))
  if (data.event === 'web-complete' || data.event === 'web-failure') {
    clearTimeout(deadline)
    if (data.event === 'web-failure') process.exitCode = 1
    if (process.env.HVIR_QUALIFICATION_LOG)
      writeFileSync(
        process.env.HVIR_QUALIFICATION_LOG,
        JSON.stringify(observations, null, 2),
      )
    window.destroy()
    app.quit()
  }
})
app.on('window-all-closed', () => app.quit())
app.whenReady().then(async () => {
  window = new BrowserWindow({
    width: 1000,
    height: 680,
    webPreferences: {
      preload: join(__dirname, 'web-preload.cjs'),
      sandbox: true,
      contextIsolation: true,
      nodeIntegration: false,
    },
  })
  deadline = setTimeout(() => {
    process.exitCode = 1
    window.destroy()
    app.quit()
  }, 25000)
  await window.loadFile(join(__dirname, 'web.html'))
})
