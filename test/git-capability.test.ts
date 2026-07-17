import { describe, expect, it } from 'vitest'

import { workspaceGitEnabled } from '../src/renderer/src/git/git-capability'

describe('workspaceGitEnabled', () => {
  it('mounts Git work only for present repositories', () => {
    expect(workspaceGitEnabled(undefined)).toBe(false)
    expect(workspaceGitEnabled({ repository: false, missing: false })).toBe(false)
    expect(workspaceGitEnabled({ repository: true, missing: true })).toBe(false)
    expect(workspaceGitEnabled({ repository: true, missing: false })).toBe(true)
  })
})
