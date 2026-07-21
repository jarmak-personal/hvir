import { useCallback, useEffect, useRef, useState } from 'react'

import type { AppTheme } from '../theme-model'
import {
  createSettingsDraft,
  validateSettingsDraft,
  type SettingsDraft,
  type SettingsDraftValidation,
} from './settings-draft'
import type { AppSettings } from './settings-model'
import type { SettingsDestination, SettingsSection } from './settings-navigation'

interface SettingsControllerOptions {
  readonly theme: AppTheme
  readonly settings: AppSettings
  readonly initialDestination: SettingsDestination
  readonly confirmSafeToLeaveHarnesses: () => Promise<boolean>
  readonly onSave: (theme: AppTheme, settings: AppSettings) => void
  readonly onClose: () => void
}

export function useSettingsController({
  theme,
  settings,
  initialDestination,
  confirmSafeToLeaveHarnesses,
  onSave,
  onClose,
}: SettingsControllerOptions) {
  const [activeSection, setActiveSection] = useState<SettingsSection>(
    initialDestination.section,
  )
  const [pendingIntent, setPendingIntent] = useState(initialDestination.intent)
  const [draft, setDraft] = useState(() => createSettingsDraft(theme, settings))
  const [validation, setValidation] = useState<
    Exclude<SettingsDraftValidation, { readonly valid: true }> | undefined
  >()
  const [saveError, setSaveError] = useState<string>()
  const [composerConsentOpen, setComposerConsentOpen] = useState(false)
  const activeSectionRef = useRef(activeSection)
  const focusFrame = useRef(0)
  activeSectionRef.current = activeSection

  useEffect(
    () => () => {
      window.cancelAnimationFrame(focusFrame.current)
    },
    [],
  )

  useEffect(() => {
    if (activeSection === 'harnesses' && pendingIntent) setPendingIntent(undefined)
  }, [activeSection, pendingIntent])

  const updateDraft = useCallback(
    <K extends keyof SettingsDraft>(field: K, value: SettingsDraft[K]): void => {
      setDraft((current) => ({ ...current, [field]: value }))
      setValidation(undefined)
      setSaveError(undefined)
    },
    [],
  )

  const canActivate = useCallback(
    async (section: SettingsSection): Promise<boolean> =>
      activeSectionRef.current !== 'harnesses' ||
      section === 'harnesses' ||
      confirmSafeToLeaveHarnesses(),
    [confirmSafeToLeaveHarnesses],
  )

  const requestSection = useCallback(
    (section: SettingsSection): void => {
      if (section === activeSectionRef.current) return
      void canActivate(section).then((confirmed) => {
        if (confirmed) setActiveSection(section)
      })
    },
    [canActivate],
  )

  const requestClose = useCallback((): void => {
    void confirmSafeToLeaveHarnesses().then((confirmed) => {
      if (confirmed) onClose()
    })
  }, [confirmSafeToLeaveHarnesses, onClose])

  const focusField = useCallback((fieldId: string): void => {
    window.cancelAnimationFrame(focusFrame.current)
    focusFrame.current = window.requestAnimationFrame(() => {
      document.getElementById(fieldId)?.focus()
    })
  }, [])

  const save = useCallback(async (): Promise<void> => {
    const result = validateSettingsDraft(draft)
    if (!result.valid) {
      setValidation(result)
      setSaveError(undefined)
      if (await canActivate(result.section)) {
        setActiveSection(result.section)
        focusField(result.fieldId)
      }
      return
    }

    setValidation(undefined)
    setSaveError(undefined)
    if (!(await confirmSafeToLeaveHarnesses())) return
    try {
      if (result.settings.composerSubmitMode !== settings.composerSubmitMode) {
        await window.hvir.invoke('harness:configure-composer-submit', {
          scope: 'all-connected',
          mode: result.settings.composerSubmitMode,
          previousMode: settings.composerSubmitMode,
        })
      }
      onSave(result.theme, result.settings)
    } catch (reason) {
      setSaveError(reason instanceof Error ? reason.message : String(reason))
    }
  }, [canActivate, confirmSafeToLeaveHarnesses, draft, focusField, onSave, settings])

  const requestComposerSubmitMode = useCallback(
    (enabled: boolean): void => {
      if (enabled) setComposerConsentOpen(true)
      else updateDraft('composerSubmitMode', 'enter')
    },
    [updateDraft],
  )

  const confirmComposerConsent = useCallback((): void => {
    updateDraft('composerSubmitMode', 'ctrl-enter')
    setComposerConsentOpen(false)
  }, [updateDraft])

  return {
    activeSection,
    initialAddOpen: activeSection === 'harnesses' && pendingIntent === 'add-harness',
    draft,
    validation,
    saveError,
    composerConsentOpen,
    updateDraft,
    requestSection,
    requestClose,
    save,
    requestComposerSubmitMode,
    cancelComposerConsent: () => setComposerConsentOpen(false),
    confirmComposerConsent,
  }
}
