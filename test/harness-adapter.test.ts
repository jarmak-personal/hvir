import { describe, expect, it } from 'vitest'

import {
  claudeCodeAdapter,
  codexAdapter,
  harnessAdapter,
  plainShellAdapter,
} from '../src/main/harness/harness-adapter'
import { localPath } from '../src/shared'

const context = {
  sessionId: '3d33e340-b73f-4f3b-885b-cc47a22cb844',
  cwd: localPath('/tmp/project'),
  defaultShell: '/bin/zsh',
}

describe('Harness adapters', () => {
  it('pre-assigns and deterministically resumes Claude Code sessions', () => {
    expect(claudeCodeAdapter.launch(context)).toEqual({
      file: 'claude',
      args: ['--session-id', context.sessionId],
    })
    expect(claudeCodeAdapter.resume(context)).toEqual({
      file: 'claude',
      args: ['--resume', context.sessionId],
    })
    expect(claudeCodeAdapter.supportsResume).toBe(true)
    expect(claudeCodeAdapter.sessionIdentity).toBe('preassigned')
  })

  it('resumes an exactly discovered Codex session id', () => {
    expect(codexAdapter.launch(context)).toEqual({ file: 'codex', args: [] })
    expect(codexAdapter.resume(context)).toEqual({
      file: 'codex',
      args: ['resume', context.sessionId],
    })
    expect(codexAdapter.supportsResume).toBe(true)
    expect(codexAdapter.sessionIdentity).toBe('discovered')
    expect(codexAdapter.sessionDiscovery).toBeDefined()
  })

  it('resolves only registered adapters', () => {
    expect(harnessAdapter('plain-shell')).toBe(plainShellAdapter)
    expect(harnessAdapter('claude-code')).toBe(claudeCodeAdapter)
    expect(harnessAdapter('codex')).toBe(codexAdapter)
    expect(() => harnessAdapter('other')).toThrow(/Unknown harness adapter/)
  })
})
