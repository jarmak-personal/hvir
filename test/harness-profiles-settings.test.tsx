import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'

import { HarnessProfilesSettings } from '../src/renderer/src/settings/HarnessProfilesSettings'
import { localPath } from '../src/shared'

describe('HarnessProfilesSettings', () => {
  it('opens to add-harness without crashing before providers load', () => {
    // `initialAddOpen` mounts the add dialog on first render, but the provider
    // catalog loads in an effect that has not run yet — so `providers` is still
    // empty. The dialog must not mount against an empty list (it would read
    // `providers[0]!.id` and throw "cannot read properties of undefined").
    const markup = renderToStaticMarkup(
      createElement(HarnessProfilesSettings, {
        workspaceRoot: localPath('/tmp/hvir'),
        projectRoot: localPath('/tmp/hvir'),
        initialAddOpen: true,
      }),
    )
    // The trigger renders (disabled), but the dialog itself is gated off until
    // providers exist.
    expect(markup).toContain('Add a harness')
    expect(markup).not.toContain('add-harness-dialog')
  })
})
