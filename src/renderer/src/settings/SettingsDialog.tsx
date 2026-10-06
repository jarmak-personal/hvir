import { useCallback, useEffect, useRef, type ReactElement } from 'react'

import type { HostPath } from '../../../shared'
import type { ExtensionView } from '../../../shared/extensions/workbench'
import { useExtensionContributions } from '../extensions/extension-contribution-context'
import type { AppTheme } from '../theme'
import { ComposerSubmitConsentDialog } from './ComposerSubmitConsentDialog'
import type { HarnessProfilesSettingsHandle } from './HarnessProfilesSettings'
import { SettingsActiveSection } from './SettingsActiveSection'
import { SettingsSectionNavigation } from './SettingsSectionNavigation'
import type { AppSettings } from './settings'
import {
  DEFAULT_SETTINGS_DESTINATION,
  settingsSectionHeadingId,
  type SettingsDestination,
} from './settings-navigation'
import { useSettingsController } from './use-settings-controller'
import type { ExtensionsSettingsHandle } from './sections/ExtensionsSettings'

interface SettingsDialogProps {
  readonly theme: AppTheme
  readonly settings: AppSettings
  readonly onSave: (theme: AppTheme, settings: AppSettings) => void
  readonly onClose: () => void
  readonly workspaceRoot?: HostPath
  readonly projectRoot?: HostPath
  readonly initialDestination?: SettingsDestination
  readonly open?: boolean
  readonly onInstallationHandoff?: () => void
}

export function SettingsDialog({
  theme,
  settings,
  onSave,
  onClose,
  workspaceRoot,
  projectRoot,
  initialDestination = DEFAULT_SETTINGS_DESTINATION,
  open = true,
  onInstallationHandoff,
}: SettingsDialogProps): ReactElement | null {
  const dialog = useRef<HTMLElement>(null)
  const harnessProfiles = useRef<HarnessProfilesSettingsHandle>(null)
  const installation = useRef<ExtensionsSettingsHandle>(null)
  const confirmSafeToLeaveHarnesses = useCallback(
    () => harnessProfiles.current?.confirmSafeToLeave() ?? Promise.resolve(true),
    [],
  )
  const controller = useSettingsController({
    open,
    theme,
    settings,
    initialDestination,
    confirmSafeToLeaveHarnesses,
    onSave,
    onClose,
  })
  const close = controller.requestClose
  const requestClose = useCallback(() => {
    installation.current?.cancelInstallation()
    close()
  }, [close])
  const contributions = useExtensionContributions()
  const installedLanding = (view: ExtensionView): boolean => {
    if (!contributions?.foreground || !onInstallationHandoff) return false
    onInstallationHandoff()
    if (view.context?.surface === 'top') contributions.selectTop(view)
    else contributions.selectViewer(view.id)
    contributions.focusLanding(view)
    return true
  }

  useEffect(() => {
    if (!open || initialDestination.intent === 'add-harness') return
    const frame = window.requestAnimationFrame(() => {
      if (initialDestination.section === 'appearance') dialog.current?.focus()
      else
        document
          .getElementById(settingsSectionHeadingId(initialDestination.section))
          ?.focus()
    })
    return () => window.cancelAnimationFrame(frame)
  }, [open, initialDestination])

  useEffect(() => {
    if (!open) return
    const keydown = (event: KeyboardEvent): void => {
      if (dialog.current?.querySelector('.modal-backdrop.nested')) return
      if (event.key === 'Escape' && !(event.target instanceof HTMLTextAreaElement)) {
        requestClose()
      }
    }
    window.addEventListener('keydown', keydown)
    return () => window.removeEventListener('keydown', keydown)
  }, [open, requestClose])

  const statusMessage = controller.validation?.message ?? controller.saveError
  if (!open) return null

  return (
    <div className="modal-backdrop">
      <section
        className="project-dialog settings-dialog"
        ref={dialog}
        role="dialog"
        aria-modal="true"
        aria-labelledby="settings-title"
        tabIndex={-1}
      >
        <header className="settings-shell-heading">
          <div>
            <span>Workbench preferences</span>
            <h2 id="settings-title">Settings</h2>
          </div>
          <p>Keep hvir focused, legible, and tuned to the way you work.</p>
        </header>
        <div className="settings-shell-body">
          <SettingsSectionNavigation
            activeSection={controller.activeSection}
            onSelect={(section) => {
              if (section !== controller.activeSection)
                installation.current?.cancelInstallation()
              controller.requestSection(section)
            }}
          />
          <div className="settings-content">
            <SettingsActiveSection
              activeSection={controller.activeSection}
              draft={controller.draft}
              validation={controller.validation}
              harnessProfiles={harnessProfiles}
              workspaceRoot={workspaceRoot}
              projectRoot={projectRoot}
              initialAddOpen={controller.initialAddOpen}
              onChange={controller.updateDraft}
              onComposerSubmitMode={controller.requestComposerSubmitMode}
              onInstalledLanding={installedLanding}
              installation={installation}
            />
          </div>
        </div>
        <footer className="settings-footer">
          <div className="settings-footer-status" aria-live="polite">
            {statusMessage ? (
              <p className="dialog-error" role="alert">
                {statusMessage}
              </p>
            ) : (
              <span>App preferences apply together when saved.</span>
            )}
          </div>
          <div className="dialog-actions">
            <button
              type="button"
              onClick={requestClose}
              className="hvir-button hvir-control"
            >
              Close settings
            </button>
            <button
              type="button"
              onClick={() => void controller.save()}
              className="hvir-button hvir-control"
            >
              Save app settings
            </button>
          </div>
        </footer>
      </section>
      {controller.composerConsentOpen ? (
        <ComposerSubmitConsentDialog
          onCancel={controller.cancelComposerConsent}
          onConfirm={controller.confirmComposerConsent}
        />
      ) : null}
    </div>
  )
}
