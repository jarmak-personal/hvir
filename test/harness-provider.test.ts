import { describe, expect, it } from 'vitest'

import {
  claudeCodeProvider,
  codexProvider,
  harnessLaunchCapabilities,
  harnessProvider,
  harnessProviderCatalog,
  harnessProviders,
  plainShellProvider,
  type HarnessProvider,
} from '../src/main/harness/harness-provider'
import { HarnessProviderRegistry } from '../src/main/harness/harness-provider-registry'
import { providerTemplateProfiles } from '../src/main/harness/harness-profile-store'
import { asHarnessProviderId, asHostId, hostPath, localPath } from '../src/shared'

const context = {
  sessionId: '3d33e340-b73f-4f3b-885b-cc47a22cb844',
  cwd: localPath('/tmp/project'),
  defaultShell: '/bin/zsh',
}
const forkContext = { ...context, parentSessionId: 'parent-session-id' }

describe('Harness providers', () => {
  it('launches and recreates Bare Shell as the host login shell', () => {
    const expected = { file: context.defaultShell, args: ['-l'] }
    expect(plainShellProvider.launch(context)).toEqual(expected)
    expect(plainShellProvider.resume(context)).toEqual(expected)
  })

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
    expect(claudeCodeProvider.usageTelemetry).toBeDefined()
  })

  it('forks Claude Code with exact preassigned parent and child identities', () => {
    expect(claudeCodeProvider.fork?.(forkContext)).toEqual({
      file: 'claude',
      args: [
        '--session-id',
        context.sessionId,
        '--resume',
        'parent-session-id',
        '--fork-session',
      ],
      shellEnvironment: true,
    })
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
    expect(codexProvider.usageTelemetry).toBeDefined()
  })

  it('forks Codex from an exact parent and leaves child discovery unchanged', () => {
    expect(codexProvider.fork?.(forkContext)).toEqual({
      file: 'codex',
      args: [
        '--config',
        'tui.terminal_title=["thread-title"]',
        'fork',
        'parent-session-id',
      ],
      shellEnvironment: true,
    })
    expect(codexProvider.sessionDiscovery).toBeDefined()
  })

  it('derives exact-fork capability only from supported probed versions', () => {
    expect(claudeCodeProvider.probe.effectiveCapabilities('2.1.258')).toMatchObject({
      exactFork: true,
    })
    expect(codexProvider.probe.effectiveCapabilities('codex-cli 0.151.0')).toMatchObject({
      exactFork: true,
    })
    for (const capabilities of [
      claudeCodeProvider.probe.effectiveCapabilities('2.1.257'),
      claudeCodeProvider.probe.effectiveCapabilities(undefined),
      codexProvider.probe.effectiveCapabilities('codex-cli 0.150.9'),
      codexProvider.probe.effectiveCapabilities(undefined),
      plainShellProvider.probe.effectiveCapabilities(undefined),
    ]) {
      expect(capabilities).not.toHaveProperty('exactFork')
    }
  })

  it('lets Codex own intentional-submit behavior inside its composer', () => {
    const intentional = { ...context, composerSubmitMode: 'ctrl-enter' as const }
    expect(codexProvider.launch(intentional).args).toEqual([
      '--config',
      'tui.terminal_title=["thread-title"]',
      '--config',
      'tui.keymap.composer.submit=["ctrl-enter"]',
    ])
    expect(codexProvider.resume(intentional).args).toEqual([
      '--config',
      'tui.terminal_title=["thread-title"]',
      '--config',
      'tui.keymap.composer.submit=["ctrl-enter"]',
      'resume',
      context.sessionId,
    ])
  })

  it('limits remote path image paste to the evidenced native composers', () => {
    const path = hostPath(
      asHostId('ssh-test'),
      '/run/user/501/hvir/image-paste/paste.abc/image.png',
    )
    const expected =
      '\x1b[200~/run/user/501/hvir/image-paste/paste.abc/image.png\x1b[201~'
    expect(claudeCodeProvider.remoteImagePaste?.revision).toBe(1)
    expect(claudeCodeProvider.remoteImagePaste?.terminalInput(path)).toBe(expected)
    expect(codexProvider.remoteImagePaste?.terminalInput(path)).toBe(expected)
    expect(() =>
      codexProvider.remoteImagePaste?.terminalInput(
        hostPath(asHostId('ssh-test'), '/tmp/hvir path/image.png'),
      ),
    ).toThrow(/safe absolute path/)
    expect(
      [
        'plain-shell',
        'pi',
        'gemini-cli',
        'github-copilot-cli',
        'cursor-cli',
        'custom',
      ].every((id) => harnessProvider(id).remoteImagePaste === undefined),
    ).toBe(true)
  })

  it('owns the complete initial document-review insertion matrix and exact framing', () => {
    const body = 'docs/review.md:2\nQuote:\nline\nComment:\nkeep this exact'
    const expected = `\x1b[200~${body}\x1b[201~`
    expect(claudeCodeProvider.documentReviewInsert).toMatchObject({ revision: 1 })
    expect(claudeCodeProvider.documentReviewInsert?.terminalInput(body)).toBe(expected)
    expect(codexProvider.documentReviewInsert?.terminalInput(body)).toBe(expected)
    for (const provider of [claudeCodeProvider, codexProvider]) {
      expect(
        provider.probe.effectiveCapabilities('1.0').reviewInsertContractRevision,
      ).toBe(provider.documentReviewInsert?.revision)
    }
    expect(() =>
      codexProvider.documentReviewInsert?.terminalInput('unsafe\u001btext'),
    ).toThrow(/safe human-readable text/)
    expect(
      harnessProviders
        .all()
        .map(({ manifest, documentReviewInsert }) => [
          manifest.id,
          documentReviewInsert?.revision,
        ]),
    ).toEqual([
      ['plain-shell', undefined],
      ['claude-code', 1],
      ['codex', 1],
      ['pi', undefined],
      ['gemini-cli', undefined],
      ['github-copilot-cli', undefined],
      ['cursor-cli', undefined],
      ['custom', undefined],
    ])
  })

  it('exposes Codex-only send-now for an exact probed launch in both submit modes', () => {
    const profile = providerTemplateProfiles().find(
      (candidate) => candidate.providerId === codexProvider.manifest.id,
    )!
    const probed = codexProvider.probe.effectiveCapabilities('codex-cli 0.146.0')
    const enter = harnessLaunchCapabilities(codexProvider, {
      profile,
      composerSubmitMode: 'enter',
      probedCapabilities: probed,
    })
    const control = harnessLaunchCapabilities(codexProvider, {
      profile,
      composerSubmitMode: 'ctrl-enter',
      probedCapabilities: probed,
    })
    const body = 'docs/review.md:2\nQuote:\nline one\nline two\nComment:\nExact.'
    const paste = `\x1b[200~${body}\x1b[201~`

    expect(enter).toMatchObject({
      reviewInsertContractRevision: 1,
      reviewSendNowContractRevision: 1,
    })
    expect(control).toEqual(enter)
    expect(
      codexProvider.documentReviewSendNow?.terminalInput(body, {
        profile,
        composerSubmitMode: 'enter',
        effectiveCapabilities: enter,
      }),
    ).toBe(`${paste}\r`)
    expect(
      codexProvider.documentReviewSendNow?.terminalInput(body, {
        profile,
        composerSubmitMode: 'ctrl-enter',
        effectiveCapabilities: control,
      }),
    ).toBe(`${paste}\x1b[13;5u`)
  })

  it('attempts Codex handoff for an exact provider-default launch despite profile customization', () => {
    const profile = providerTemplateProfiles().find(
      (candidate) => candidate.providerId === codexProvider.manifest.id,
    )!
    const customizedProfile = {
      ...profile,
      args: [
        { parts: [{ kind: 'literal' as const, value: '--config' }] },
        {
          parts: [
            {
              kind: 'literal' as const,
              value: 'tui.notifications=false',
            },
          ],
        },
      ],
      environment: [{ kind: 'literal' as const, name: 'REVIEW_MODE', value: '1' }],
      pathBindings: [{ name: 'project', path: localPath('/tmp/project') }],
    }
    const capabilities = harnessLaunchCapabilities(codexProvider, {
      profile: customizedProfile,
      composerSubmitMode: 'ctrl-enter',
      probedCapabilities: codexProvider.probe.effectiveCapabilities('codex-cli 0.146.0'),
    })

    expect(capabilities).toMatchObject({
      reviewInsertContractRevision: 1,
      reviewSendNowContractRevision: 1,
    })
  })

  it('keeps unsupported and unprobed Codex versions below send-now', () => {
    const profile = providerTemplateProfiles().find(
      (candidate) => candidate.providerId === codexProvider.manifest.id,
    )!
    const unsupported = codexProvider.probe.effectiveCapabilities('codex-cli 0.145.9')
    const unprobed = codexProvider.probe.effectiveCapabilities(undefined)
    const supported = codexProvider.probe.effectiveCapabilities('codex-cli 0.146.0')
    for (const probedCapabilities of [unsupported, unprobed]) {
      const capabilities = harnessLaunchCapabilities(codexProvider, {
        profile,
        composerSubmitMode: 'enter',
        probedCapabilities,
      })
      expect(capabilities.reviewInsertContractRevision).toBe(1)
      expect(capabilities).not.toHaveProperty('reviewSendNowContractRevision')
    }
    expect(supported.reviewSendNowContractRevision).toBe(1)
  })

  it('keeps unapproved provider launch changes Copy-only', () => {
    const profiles = providerTemplateProfiles()
    for (const provider of [claudeCodeProvider, codexProvider]) {
      const profile = profiles.find(
        (candidate) => candidate.providerId === provider.manifest.id,
      )!
      const probedCapabilities = provider.probe.effectiveCapabilities(
        provider === codexProvider ? 'codex-cli 0.146.0' : '1.0.0',
      )
      const exact = harnessLaunchCapabilities(provider, {
        profile,
        composerSubmitMode: 'enter',
        probedCapabilities,
      })
      expect(exact.reviewInsertContractRevision).toBe(
        provider.documentReviewInsert?.revision,
      )
      expect(harnessLaunchCapabilities(provider)).not.toHaveProperty(
        'reviewInsertContractRevision',
      )

      const disqualifiedProfiles = [
        { ...profile, providerId: asHarnessProviderId('other') },
        { ...profile, providerContractVersion: profile.providerContractVersion + 1 },
        {
          ...profile,
          executable: { kind: 'command' as const, command: provider.manifest.id },
        },
        {
          ...profile,
          executable: {
            kind: 'path' as const,
            path: localPath(`/usr/local/bin/${provider.manifest.id}`),
          },
        },
      ]
      for (const disqualifiedProfile of disqualifiedProfiles) {
        const capabilities = harnessLaunchCapabilities(provider, {
          profile: disqualifiedProfile,
          composerSubmitMode: 'enter',
          probedCapabilities,
        })
        expect(capabilities).not.toHaveProperty('reviewInsertContractRevision')
        expect(capabilities).not.toHaveProperty('reviewSendNowContractRevision')
      }
      const customizedProfile = {
        ...profile,
        args: [{ parts: [{ kind: 'literal' as const, value: '--custom' }] }],
        environment: [{ kind: 'literal' as const, name: 'HVIR_TEST', value: '1' }],
        pathBindings: [{ name: 'project', path: localPath('/tmp/project') }],
      }
      const customized = harnessLaunchCapabilities(provider, {
        profile: customizedProfile,
        composerSubmitMode: 'enter',
        probedCapabilities,
      })
      if (provider === codexProvider) {
        expect(customized.reviewInsertContractRevision).toBe(1)
        expect(customized.reviewSendNowContractRevision).toBe(1)
      } else {
        expect(customized).not.toHaveProperty('reviewInsertContractRevision')
        expect(customized).not.toHaveProperty('reviewSendNowContractRevision')
      }
    }
  })

  it('reports send-now, insert-only, and copy-only across bundled providers', () => {
    const profiles = providerTemplateProfiles()
    expect(
      harnessProviders.all().map((provider) => {
        const profile = profiles.find(
          (candidate) => candidate.providerId === provider.manifest.id,
        )
        const probed = provider.probe.effectiveCapabilities(
          provider === codexProvider ? 'codex-cli 0.146.0' : '1.0.0',
        )
        const capabilities = profile
          ? harnessLaunchCapabilities(provider, {
              profile,
              composerSubmitMode: 'ctrl-enter',
              probedCapabilities: probed,
            })
          : harnessLaunchCapabilities(provider)
        return [
          provider.manifest.id,
          capabilities.reviewSendNowContractRevision
            ? 'send-now'
            : capabilities.reviewInsertContractRevision
              ? 'insert'
              : 'copy-only',
        ]
      }),
    ).toEqual([
      ['plain-shell', 'copy-only'],
      ['claude-code', 'insert'],
      ['codex', 'send-now'],
      ['pi', 'copy-only'],
      ['gemini-cli', 'copy-only'],
      ['github-copilot-cli', 'copy-only'],
      ['cursor-cli', 'copy-only'],
      ['custom', 'copy-only'],
    ])
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
      contextPresentation: 'pressure',
      contextPressure: {
        assumedWindowTokens: 1_000_000,
        warningPercent: 20,
        criticalPercent: 40,
      },
    })
    expect(catalog.find(({ id }) => id === 'codex')?.capabilities).toEqual({
      sessionIdentity: 'discovered',
      exactResume: true,
      contextPresentation: 'pressure',
    })
    expect(catalog.find(({ id }) => id === 'plain-shell')?.terminalInput).toEqual({
      modifiedKeyProtocol: 'none',
      metaEnterAliasesControl: false,
    })
    expect(catalog.find(({ id }) => id === 'claude-code')?.terminalInput).toEqual({
      modifiedKeyProtocol: 'modify-other-keys',
      metaEnterAliasesControl: true,
    })
    expect(catalog.find(({ id }) => id === 'codex')?.terminalInput).toEqual({
      modifiedKeyProtocol: 'csi-u',
      metaEnterAliasesControl: true,
    })
    expect(
      catalog.every(({ profileGuidance }) => !('riskClassification' in profileGuidance)),
    ).toBe(true)
  })

  it('ships Pi, Gemini, Copilot, and Cursor as truthful launch-only providers', () => {
    const actual = ['pi', 'gemini-cli', 'github-copilot-cli', 'cursor-cli'].map((id) => {
      const provider = harnessProvider(id)
      expect(provider.sessionIdentity).toBe('none')
      expect(provider.supportsResume).toBe(false)
      expect(provider.telemetry).toBeUndefined()
      expect(provider.usageTelemetry).toBeUndefined()
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
        sessionKind: 'agent',
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
    expect(() => new HarnessProviderRegistry([])).toThrow(/exactly one default/)
    expect(
      () =>
        new HarnessProviderRegistry([
          { ...base, manifest: { ...base.manifest, default: false } },
        ]),
    ).toThrow(/exactly one default/)
    expect(
      () =>
        new HarnessProviderRegistry([
          base,
          { ...base, manifest: { ...base.manifest, id: asHarnessProviderId('second') } },
        ]),
    ).toThrow(/exactly one default/)
    expect(
      () =>
        new HarnessProviderRegistry([
          { ...base, manifest: { ...base.manifest, displayName: ' ' } },
        ]),
    ).toThrow(/Invalid display name/)
    expect(
      () =>
        new HarnessProviderRegistry([
          {
            ...base,
            sessionDiscovery: {
              snapshot: () => Promise.resolve(undefined),
              identify: () => Promise.resolve({ status: 'unavailable' }),
            },
          },
        ]),
    ).toThrow(/unexpected session discovery/)
    expect(
      () =>
        new HarnessProviderRegistry([
          {
            ...base,
            resumeValidation: { availability: () => Promise.resolve('missing') },
          },
        ]),
    ).toThrow(/validates resume without supporting it/)
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
