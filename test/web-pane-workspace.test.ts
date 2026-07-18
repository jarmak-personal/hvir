import { describe, expect, it } from 'vitest'

import { sanitizedWebPaneTitle } from '../src/renderer/src/dashboards/web-pane-workspace-policy'

describe('web pane workspace policy', () => {
  it('keeps guest titles bounded and safe for workbench chrome', () => {
    expect(sanitizedWebPaneTitle('\u0000  Local app \u007f')).toBe('Local app')
    expect(sanitizedWebPaneTitle('')).toBe('Web pane')
    expect(sanitizedWebPaneTitle('x'.repeat(140))).toHaveLength(120)
  })
})
