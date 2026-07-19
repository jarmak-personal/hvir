import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'

import { HarnessProfilesSettings } from '../src/renderer/src/settings/HarnessProfilesSettings'
import { localPath } from '../src/shared'

describe('HarnessProfilesSettings', () => {
  it('waits for providers before opening the add-harness dialog', () => {
    // Effects do not run during SSR, so the provider catalog remains at its initial [] state.
    const markup = renderToStaticMarkup(
      createElement(HarnessProfilesSettings, {
        workspaceRoot: localPath('/tmp/hvir'),
        projectRoot: localPath('/tmp/hvir'),
        initialAddOpen: true,
      }),
    )

    expect(markup).toContain('Add a harness')
    expect(markup).not.toContain('add-harness-dialog')
  })
})
