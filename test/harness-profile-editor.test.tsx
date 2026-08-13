// @vitest-environment happy-dom

import { act, createElement, useState, type ReactElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { HarnessProfileEditor } from '../src/renderer/src/settings/HarnessProfileEditor'
import type { HarnessProfileDraft } from '../src/renderer/src/settings/harness-profile-draft'
import {
  asHarnessProviderId,
  localPath,
  type HarnessProfileInput,
  type HarnessProviderDescriptor,
} from '../src/shared'
import { parseHarnessArguments } from '../src/renderer/src/settings/harness-argument-editor'

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

  it('keeps every structured field group reachable and changes only its draft field', () => {
    const onInput = vi.fn<(input: HarnessProfileInput) => void>()
    const onAuthorize = vi.fn()
    const onPickBinding = vi.fn()
    renderEditor({ onInput, onAuthorize, onPickBinding })

    const name = labelledInput('Name')
    typeWithoutRefocusing(name, ' renamed')
    expect(name.value).toBe('Test profile renamed')

    const description = labelledInput('Description')
    typeWithoutRefocusing(description, 'Visible description')
    expect(description.value).toBe('Visible description')

    const provider = labelledSelect('Provider')
    changeSelect(provider, 'bundled')
    expect(labelledSelect('Executable').value).toBe('provider-default')
    changeSelect(provider, 'custom')
    expect(labelledSelect('Executable').value).toBe('command')
    typeWithoutRefocusing(inputs('Executable command')[0]!, 'future-agent')

    changeSelect(labelledSelect('Scope'), 'project')
    expect(onInput).toHaveBeenLastCalledWith(
      expect.objectContaining({
        scope: { kind: 'project', projectRoot: localPath('/tmp/project') },
      }),
    )

    changeSelect(labelledSelect('Executable'), 'path')
    const executablePath = inputs('Absolute executable path')[0]!
    changeValue(executablePath, '/opt/agents/future-agent')
    act(() => button('Authorize path').click())
    expect(onAuthorize).toHaveBeenCalledOnce()
    expect(onInput).toHaveBeenLastCalledWith(
      expect.objectContaining({
        executable: { kind: 'path', path: localPath('/opt/agents/future-agent') },
      }),
    )

    const argumentsEditor = document.querySelector<HTMLTextAreaElement>(
      '.settings-profile-argv textarea',
    )!
    changeValue(argumentsEditor, '--model "o3 mini"')
    expect(document.body.textContent).toContain('Parsed as 2 argv values')

    addRow('Environment')
    const environmentNames = inputs('Environment name')
    changeValue(environmentNames.at(-1)!, 'TOKEN')
    const environmentRows = document.querySelectorAll<HTMLElement>(
      '.settings-profile-rows:not(.path)',
    )
    const environmentRow = environmentRows[0]!.querySelectorAll<HTMLElement>(
      '.settings-profile-row',
    )[1]!
    const environmentOperation = environmentRow.querySelector<HTMLSelectElement>(
      'select[aria-label="Environment operation"]',
    )!
    changeSelect(environmentOperation, 'reference')
    changeSelect(
      environmentRow.querySelector<HTMLSelectElement>(
        'select[aria-label="Reference source"]',
      )!,
      'local-forward',
    )
    changeValue(
      environmentRow.querySelector<HTMLInputElement>(
        'input[aria-label="Reference name"]',
      )!,
      'LOCAL_TOKEN',
    )
    expect(onInput.mock.calls.at(-1)?.[0].environment).toContainEqual({
      kind: 'reference',
      name: 'TOKEN',
      source: 'local-forward',
      sourceName: 'LOCAL_TOKEN',
    })
    changeSelect(environmentOperation, 'unset')
    expect(onInput.mock.calls.at(-1)?.[0].environment).toContainEqual({
      kind: 'unset',
      name: 'TOKEN',
    })

    addRow('Host path bindings')
    const pathNames = inputs('Path binding name')
    changeValue(pathNames.at(-1)!, 'monorepo')
    const pathRows = [
      ...document.querySelectorAll<HTMLElement>('.settings-profile-row.path'),
    ]
    act(() => {
      pathRows.at(-1)?.querySelector<HTMLButtonElement>('button')?.click()
    })
    expect(onPickBinding).toHaveBeenCalledWith(1)

    act(() => button('Move later').click())
    expect(onInput).toHaveBeenLastCalledWith(expect.objectContaining({ order: 2 }))
  })
})

