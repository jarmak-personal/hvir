import { describe, expect, it } from 'vitest'

import {
  claudeCodeProvider,
  codexProvider,
  harnessProvider,
  harnessProviderCatalog,
  HarnessProviderRegistry,
  plainShellProvider,
  type HarnessProvider,
} from '../src/main/harness/harness-provider'
import { asHarnessProviderId, localPath } from '../src/shared'

const context = {
  sessionId: '3d33e340-b73f-4f3b-885b-cc47a22cb844',
  cwd: localPath('/tmp/project'),
  defaultShell: '/bin/zsh',
}

describe('Harness providers', () => {
  it('pre-assigns and deterministically resumes Claude Code sessions', () => {
    expect(claudeCodeProvider.launch(context)).toEqual({
      file: 'claude',
      args: ['--session-id', context.sessionId],
      shellEnvironment: true,
    })
    expect(claudeCodeProvider.resume(context)).toEqual({
      file: 'claude',
      args: ['--resume', context.sessionId],
      shellEnvironment: true,
    })
    expect(claudeCodeProvider.supportsResume).toBe(true)
    expect(claudeCodeProvider.sessionIdentity).toBe('preassigned')
    expect(claudeCodeProvider.telemetry).toBeDefined()
  })

  it('resumes an exactly discovered Codex session id', () => {
    expect(codexProvider.launch(context)).toEqual({
      file: 'codex',
      args: ['--config', 'tui.terminal_title=["thread-title"]'],
      shellEnvironment: true,
    })
    expect(codexProvider.resume(context)).toEqual({
      file: 'codex',
      args: [
        '--config',
        'tui.terminal_title=["thread-title"]',
        'resume',
        context.sessionId,
      ],
      shellEnvironment: true,
    })
    expect(codexProvider.supportsResume).toBe(true)
    expect(codexProvider.sessionIdentity).toBe('discovered')
    expect(codexProvider.sessionDiscovery).toBeDefined()
  })

  it('resolves only registered providers and emits their serializable catalog', () => {
    expect(harnessProvider('plain-shell')).toBe(plainShellProvider)
    expect(harnessProvider('claude-code')).toBe(claudeCodeProvider)
    expect(harnessProvider('codex')).toBe(codexProvider)
    expect(() => harnessProvider('other')).toThrow(/Unknown harness provider/)
    expect(harnessProviderCatalog()).toEqual([
      {
        id: 'plain-shell',
        displayName: 'Shell',
        default: true,
        capabilities: {
          sessionIdentity: 'none',
          exactResume: false,
          contextPresentation: 'none',
        },
      },
      {
        id: 'claude-code',
        displayName: 'Claude Code',
        default: false,
        capabilities: {
          sessionIdentity: 'preassigned',
          exactResume: true,
          contextPresentation: 'count',
        },
      },
      {
        id: 'codex',
        displayName: 'Codex',
        default: false,
        capabilities: {
          sessionIdentity: 'discovered',
          exactResume: true,
          contextPresentation: 'pressure',
        },
      },
    ])
  })

  it('rejects duplicate ids and invalid discovered-provider contracts', () => {
    const base: HarnessProvider = {
      manifest: {
        id: asHarnessProviderId('test-provider'),
        displayName: 'Test',
        default: true,
        contextPresentation: 'none',
      },
      supportsResume: false,
      sessionIdentity: 'none',
      launch: () => ({ file: 'test', args: [] }),
      resume: () => ({ file: 'test', args: [] }),
    }
    expect(() => new HarnessProviderRegistry([base, base])).toThrow(/Duplicate/)
    expect(
      () => new HarnessProviderRegistry([{ ...base, sessionIdentity: 'discovered' }]),
    ).toThrow(/missing session discovery/)
    expect(() => asHarnessProviderId('../escape')).toThrow(/Invalid harness provider id/)
    expect(() => asHarnessProviderId('UPPERCASE')).toThrow(/Invalid harness provider id/)
  })
})
