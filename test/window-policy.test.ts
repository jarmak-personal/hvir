import { describe, expect, it } from 'vitest'

import {
  ownsUnresponsiveRecovery,
  workbenchWindowOptions,
} from '../src/main/window/window-policy'

describe('workbench window policy', () => {
  it('keeps every BrowserWindow isolated behind the preload bridge', () => {
    const options = workbenchWindowOptions('/application/preload.js')

    expect(options).toMatchObject({
      width: 1280,
      height: 800,
      useContentSize: true,
    })
    expect(options.show).toBe(false)
    expect(options.webPreferences).toEqual({
      preload: '/application/preload.js',
      sandbox: true,
      contextIsolation: true,
      nodeIntegration: false,
      webviewTag: true,
    })
  })

  it('keeps unresponsive recovery with the exact renderer generation', () => {
    expect(
      ownsUnresponsiveRecovery({ id: 7, generation: 3 }, { id: 7, generation: 3 }),
    ).toBe(true)
    expect(
      ownsUnresponsiveRecovery({ id: 7, generation: 4 }, { id: 7, generation: 3 }),
    ).toBe(false)
    expect(
      ownsUnresponsiveRecovery({ id: 8, generation: 3 }, { id: 7, generation: 3 }),
    ).toBe(false)
  })
})