function renderEditor(options: EditorHarnessOptions = {}): void {
  act(() => {
    root?.render(createElement(EditorHarness, options))
  })
}

interface EditorHarnessOptions {
  readonly onInput?: (input: HarnessProfileInput) => void
  readonly onAuthorize?: () => void
  readonly onPickBinding?: (index: number) => void
}

function EditorHarness({
  onInput,
  onAuthorize = () => undefined,
  onPickBinding = () => undefined,
}: EditorHarnessOptions): ReactElement {
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
  const providers = testProviders()

  return createElement(HarnessProfileEditor, {
    draft,
    providers,
    provider: providers.find((candidate) => candidate.id === input.providerId),
    previews: [],
    busy: false,
    dirty: true,
    deleteArmed: false,
    workspaceRoot: localPath('/tmp/workspace'),
    projectRoot: localPath('/tmp/project'),
    onUpdateInput: (update) =>
      setInput((current) => {
        const next = update(current)
        onInput?.(next)
        return next
      }),
    onArguments: (argvText) =>
      setInput((current) => {
        const next = { ...current, args: parseHarnessArguments(argvText) }
        onInput?.(next)
        return next
      }),
    onAuthorizeExecutable: onAuthorize,
    onPickBinding,
    onDuplicate: () => undefined,
    onRemove: () => undefined,
    onSave: () => undefined,
  })
}

function testProviders(): readonly HarnessProviderDescriptor[] {
  const descriptor = (
    id: string,
    options: Pick<HarnessProviderDescriptor, 'default' | 'profileTemplate'>,
  ): HarnessProviderDescriptor => ({
    id: asHarnessProviderId(id),
    displayName: id,
    ...options,
    capabilities: {
      exactResume: false,
      sessionIdentity: 'none',
      contextPresentation: 'none',
    },
    terminalInput: {
      modifiedKeyProtocol: 'none',
      metaEnterAliasesControl: false,
    },
    profileGuidance: { reservedArguments: [], riskClassification: 'best-effort' },
  })
  return [
    descriptor('test', { default: false, profileTemplate: undefined }),
    descriptor('bundled', {
      default: false,
      profileTemplate: { displayName: 'Bundled', description: 'Bundled provider' },
    }),
    descriptor('custom', { default: false, profileTemplate: undefined }),
  ]
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

function labelledInput(label: string): HTMLInputElement {
  const match = [...document.querySelectorAll<HTMLLabelElement>('label')]
    .find((candidate) => candidate.querySelector('span')?.textContent === label)
    ?.querySelector<HTMLInputElement>('input')
  if (!match) throw new Error(`Missing input '${label}'`)
  return match
}

function labelledSelect(label: string): HTMLSelectElement {
  const match = [...document.querySelectorAll<HTMLLabelElement>('label')]
    .find((candidate) => candidate.querySelector('span')?.textContent === label)
    ?.querySelector<HTMLSelectElement>('select')
  if (!match) throw new Error(`Missing select '${label}'`)
  return match
}

function button(label: string): HTMLButtonElement {
  const match = [...document.querySelectorAll<HTMLButtonElement>('button')].find(
    (candidate) => candidate.textContent?.trim() === label,
  )
  if (!match) throw new Error(`Missing button '${label}'`)
  return match
}

function changeValue(
  control: HTMLInputElement | HTMLTextAreaElement,
  value: string,
): void {
  act(() => {
    const prototype =
      control instanceof HTMLTextAreaElement
        ? HTMLTextAreaElement.prototype
        : HTMLInputElement.prototype
    Object.getOwnPropertyDescriptor(prototype, 'value')?.set?.call(control, value)
    control.dispatchEvent(new Event('input', { bubbles: true }))
  })
}

function changeSelect(control: HTMLSelectElement, value: string): void {
  act(() => {
    Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, 'value')?.set?.call(
      control,
      value,
    )
    control.dispatchEvent(new Event('change', { bubbles: true }))
  })
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
