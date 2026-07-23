// @vitest-environment happy-dom

import { act, createElement, useState, type ReactElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { HarnessProfileEditor } from '../src/renderer/src/settings/HarnessProfileEditor'
import type { HarnessProfileDraft } from '../src/renderer/src/settings/harness-profile-draft'
import { asHarnessProviderId, localPath, type HarnessProfileInput } from '../src/shared'

let root: Root | undefined
let host: HTMLDivElement | undefined

beforeEach(() => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true)
  host = document.createElement('div')
  document.body.append(host)
  root = createRoot(host)
})

afterEach(() => {
  if (root) act(() => root?.unmount())
  host?.remove()
  root = undefined
  host = undefined
  vi.unstubAllGlobals()
})

describe('HarnessProfileEditor binding names', () => {
  it('keeps new and existing rows focused during continuous input', () => {
    renderEditor()
    addRow('Environment')
    addRow('Host path bindings')

    const environmentNames = inputs('Environment name')
    expect(environmentNames).toHaveLength(2)
    typeWithoutRefocusing(environmentNames[0]!, 'SHARED')
    expect(inputs('Environment name').map((input) => input.value)).toEqual(['SHARED', ''])
    typeWithoutRefocusing(environmentNames[1]!, 'SHARED')
    expect(inputs('Environment name').map((input) => input.value)).toEqual([
      'SHARED',
      'SHARED',
    ])

    const pathBindingNames = inputs('Path binding name')
    expect(pathBindingNames).toHaveLength(2)
    typeWithoutRefocusing(pathBindingNames[0]!, 'repo')
    expect(inputs('Path binding name').map((input) => input.value)).toEqual(['repo', ''])
    typeWithoutRefocusing(pathBindingNames[1]!, 'repo')
    expect(inputs('Path binding name').map((input) => input.value)).toEqual([
      'repo',
      'repo',
    ])
  })
})

function renderEditor(): void {
  act(() => {
    root?.render(createElement(EditorHarness))
  })
}

function EditorHarness(): ReactElement {
  const [input, setInput] = useState<HarnessProfileInput>({
    displayName: 'Test profile',
    providerId: asHarnessProviderId('test'),
    scope: { kind: 'global' },
    executable: { kind: 'command', command: 'agent' },
    args: [],
    environment: [{ kind: 'literal', name: '', value: '' }],
    pathBindings: [{ name: '', path: localPath('/tmp/existing') }],
    order: 1,
  })
  const draft: HarnessProfileDraft = {
    builtIn: false,
    input,
    argvText: '',
  }

  return createElement(HarnessProfileEditor, {
    draft,
    providers: [],
    previews: [],
    busy: false,
    dirty: true,
    deleteArmed: false,
    workspaceRoot: localPath('/tmp/workspace'),
    projectRoot: localPath('/tmp/project'),
    onUpdateInput: (update) => setInput((current) => update(current)),
    onArguments: () => undefined,
    onAuthorizeExecutable: () => undefined,
    onPickBinding: () => undefined,
    onDuplicate: () => undefined,
    onRemove: () => undefined,
    onSave: () => undefined,
  })
}

function addRow(section: string): void {
  const heading = [
    ...document.querySelectorAll<HTMLElement>('.settings-profile-rows strong'),
  ].find((candidate) => candidate.textContent === section)
  const button = heading
    ?.closest<HTMLElement>('.settings-profile-rows')
    ?.querySelector<HTMLButtonElement>('header button')
  if (!button) throw new Error(`Missing Add button for '${section}'`)
  act(() => button.click())
}

function inputs(label: string): HTMLInputElement[] {
  return [...document.querySelectorAll<HTMLInputElement>(`input[aria-label="${label}"]`)]
}

function typeWithoutRefocusing(control: HTMLInputElement, text: string): void {
  act(() => control.focus())
  for (const character of text) {
    act(() => {
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set?.call(
        control,
        `${control.value}${character}`,
      )
      control.dispatchEvent(new Event('input', { bubbles: true }))
    })
    expect(control.isConnected).toBe(true)
    expect(document.activeElement).toBe(control)
  }
}
