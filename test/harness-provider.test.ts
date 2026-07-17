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
    const catalog = harnessProviderCatalog()
    expect(catalog.map(({ id, displayName }) => ({ id, displayName }))).toEqual([
      { id: 'plain-shell', displayName: 'Shell' },
      { id: 'claude-code', displayName: 'Claude Code' },
      { id: 'codex', displayName: 'Codex' },
      { id: 'pi', displayName: 'Pi' },
      { id: 'gemini-cli', displayName: 'Gemini CLI' },
      { id: 'github-copilot-cli', displayName: 'GitHub Copilot CLI' },
      { id: 'cursor-cli', displayName: 'Cursor CLI' },
      { id: 'custom', displayName: 'Custom' },
    ])
    expect(catalog.find(({ id }) => id === 'plain-shell')?.default).toBe(true)
    expect(catalog.find(({ id }) => id === 'claude-code')?.profileTemplate).toEqual({
      displayName: 'Claude Code',
      description: 'Claude Code with exact hvir-managed session recovery.',
    })
    expect(catalog.find(({ id }) => id === 'custom')?.profileTemplate).toBeUndefined()
    expect(catalog.find(({ id }) => id === 'claude-code')?.capabilities).toEqual({
      sessionIdentity: 'preassigned',
      exactResume: true,
      contextPresentation: 'count',
    })
    expect(catalog.find(({ id }) => id === 'codex')?.capabilities).toEqual({
      sessionIdentity: 'discovered',
      exactResume: true,
      contextPresentation: 'pressure',
    })
    expect(
      catalog.every(
        ({ profileGuidance }) => profileGuidance.riskClassification === 'best-effort',
      ),
    ).toBe(true)
  })

  it('ships Pi, Gemini, Copilot, and Cursor as truthful launch-only providers', () => {
    const actual = ['pi', 'gemini-cli', 'github-copilot-cli', 'cursor-cli'].map((id) => {
      const provider = harnessProvider(id)
      expect(provider.sessionIdentity).toBe('none')
      expect(provider.supportsResume).toBe(false)
      expect(provider.telemetry).toBeUndefined()
      return [id, provider.launch(context).file]
    })
    expect(actual).toEqual([
      ['pi', 'pi'],
      ['gemini-cli', 'gemini'],
      ['github-copilot-cli', 'copilot'],
      ['cursor-cli', 'cursor-agent'],
    ])
  })

  it('keeps Copilot launch-only even when caller capabilities claim more', () => {
    const provider = harnessProvider('github-copilot-cli')
    expect(provider.launch(context).args).toEqual([])
    expect(
      provider.launch({
        ...context,
        effectiveCapabilities: {
          sessionIdentity: 'preassigned',
          exactResume: true,
          contextPresentation: 'none',
        },
      }).args,
    ).toEqual([])
    expect(
      provider.resume({
        ...context,
        effectiveCapabilities: {
          sessionIdentity: 'preassigned',
          exactResume: true,
          contextPresentation: 'none',
        },
      }).args,
    ).toEqual([])
  })

  it('rejects duplicate ids and invalid discovered-provider contracts', () => {
    const base: HarnessProvider = {
      manifest: {
        id: asHarnessProviderId('test-provider'),
        displayName: 'Test',
        default: true,
        contextPresentation: 'none',
      },
      profile: {
        version: 1,
        reservedArguments: [],
        reservedEnvironmentKeys: [],
        artifactEnvironmentKeys: [],
        artifactExecutable: false,
        artifactPathBindings: [],
        applyArgs: (_mode, providerArgs, profileArgs) => [
          ...providerArgs,
          ...profileArgs,
        ],
        classifyRisk: () => 'standard',
      },
      supportsResume: false,
      sessionIdentity: 'none',
      probe: {
        parseVersion: () => undefined,
        effectiveCapabilities: () => ({
          sessionIdentity: 'none',
          exactResume: false,
          contextPresentation: 'none',
        }),
      },
      launch: () => ({ file: 'test', args: [] }),
      resume: () => ({ file: 'test', args: [] }),
    }
    expect(() => new HarnessProviderRegistry([base, base])).toThrow(/Duplicate/)
    expect(
      () => new HarnessProviderRegistry([{ ...base, sessionIdentity: 'discovered' }]),
    ).toThrow(/missing session discovery/)
    expect(
      () =>
        new HarnessProviderRegistry([
          {
            ...base,
            profile: {
              ...base.profile,
              reservedEnvironmentKeys: ['TEST_HOME'],
            },
            telemetry: { observe: () => () => undefined },
          },
        ]),
    ).toThrow(/without artifact semantics/)
    expect(() => asHarnessProviderId('../escape')).toThrow(/Invalid harness provider id/)
    expect(() => asHarnessProviderId('UPPERCASE')).toThrow(/Invalid harness provider id/)
  })
})
