import { describe, expect, it } from 'vitest'

import { aggregateWorkspaceAttention } from '../src/renderer/src/workspaces/workspace-attention'

describe('workspace attention aggregation', () => {
  it('includes active and inactive workspace children without clearing either', () => {
    expect(
      aggregateWorkspaceAttention(['active', 'inactive', 'missing'], {
        active: { unseen: 1, actionable: 0 },
        inactive: { unseen: 2, actionable: 2 },
      }),
    ).toEqual({ unseen: 3, actionable: 2 })
  })
})
