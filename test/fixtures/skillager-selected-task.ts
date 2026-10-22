import { readFileSync } from 'node:fs'
import { runInNewContext } from 'node:vm'
import { buildSync } from 'esbuild'
import { expect, vi } from 'vitest'
import { connectorOutputFixture } from './connector-output'
import type { ImportPreview } from './skillager-import'

type Value = Record<string, unknown>
interface Preview {
  exposure_id: string
  target: string
  preview: {
    project: string
    confirmation_token: string
    source: {
      id: string
      root: string
      content_hash: string
      source: { library_id: string; library_root: string }
    }
  }
}
interface Status {
  library: Value
  skill: {
    id: string
    path: string
    entrypoint: string
    working_hash: string
    accepted_hash: string
    acceptance: string
    exposures: Value[]
  }
}
export function fixture(external?: ImportPreview, composed = false) {
  const template = document.createElement('template')
  template.innerHTML = readFileSync('packages/skillager-extension/detail.html', 'utf8')
  for (const node of template.content.querySelectorAll('script, link')) node.remove()
  document.body.replaceChildren(template.content.cloneNode(true))
  const preview = JSON.parse(
    readFileSync(
      'test/fixtures/skillager-management/codex-exact-mode-update-preview.json',
      'utf8',
    ),
  ) as [Preview]
  const selected = preview[0].preview.source
  const status = JSON.parse(
    readFileSync('test/fixtures/skillager-management/first-no-git-status.json', 'utf8'),
  ) as Status
  Object.assign(status.library, {
    library_id: selected.source.library_id,
    root: selected.source.library_root,
  })
  Object.assign(status.skill, {
    id: selected.id,
    path: selected.root,
    entrypoint: `${selected.root}/SKILL.md`,
    working_hash: selected.content_hash,
    accepted_hash: selected.content_hash,
    acceptance: 'accepted',
  })
  const review = JSON.parse(
    readFileSync('test/fixtures/skillager-management/first-no-git-review.json', 'utf8')
      .replaceAll('f06e01bd-5e1f-4aa0-b1ef-3cf9c66f2a85', selected.source.library_id)
      .replaceAll('/owned-manifest-fixture/library/skills/owned-first', selected.root)
      .replaceAll('/owned-manifest-fixture/library', selected.source.library_root)
      .replaceAll('lib/owned-first', selected.id)
      .replaceAll(
        '0cc360070c6fc5542d08e3c5c85bb5a9299a39a7d56193db8eb3e12d6b6a445a',
        selected.content_hash,
      ),
  ) as unknown
  const workspace = {
    id: 'workspace',
    name: 'Project',
    host: 'local',
    root: { hostId: 'local', path: preview[0].preview.project },
  }
  if (external)
    external = JSON.parse(
      JSON.stringify(external)
        .replaceAll(external.library.root, selected.source.library_root)
        .replaceAll(external.project, workspace.root.path)
        .replaceAll(
          external.review_manifest.library.library_id!,
          selected.source.library_id,
        ),
    ) as ImportPreview
  let context: Value = { visible: true, workspace },
    exposures: unknown[] = [],
    failure = false,
    failureMessage: string | undefined,
    actionError: string | undefined,
    records: Value[] = [],
    hold = false,
    holdAction = false,
    releaseAction: (() => void) | undefined,
    projectReadable = true,
    releaseConnection: ((value: unknown) => void) | undefined,
    release: (() => void) | undefined
  let actionResult: Value = {
    outcome: 'verified',
    action: 'add-copy',
    exposureId: preview[0].exposure_id,
    target: { hostId: 'local', path: preview[0].target },
  }
  const actions: Value[] = [],
    requests: { capability: string; input: Value }[] = [],
    recovery: Value[] = [],
    executions: Value[] = [],
    outputs = new Map<string, unknown>(),
    controller = new AbortController()
  let count = 0
  const native = connectorOutputFixture()
  const client = {
    alive: true,
    signal: controller.signal,
    listen: () => () => undefined,
    request: async (capability: string, input: Value): Promise<unknown> => {
      requests.push({ capability, input })
      if (capability === 'source.status')
        return [{ source: 'project', granted: projectReadable }]
      if (capability === 'connector.status')
        return [
          {
            connector: 'project-cli',
            host: workspace.host,
            availability: failure ? 'unavailable' : 'supported',
          },
        ]
      if (capability === 'actions.invoke') {
        const request = input['input'] as Value
        if (input['action'] === 'operation-state') {
          recovery.push(request)
          if (request['mode'] === 'observe')
            return {
              outcome: 'observed',
              observation: JSON.stringify({ target: preview[0].target, current: true }),
              message: 'Exact current facts',
            }
          if (request['mode'] === 'acknowledge') {
            records = []
            return { outcome: 'reconciled', message: 'Current facts acknowledged' }
          }
          if (request['mode'] === 'list')
            return { ids: records.map((entry) => entry['id']) }
          if (request['mode'] === 'report')
            return {
              data: JSON.stringify(
                records.find((entry) => entry['id'] === request['operationId']),
              ),
              nextOffset: null,
            }
        }
        actions.push(input)
        if (holdAction) {
          holdAction = false
          await new Promise<void>((resolve) => {
            releaseAction = resolve
          })
        }
        if (actionResult['outcome'] === 'uncertain')
          records.push({
            id: actionResult['operationId'],
            operation: {
              action: input['action'],
              library: request['library'],
              source: { id: selected.id },
              workspace,
              agent: request['agent'],
              target: { hostId: 'local', path: preview[0].target },
            },
          })
        if (actionError) throw new Error(actionError)
        if (
          actionResult['outcome'] === 'verified' &&
          ['add-copy', 'change-exposure', 'remove-copy'].includes(String(input['action']))
        ) {
          const copy =
            typeof request['request'] === 'string'
              ? (JSON.parse(request['request']) as Value)
              : request
          exposures =
            input['action'] === 'remove-copy'
              ? []
              : [
                  {
                    ...preview[0],
                    skill_id: selected.id,
                    source_library_id: selected.source.library_id,
                    mode: copy['mode'],
                    agent: request['agent'],
                    status: 'current',
                  },
                ]
          status.skill.exposures = exposures.map(() => ({
            path: preview[0].target,
            agent: request['agent'],
            scope: 'project',
            source_library_id: selected.source.library_id,
            source_hash: selected.content_hash,
          }))
        }
        if (input['action'] === 'accept-version') status.skill.acceptance = 'accepted'
        return actionResult
      }
      if (capability === 'connector.output') return native.read(input)
      if (capability === 'connector.connect') {
        if (!projectReadable)
          return new Promise((resolve) => {
            releaseConnection = resolve
          })
        failure = false
        return {
          connections: [{ connector: 'project-cli', outcome: 'connected' }],
          source: { source: 'project', outcome: 'granted' },
          readiness: { program: true, source: true },
        }
      }
      if (failureMessage && input['connector'] === 'project-cli')
        throw new Error(failureMessage)
      executions.push(input)
      const args = input['args'] as string[]
      if (failure && input['connector'] === 'project-cli')
        return { outcome: 'not-started', reason: 'unapproved' }
      const receipt = String(++count)
      outputs.set(
        receipt,
        args[0] === 'import'
          ? external
          : args.includes('--remove')
            ? JSON.parse(
                readFileSync(
                  'test/fixtures/skillager-management/codex-mode-remove-preview.json',
                  'utf8',
                ),
              )
            : args.includes('--list')
              ? { schema: 'skillager.exposures.v1', exposures }
              : args.includes('accept')
                ? review
                : args[0] === 'expose'
                  ? preview
                  : input['connector'] === 'project-cli'
                    ? status
                    : { ...status, skill: { ...status.skill, exposures: [] } },
      )
      if (hold) {
        hold = false
        await new Promise<void>((resolve) => {
          release = resolve
        })
      }
      return native.complete(
        { outcome: 'completed', code: 0, receipt, truncated: false },
        JSON.stringify(outputs.get(receipt)),
      )
    },
  }
  const bundle = buildSync({
    entryPoints: [
      composed
        ? 'packages/skillager-extension/src/selected-task-surface.mjs'
        : 'packages/skillager-extension/src/selected-skill-view.mjs',
    ],
    bundle: true,
    format: 'iife',
    globalName: 'Module',
    write: false,
  })
  const sandbox = { AbortController, TextEncoder, Module: undefined as unknown }
  runInNewContext(bundle.outputFiles[0]!.text, sandbox)
  interface View {
    select(input: unknown): void
    contextChanged(): void
    visibilityChanged(options?: { completed: boolean }): void
    dispose(): void
    submitted?: boolean
  }
  const changed = vi.fn()
  const module = sandbox.Module as Record<
    string,
    (document: Document, client: unknown, ports: unknown) => View
  >
  const view = module[composed ? 'bindSelectedTaskSurface' : 'bindSelectedSkill']!(
    document,
    client,
    { context: () => context, changed },
  )
  const dispose = () => {
    view.dispose()
    controller.abort()
  }
  const selection = {
    row: {
      id: selected.id,
      source: 'library',
      host: 'local',
      kind: 'Your library',
      path: status.skill.entrypoint,
    },
    library: { id: selected.source.library_id, root: selected.source.library_root },
  }
  const button = (id: string) => document.getElementById(id) as HTMLButtonElement
  const ready = () =>
    vi.waitFor(() => expect(button('task-primary').disabled).toBe(false))
  return {
    view,
    client,
    context: () => context,
    dispose,
    changed,
    selection,
    status,
    actions,
    recovery,
    executions,
    requests,
    preview,
    external,
    button,
    ready,
    changeMode: (mode: string) => {
      const select = document.getElementById('task-mode') as HTMLSelectElement
      select.value = mode
      select.dispatchEvent(new Event('change'))
    },
    mode: () => (document.getElementById('task-mode') as HTMLSelectElement).value,
    projectSelection: (agent = 'codex', target = preview[0].target) => ({
      row: {
        id: 'exact-project-occurrence',
        skillId: selected.id,
        source: 'project',
        host: 'local',
        workspaceId: workspace.id,
        path: `${target}/SKILL.md`,
        canonical: { library_id: selected.source.library_id, skill_id: selected.id },
        exposure: {
          exposure_id: preview[0].exposure_id,
          skill_id: selected.id,
          source_library_id: selected.source.library_id,
          agent,
          target,
          scope: 'project',
          mode: 'native',
        },
      },
    }),
    changeAgent: (agent: string) => {
      const select = document.getElementById('task-agent') as HTMLSelectElement
      select.value = agent
      select.dispatchEvent(new Event('change'))
    },
    installed: (mode = 'native', agent = 'codex') => {
      exposures = [
        {
          ...preview[0],
          skill_id: selected.id,
          source_library_id: selected.source.library_id,
          mode,
          agent,
          status: 'current',
        },
      ]
      status.skill.exposures = [
        {
          path: preview[0].target,
          agent,
          scope: 'project',
          source_library_id: selected.source.library_id,
          source_hash: selected.content_hash,
        },
      ]
    },
    failureMessage: (message: string) => {
      failureMessage = message
    },
    actionError: (message: string) => {
      actionError = message
    },
    recovered: () => {
      records = []
    },
    pending: (record: Value) => {
      records.push(record)
    },
    show: (visible: boolean, completed = false) => {
      context = { ...context, visible }
      view.visibilityChanged({ completed })
    },
    visibility: (visible: boolean) => {
      context = { ...context, visible }
      view.contextChanged()
    },
    fail: () => {
      failure = true
    },
    projectRead: (value: boolean) => {
      projectReadable = value
    },
    connected: (value: unknown) => releaseConnection?.(value),
    hold: () => {
      hold = true
    },
    release: () => release?.(),
    holdAction: () => {
      holdAction = true
    },
    releaseAction: () => releaseAction?.(),
    target: (id: string | undefined, beforeContextChanged?: () => void) => {
      context = { ...context, workspace: id ? { ...workspace, id } : undefined }
      beforeContextChanged?.()
      view.contextChanged()
    },
    result: (value: Value) => {
      actionResult = value
    },
  }
}
