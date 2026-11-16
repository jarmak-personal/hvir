import { evaluateInstalledRenderer } from './installed-renderer-probe.mts'
export { parseDevToolsActivePort } from './installed-renderer-probe.mts'

interface InstalledBrowserElement {
  readonly textContent: string | null
  readonly disabled?: boolean
  readonly value?: string
  click(): void
  querySelector(selector: string): InstalledBrowserElement | null
  querySelectorAll(selector: string): Iterable<InstalledBrowserElement>
}

interface InstalledBrowserDocument {
  querySelector(selector: string): InstalledBrowserElement | null
  querySelectorAll(selector: string): Iterable<InstalledBrowserElement>
}

interface InstalledElementConstructor {
  [Symbol.hasInstance](value: unknown): boolean
}

interface InstalledBrowserScope {
  readonly document: InstalledBrowserDocument
  readonly HTMLElement: InstalledElementConstructor
  readonly HTMLButtonElement: InstalledElementConstructor
}

export async function runInstalledHarnessDialogExercise(): Promise<string> {
  const { document, HTMLElement, HTMLButtonElement } =
    globalThis as unknown as InstalledBrowserScope
  const deadline = (): number => Date.now() + 8_000
  const waitFor = <T,>(read: () => T | undefined, message: string): Promise<T> =>
    new Promise((resolve, reject) => {
      const expires = deadline()
      const poll = (): void => {
        const value = read()
        if (value) return resolve(value)
        if (Date.now() >= expires) return reject(new Error(message))
        setTimeout(poll, 25)
      }
      poll()
    })
  const isElement = (
    value: InstalledBrowserElement | null,
    constructor: InstalledElementConstructor,
  ): value is InstalledBrowserElement =>
    value !== null && constructor[Symbol.hasInstance](value)
  const activateWhenReady = (
    read: () => InstalledBrowserElement | null,
    missingMessage: string,
    disabledMessage: string,
  ): Promise<void> =>
    new Promise((resolve, reject) => {
      const expires = deadline()
      let observedDisabled = false
      const poll = (): void => {
        const action = read()
        if (isElement(action, HTMLButtonElement)) {
          if (action.disabled === false) {
            action.click()
            resolve()
            return
          }
          observedDisabled = true
        }
        if (Date.now() >= expires) {
          reject(new Error(observedDisabled ? disabledMessage : missingMessage))
          return
        }
        setTimeout(poll, 25)
      }
      poll()
    })
  const pendingDialog = (): InstalledBrowserElement | undefined => {
    const dialog = document.querySelector('.add-harness-dialog')
    const claude = [...document.querySelectorAll('.add-harness-candidates label')].find(
      (label) => label.querySelector('strong')?.textContent?.trim() === 'Claude Code',
    )
    const detail = claude?.querySelector('small')?.textContent?.trim()
    return isElement(dialog, HTMLElement) && detail === 'Checking…' ? dialog : undefined
  }
  const closeAddDialog = async (dialog: InstalledBrowserElement): Promise<void> => {
    const cancel = [...dialog.querySelectorAll('button')].find(
      (button) => button.textContent?.trim() === 'Cancel',
    )
    if (cancel === undefined || !isElement(cancel, HTMLButtonElement)) {
      throw new Error('Add-harness cancel missing')
    }
    cancel.click()
    await waitFor(
      () => (document.querySelector('.add-harness-dialog') ? undefined : true),
      'Add-harness dialog did not close while probes were pending',
    )
  }

  await activateWhenReady(
    () => document.querySelector('button[aria-label="New terminal"]'),
    'New-terminal action missing',
    'New-terminal action remained disabled',
  )
  const directAdd = await waitFor(
    () =>
      [...document.querySelectorAll('.terminal-new-menu button')].find(
        (button) => button.textContent?.trim() === 'Add a harness…',
      ),
    'Direct add-harness action missing',
  )
  directAdd.click()
  const directDialog = await waitFor(
    pendingDialog,
    'Direct add-harness entry did not paint while the real provider probe was pending',
  )
  await closeAddDialog(directDialog)

  // Cancelling the direct entry leaves Settings open on Harnesses.
  await activateWhenReady(
    () =>
      [...document.querySelectorAll('.settings-harness-actions button')].find(
        (button) => button.textContent?.trim() === 'Add a harness…',
      ) ?? null,
    'Settings add-harness action missing',
    'Settings add-harness action remained disabled',
  )
  const settingsDialog = await waitFor(
    pendingDialog,
    'Settings add-harness entry did not paint while the real provider probe was pending',
  )
  const addShell = [...settingsDialog.querySelectorAll('button')].find(
    (button) => button.textContent?.trim() === 'Add a shell',
  )
  if (addShell === undefined || !isElement(addShell, HTMLButtonElement)) {
    throw new Error('Direct add-shell action missing')
  }
  addShell.click()
  await waitFor(() => {
    if (document.querySelector('.add-harness-dialog')) return undefined
    const name = document.querySelector('.settings-profile-grid label:first-child input')
    return name?.value === 'Additional shell' ? true : undefined
  }, 'Direct add-shell action did not open the existing manual shell draft')

  const closeSettings = [...document.querySelectorAll('.settings-dialog button')].find(
    (button) => button.textContent?.trim() === 'Close settings',
  )
  if (closeSettings === undefined || !isElement(closeSettings, HTMLButtonElement)) {
    throw new Error('Close-settings action missing after harness probe')
  }
  closeSettings.click()
  const unsaved = await waitFor(
    () => document.querySelector('.unsaved-harness-dialog') ?? undefined,
    'Direct shell draft did not retain the settings dirty guard',
  )
  const discard = [...unsaved.querySelectorAll('button')].find(
    (button) => button.textContent?.trim() === 'Discard changes',
  )
  if (discard === undefined || !isElement(discard, HTMLButtonElement)) {
    throw new Error('Direct shell draft discard action missing')
  }
  discard.click()
  await waitFor(
    () => (document.querySelector('.settings-dialog') ? undefined : true),
    'Workbench did not remain interactive after harness probes',
  )
  return 'both add-harness entries painted while Claude probe was pending; direct shell draft retained the dirty guard'
}

export async function exerciseInstalledHarnessDialogs(
  readActivePort: () => Promise<string>,
): Promise<string> {
  return evaluateInstalledRenderer(
    readActivePort,
    `(${runInstalledHarnessDialogExercise.toString()})()`,
  )
}
