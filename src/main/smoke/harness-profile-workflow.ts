import type { BrowserWindow } from 'electron'
import { localPath, type HostPath } from '../../shared'
import type { ProjectHost } from '../project-host'
import {
  verifyCompactHarnessSettings,
  verifyHarnessManualProfilePointerActivation,
} from './harness-settings-layout'
import { captureHarnessSettingsVisuals } from './harness-settings-visual'

export async function verifyStructuredProfiles(
  win: BrowserWindow,
  smokeRoot: HostPath,
): Promise<void> {
  const profileSmoke = (await win.webContents.executeJavaScript(`
      (async () => {
        const root = ${JSON.stringify(smokeRoot)};
        const defaults = await window.hvir.invoke('harness:profiles', { root });
        const catalog = await window.hvir.invoke('harness:catalog', undefined);
        const requestedProviderIds = catalog
          .filter((provider) => provider.profileTemplate && !provider.default)
          .slice(0, 2)
          .map((provider) => provider.id);
        const customProviderId = catalog.find(
          (provider) => !provider.profileTemplate
        )?.id;
        if (!customProviderId) throw new Error('Custom provider was missing');
        const materialized = await window.hvir.invoke('harness:profile-materialize', {
          root,
          providerIds: [...requestedProviderIds].reverse()
        });
        const grant = await window.hvir.invoke('harness:authorize-path', {
          root,
          path: root
        });
        const profile = await window.hvir.invoke('harness:profile-save', {
          root,
          input: {
            displayName: 'Smoke custom harness',
            providerId: customProviderId,
            scope: { kind: 'project', projectRoot: root },
            executable: { kind: 'command', command: 'sh' },
            args: [
              { parts: [{ kind: 'literal', value: '-c' }] },
              { parts: [{ kind: 'literal', value: 'printf hvir-profile-smoke; exec /bin/sh' }] },
              { parts: [{ kind: 'path', source: 'binding', binding: 'workspace' }] }
            ],
            environment: [
              { kind: 'literal', name: 'HVIR_PROFILE_SMOKE', value: 'structured' }
            ],
            pathBindings: [
              { name: 'workspace', path: grant.path, grantId: grant.id }
            ],
            order: 20
          }
        });
        const preview = await window.hvir.invoke('harness:preview', {
          root,
          cwd: root,
          mode: 'fresh',
          profileId: profile.id,
          launchRevision: profile.launchRevision
        });
        return {
          defaultIds: defaults.map((candidate) => candidate.id),
          requestedProviderIds,
          materialized: materialized.map((candidate) => ({
            id: candidate.id,
            providerId: candidate.providerId,
            builtIn: candidate.builtIn,
            scope: candidate.scope.kind
          })),
          profile,
          preview,
          obsoleteRiskState:
            'risk' in profile ||
            'riskAcknowledgedRevision' in profile ||
            'risk' in preview
        };
      })()
    `)) as {
    defaultIds: readonly string[]
    requestedProviderIds: readonly string[]
    materialized: readonly {
      id: string
      providerId: string
      builtIn: boolean
      scope: string
    }[]
    profile: {
      id: string
      launchRevision: number
    }
    preview: { args: readonly string[]; command: string }
    obsoleteRiskState: boolean
  }
  if (
    profileSmoke.defaultIds.join(',') !== 'plain-shell-default' ||
    profileSmoke.materialized.map(({ providerId }) => providerId).join(',') !==
      profileSmoke.requestedProviderIds.join(',') ||
    profileSmoke.materialized.some(
      ({ id, builtIn, scope }) =>
        id.endsWith('-default') || builtIn || scope !== 'global',
    )
  ) {
    throw new Error(
      `opt-in harness profile materialization was incorrect (${JSON.stringify({
        defaultIds: profileSmoke.defaultIds,
        requestedProviderIds: profileSmoke.requestedProviderIds,
        materialized: profileSmoke.materialized,
      })})`,
    )
  }
  if (
    profileSmoke.obsoleteRiskState ||
    !profileSmoke.preview.args.includes(smokeRoot.path) ||
    !profileSmoke.preview.command.includes("HVIR_PROFILE_SMOKE='structured'")
  ) {
    throw new Error('structured Custom profile did not preserve preview semantics')
  }
  console.log('[smoke] structured profile catalog + preview OK')
}

