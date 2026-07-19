import { describe, expect, it } from 'vitest'

import { workbenchWindowOptions } from '../src/main/window/window-policy'

describe('workbench window policy', () => {
  it('keeps every BrowserWindow isolated behind the preload bridge', () => {
    const options = workbenchWindowOptions('/application/preload.js')

    expect(options.show).toBe(false)
    expect(options.webPreferences).toEqual({
      preload: '/application/preload.js',
      sandbox: true,
      contextIsolation: true,
      nodeIntegration: false,
      webviewTag: true,
    })
  })
})
