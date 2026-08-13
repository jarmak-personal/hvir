// @vitest-environment happy-dom

import { afterEach, describe, expect, it, vi } from 'vitest'

import { runInstalledHarnessDialogExercise } from '../scripts/installed-harness-dialog-probe.mjs'

afterEach(() => {
  vi.useRealTimers()
  document.body.replaceChildren()
})

function newTerminalButton(disabled: boolean): HTMLButtonElement {
  const button = document.createElement('button')
  button.type = 'button'
  button.setAttribute('aria-label', 'New terminal')
  button.disabled = disabled
  document.body.append(button)
  return button
}

function appendPendingDialog(onOpen: () => void, onAddShell?: () => void): void {
  onOpen()
  const dialog = document.createElement('div')
  dialog.className = 'add-harness-dialog'
  dialog.innerHTML = `
    <div class="add-harness-candidates">
      <label><strong>Claude Code</strong><small>Checking…</small></label>
    </div>
  `
  const cancel = document.createElement('button')
  cancel.type = 'button'
  cancel.textContent = 'Cancel'
  cancel.addEventListener('click', () => dialog.remove())
  const addShell = document.createElement('button')
  addShell.type = 'button'
  addShell.textContent = 'Add a shell'
  addShell.addEventListener('click', () => {
    dialog.remove()
    onAddShell?.()
  })
  dialog.append(addShell, cancel)
  document.body.append(dialog)
}

function installCompleteHarnessFlow(
  addTerminal: HTMLButtonElement,
  onDirectDialog: () => void,
  onSettingsDialog: () => void,
): void {
  addTerminal.addEventListener('click', () => {
    const menu = document.createElement('div')
    menu.className = 'terminal-new-menu'
    const addHarness = document.createElement('button')
    addHarness.type = 'button'
    addHarness.textContent = 'Add a harness…'
    addHarness.addEventListener('click', () => appendPendingDialog(onDirectDialog))
    menu.append(addHarness)
    document.body.append(menu)
  })

  const openSettings = document.createElement('button')
  openSettings.type = 'button'
  openSettings.setAttribute('aria-label', 'Open settings')
  openSettings.addEventListener('click', () => {
    const settings = document.createElement('div')
    settings.className = 'settings-dialog'
    let shellDraft = false

    const index = document.createElement('div')
    index.className = 'settings-section-index'
    const harnesses = document.createElement('button')
    harnesses.type = 'button'
    harnesses.textContent = 'Harnesses'
    harnesses.addEventListener('click', () => {
      const actions = document.createElement('div')
      actions.className = 'settings-harness-actions'
      const addHarness = document.createElement('button')
      addHarness.type = 'button'
      addHarness.textContent = 'Add a harness…'
      addHarness.addEventListener('click', () =>
        appendPendingDialog(onSettingsDialog, () => {
          shellDraft = true
          const grid = document.createElement('div')
          grid.className = 'settings-profile-grid'
          const label = document.createElement('label')
          const name = document.createElement('input')
          name.value = 'Additional shell'
          label.append(name)
          grid.append(label)
          settings.append(grid)
        }),
      )
      actions.append(addHarness)
      settings.append(actions)
    })
    index.append(harnesses)

    const close = document.createElement('button')
    close.type = 'button'
    close.textContent = 'Close settings'
    close.addEventListener('click', () => {
      if (!shellDraft) {
        settings.remove()
        return
      }
      const unsaved = document.createElement('div')
      unsaved.className = 'unsaved-harness-dialog'
      const discard = document.createElement('button')
      discard.type = 'button'
      discard.textContent = 'Discard changes'
      discard.addEventListener('click', () => {
        unsaved.remove()
        settings.remove()
      })
      unsaved.append(discard)
      document.body.append(unsaved)
    })
    settings.append(index, close)
    document.body.append(settings)
  })
  document.body.append(openSettings)
}

describe('installed harness dialog exercise', () => {
  it('distinguishes a missing New terminal control', async () => {
    vi.useFakeTimers()

    const exercise = runInstalledHarnessDialogExercise()
    const failure = expect(exercise).rejects.toThrow('New-terminal action missing')
    await vi.advanceTimersByTimeAsync(8_000)

    await failure
  })

  it('does not click a persistently disabled New terminal control', async () => {
    vi.useFakeTimers()
    const addTerminal = newTerminalButton(true)
    const clicked = vi.fn()
    addTerminal.addEventListener('click', clicked)

    const exercise = runInstalledHarnessDialogExercise()
    const failure = expect(exercise).rejects.toThrow(
      'New-terminal action remained disabled',
    )
    await vi.advanceTimersByTimeAsync(8_000)

    await failure
    expect(clicked).not.toHaveBeenCalled()
  })

  it('waits for New terminal to become enabled before exercising both entry points', async () => {
    vi.useFakeTimers()
    const addTerminal = newTerminalButton(true)
    const terminalClicks = vi.fn()
    const directDialogs = vi.fn()
    const settingsDialogs = vi.fn()
    addTerminal.addEventListener('click', terminalClicks)
    installCompleteHarnessFlow(addTerminal, directDialogs, settingsDialogs)

    const exercise = runInstalledHarnessDialogExercise()
    await vi.advanceTimersByTimeAsync(100)
    expect(terminalClicks).not.toHaveBeenCalled()

    addTerminal.disabled = false
    await vi.advanceTimersByTimeAsync(25)

    await expect(exercise).resolves.toBe(
      'both add-harness entries painted while Claude probe was pending; direct shell draft retained the dirty guard',
    )
    expect(terminalClicks).toHaveBeenCalledTimes(1)
    expect(directDialogs).toHaveBeenCalledTimes(1)
    expect(settingsDialogs).toHaveBeenCalledTimes(1)
    expect(document.querySelector('.add-harness-dialog')).toBeNull()
    expect(document.querySelector('.settings-dialog')).toBeNull()
  })
})