export async function verifyHarnessProfileEditor(
  win: BrowserWindow,
  host: ProjectHost,
): Promise<void> {
  const manualProfileStatus = await verifyHarnessManualProfilePointerActivation(win)
  console.log(`[smoke] manual harness profile OK (${manualProfileStatus})`)

  const harnessRenameStatus = (await win.webContents.executeJavaScript(`
      new Promise((resolve, reject) => {
        document.querySelector(
          '.terminal-icon-button[aria-label="New terminal"]'
        )?.click();
        const waitForProfile = () => {
          const rows = [...document.querySelectorAll('.settings-profile-list button')];
          const source = rows.find((row) =>
            row.querySelector('strong')?.textContent?.trim() === 'Smoke custom harness'
          );
          if (!source) {
            return setTimeout(waitForProfile, 50);
          }
          if (rows.some((row) =>
            row.querySelector('strong')?.textContent?.trim() === 'Shell'
          )) return reject(new Error('Bare Shell remained in the management list'));
          const sourceDetail = source.querySelector('small')?.textContent || '';
          if (!sourceDetail.includes('This project')) {
            return reject(new Error('configured profile row omitted scope metadata'));
          }
          const dialog = document.querySelector('.settings-dialog');
          const heading = document.querySelector('#settings-harnesses-title');
          const active = dialog?.querySelector('[aria-current="page"]')?.textContent?.trim();
          const profileEditor = dialog?.querySelector('.settings-profile-editor');
          if (!dialog || !heading || active !== 'Harnesses')
            return reject(new Error('configure harnesses did not target its section'));
          if (!profileEditor || profileEditor.scrollHeight > profileEditor.clientHeight + 1)
            return reject(new Error('default harness profile requires scrolling'));
          const disclosures = [...profileEditor.querySelectorAll(
            '.settings-profile-disclosure'
          )];
          if (disclosures.length !== 2 || disclosures.some((details) => details.open)) {
            return reject(new Error('harness common/advanced/preview hierarchy is unclear'));
          }
          const beginProfileEdit = () => {
            source.click();
            requestAnimationFrame(() => {
            const before = document.querySelectorAll('.settings-profile-list button').length;
            const duplicate = [...document.querySelectorAll('.settings-profile-actions button')]
              .find((button) => button.textContent?.trim() === 'Duplicate');
            if (!duplicate) return reject(new Error('harness duplicate action missing'));
            duplicate.click();
            const waitForDuplicate = () => {
              const name = document.querySelector(
                '.settings-profile-grid label:first-child input'
              );
              const count = document.querySelectorAll('.settings-profile-list button').length;
              if (count > before && name?.value === 'Smoke custom harness copy') {
                Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')
                  ?.set?.call(name, 'Smoke renamed harness');
                name.dispatchEvent(new Event('input', { bubbles: true }));
                return requestAnimationFrame(() => {
                  if (document.querySelector('.fatal-error')) {
                    return reject(new Error('harness rename escaped to the error boundary'));
                  }
                  if (name.value !== 'Smoke renamed harness') {
                    return reject(new Error('harness profile rename did not update'));
                  }
                  const argv = document.querySelector('.settings-profile-argv textarea');
                  if (!argv) return reject(new Error('harness argument editor missing'));
                  Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')
                    ?.set?.call(argv, '--add-dir {binding:workspace}');
                  argv.dispatchEvent(new Event('input', { bubbles: true }));
                  const waitForArgumentPreview = () => {
                    const help = document.querySelector('#harness-arguments-help')
                      ?.textContent || '';
                    const previewDisclosure = document.querySelector(
                      '.settings-profile-preview-disclosure'
                    );
                    previewDisclosure.open = true;
                    const previews = [...document.querySelectorAll(
                      '.settings-profile-previews code'
                    )].map((node) => node.textContent || '');
                    if (/2 argv values/.test(help) &&
                        previews.some((value) => value.includes('--add-dir'))) {
                      if (previews.length !== 1 || !previewDisclosure.open) {
                        return reject(new Error('Custom preview disclosure was not fresh-only'));
                      }
                      const previewSummary = previewDisclosure.querySelector('summary');
                      previewSummary.focus();
                      const focusStyle = getComputedStyle(previewSummary);
                      if (parseFloat(focusStyle.outlineWidth) < 1) {
                        return reject(new Error('preview disclosure focus is not visible'));
                      }
                      const initialTheme = document.documentElement.dataset.theme;
                      const hierarchySurface = document.querySelector(
                        '.settings-harness-layout'
                      );
                      const initialSurface = getComputedStyle(hierarchySurface).backgroundColor;
                      document.querySelector('.theme-toggle')?.click();
                      return requestAnimationFrame(() => {
                        const alternateTheme = document.documentElement.dataset.theme;
                        const alternateSurface = getComputedStyle(
                          hierarchySurface
                        ).backgroundColor;
                        if (!alternateTheme || alternateTheme === initialTheme ||
                            alternateSurface === initialSurface) {
                          return reject(new Error('harness hierarchy did not repaint across themes'));
                        }
                        document.querySelector('.theme-toggle')?.click();
                        [...document.querySelectorAll('.settings-dialog .dialog-actions button')]
                          .find((button) => button.textContent?.trim() === 'Close settings')
                          ?.click();
                        requestAnimationFrame(() => {
                        const prompt = document.querySelector('.unsaved-harness-dialog');
                        if (!prompt) {
                          return reject(new Error('unsaved harness prompt did not open'));
                        }
                        [...prompt.querySelectorAll('button')]
                          .find((button) =>
                            button.textContent?.trim() === 'Save harness profile'
                          )?.click();
                        const waitForGuardedSave = () => {
                          if (!document.querySelector('.settings-dialog')) {
                            return resolve(
                              'section-targeted + duplicate-safe add + rename + same-line argv + guarded save'
                            );
                          }

                          setTimeout(waitForGuardedSave, 50);
                        };
                        waitForGuardedSave();
                        });
                      });
                    }

                    setTimeout(waitForArgumentPreview, 50);
                  };
                  waitForArgumentPreview();
                });
              }

              setTimeout(waitForDuplicate, 50);
            };
              waitForDuplicate();
            });
          };
          const addHarness = [...document.querySelectorAll(
            '.settings-harness-actions button'
          )].find((button) => button.textContent?.trim() === 'Add a harness…');
          if (!addHarness) return reject(new Error('add harness action missing'));
          addHarness.click();
          const waitForConfiguredTemplate = () => {
            const candidates = [...document.querySelectorAll(
              '.add-harness-candidates label'
            )];
            const candidate = candidates.find((label) =>
              (label.querySelector('small')?.textContent || '').includes('Already added')
            );
            if (candidate) {
              const checkbox = candidate.querySelector('input[type="checkbox"]');
              const detail = candidate.querySelector('small')?.textContent || '';
              if (!checkbox?.disabled || !detail.includes('Already added')) {
                return reject(new Error('configured template remained selectable'));
              }
              [...document.querySelectorAll('.add-harness-dialog button')]
                .find((button) => button.textContent?.trim() === 'Cancel')?.click();
              return requestAnimationFrame(beginProfileEdit);
            }
            const refresh = [...document.querySelectorAll('.add-harness-dialog button')]
              .find((button) => button.textContent?.trim() === 'Refresh');
            if (refresh && !refresh.disabled) {
              [...document.querySelectorAll('.add-harness-dialog button')]
                .find((button) => button.textContent?.trim() === 'Cancel')?.click();
              return requestAnimationFrame(beginProfileEdit);
            }

            setTimeout(waitForConfiguredTemplate, 50);
          };
          waitForConfiguredTemplate();
        };
        const waitForConfigure = () => {
          const configure = [...document.querySelectorAll('.terminal-new-menu button')]
            .find((button) => button.textContent?.trim() === 'Configure harnesses…');
          if (configure) {
            configure.click();
            return waitForProfile();
          }

          requestAnimationFrame(waitForConfigure);
        };
        waitForConfigure();
      })
    `)) as string
  console.log(`[smoke] harness profile editor OK (${harnessRenameStatus})`)

  const harnessSettingsCaptures = await captureHarnessSettingsVisuals(
    win,
    host,
    process.env.HVIR_HARNESS_SETTINGS_CAPTURE_DIR
      ? localPath(process.env.HVIR_HARNESS_SETTINGS_CAPTURE_DIR)
      : undefined,
  )
  if (harnessSettingsCaptures.length > 0) {
    console.log(
      `[smoke] harness settings captures OK (${harnessSettingsCaptures.length})`,
    )
  }

  const compactHarnessStatus = await verifyCompactHarnessSettings(win)
  console.log(`[smoke] compact harness settings OK (${compactHarnessStatus})`)
}
