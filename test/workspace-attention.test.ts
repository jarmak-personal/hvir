import { describe, expect, it } from 'vitest'

import {
  aggregateActionableWorkspaceAttention,
  workspaceActionableAttention,
} from '../src/renderer/src/workspaces/workspace-attention'

describe('workspace attention aggregation', () => {
  it('excludes working terminals while retaining actionable children in parent counts', () => {
    const rollups = {
      active: { actionable: 0 },
      inactive: { actionable: 2 },
    }

    expect(workspaceActionableAttention('active', rollups)).toBe(0)
    expect(workspaceActionableAttention('inactive', rollups)).toBe(2)
    expect(workspaceActionableAttention('missing', rollups)).toBe(0)
    expect(
      aggregateActionableWorkspaceAttention(['active', 'inactive', 'missing'], rollups),
    ).toBe(2)
  })
})
