import { describe, expect, it } from 'vitest'

import {
  aggregateActionableWorkspaceAttention,
  aggregateWorkingWorkspaceTerminals,
  workspaceActionableAttention,
  workspaceWorkingTerminals,
} from '../src/renderer/src/workspaces/workspace-attention'

describe('workspace attention aggregation', () => {
  it('excludes working terminals while retaining actionable children in parent counts', () => {
    const rollups = {
      active: { actionable: 0, working: 1 },
      inactive: { actionable: 2, working: 3 },
    }

    expect(workspaceActionableAttention('active', rollups)).toBe(0)
    expect(workspaceActionableAttention('inactive', rollups)).toBe(2)
    expect(workspaceActionableAttention('missing', rollups)).toBe(0)
    expect(
      aggregateActionableWorkspaceAttention(['active', 'inactive', 'missing'], rollups),
    ).toBe(2)
    expect(workspaceWorkingTerminals('active', rollups)).toBe(1)
    expect(workspaceWorkingTerminals('inactive', rollups)).toBe(3)
    expect(workspaceWorkingTerminals('missing', rollups)).toBe(0)
    expect(
      aggregateWorkingWorkspaceTerminals(['active', 'inactive', 'missing'], rollups),
    ).toBe(4)
  })
})
