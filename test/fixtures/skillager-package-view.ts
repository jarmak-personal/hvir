import { connectorOutputFixture } from './connector-output'
import { readFileSync } from 'node:fs'
import { runInNewContext } from 'node:vm'
import { buildSync } from 'esbuild'
import { vi } from 'vitest'

export function createSkillagerPackageView(view = 'library') {
  vi.useFakeTimers()
  vi.setSystemTime(0)
  const template = document.createElement('template')
  template.innerHTML = readFileSync(`packages/skillager-extension/${view}.html`, 'utf8')
  for (const node of template.content.querySelectorAll('script, link')) node.remove()
  document.body.replaceChildren(template.content.cloneNode(true))
  document.body.dataset.view = view
  let receive!: (message: unknown) => void
  const requests: Array<{ capability: string; input: Record<string, unknown> }> = [],
    calls: string[][] = [],
    outputs = new Map<string, string>(),
    errors = new Map<string, string>()
  let serial = 0,
    fail = false,
    failOn: string | undefined,
    initialized = true,
    identifier = 'library',
    root = '/library',
    canonicalIdentifier: string | undefined,
    occurrencePath = '/library/search/SKILL.md',
    supported = true,
    count = 3,
    libraryDiscoveryErrors = 0,
    initialization: unknown,
    hold = false,
    holdOn: string | undefined,
    expiredCursors = false,
    cursorError = 'stale_cursor',
    failRestart = false,
    frequency = false,
    unapproved = undefined as 'unapproved' | 'executable-changed' | undefined,
    projectApproved = true,
    projectReadable = true,
    libraryApproved = true,
    version = '0.9.3',
    projectInventory: unknown,
    projectImportInventory: unknown,
    sourceGroupsSupported = true,
    projectScopeSupported = true,
    projectQuerySupported = true,
    unavailableProject = false,
    currentWorkspace: { root?: { path?: string } } | undefined,
    resume: ((error?: string) => void) | undefined,
    finishConnection: ((value: unknown, error?: string) => void) | undefined,
    finishTrash: ((value: unknown, error?: string) => void) | undefined
  const native = connectorOutputFixture()
  const opened: Record<string, unknown>[] = []
  const initializationRequests: Record<string, unknown>[] = []
  const send = (message: {
    kind: string
    id: string
    capability: string
    input: Record<string, unknown>
  }) => {
    if (message.kind === 'hello') {
      receive({ kind: 'hello', capabilities: ['connector.connect'] })
      return
    }
    if (message.kind !== 'request') return
    requests.push({ capability: message.capability, input: message.input })
    let value: unknown
    if (message.capability === 'viewer.open-own') opened.push(message.input)
    if (message.capability === 'source.request-trash') {
      finishTrash = (value, error) =>
        receive({ kind: 'result', id: message.id, ok: !error, value, error })
      return
    }
    if (message.capability === 'actions.invoke') {
      initializationRequests.push(message.input)
      if (initialization) {
        initialized = true
        count = 0
      }
      receive({
        kind: 'result',
        id: message.id,
        ok: true,
        value: initialization ?? {
          outcome: 'uncertain',
          message: 'Creation did not settle; no ready state claimed.',
        },
      })
      return
    }
    if (message.capability === 'connector.connect') {
      finishConnection = (value, error) => {
        if (
          (
            value as { connections?: { connector: string; outcome: string }[] }
          )?.connections?.some(
            (entry) => entry.connector === 'project-cli' && entry.outcome === 'connected',
          )
        )
          projectApproved = true
        receive({ kind: 'result', id: message.id, ok: !error, value, error })
      }
      return
    }
    if (message.capability === 'connector.execute') {
      const args = message.input.args as string[]
      calls.push(args)
      if (
        unapproved ||
        (message.input.connector === 'project-cli' && !projectApproved) ||
        (message.input.connector === 'library-cli' && !libraryApproved)
      ) {
        value = { outcome: 'not-started', reason: unapproved ?? 'unapproved' }
        unapproved = undefined
      } else if (frequency) {
        frequency = false
        value = { outcome: 'not-started', reason: 'frequency', retryAfterMs: 250 }
      } else if (
        (!projectScopeSupported ||
          (!projectQuerySupported && args.includes('--query'))) &&
        args[0] === 'list' &&
        args[args.indexOf('--scope') + 1] === 'project'
      ) {
        const receipt = String(++serial)
        outputs.set(receipt, '')
        errors.set(
          receipt,
          projectScopeSupported
            ? 'skillager: error: unrecognized arguments: --query example'
            : `usage: skillager list ${'options '.repeat(60)}\nskillager list: error: argument --scope: invalid choice: 'project' (choose from 'workspace', 'library')`,
        )
        value = native.complete(
          { outcome: 'completed', code: 2, receipt },
          outputs.get(receipt)!,
          errors.get(receipt),
        )
      } else if (
        unavailableProject &&
        args[0] === 'list' &&
        args[args.indexOf('--scope') + 1] === 'project'
      ) {
        const receipt = String(++serial)
        outputs.set(
          receipt,
          JSON.stringify({
            schema: 'skillager.list.v1',
            scope: 'project',
            project_root: currentWorkspace?.root?.path,
            observation: {
              status: 'unavailable',
              errors: [
                { code: 'project-unavailable', path: currentWorkspace?.root?.path },
              ],
              error_count: 1,
            },
            skills: [],
            next_cursor: null,
          }),
        )
        errors.set(receipt, 'The selected project could not be observed.')
        value = native.complete(
          { outcome: 'completed', code: 2, receipt },
          outputs.get(receipt)!,
          errors.get(receipt),
        )
      } else if (!sourceGroupsSupported && args.includes('--group-by')) {
        const receipt = String(++serial)
        value = native.complete(
          { outcome: 'completed', code: 2, receipt },
          '',
          'skillager: error: unrecognized arguments: --group-by source',
        )
      } else if (fail && (!failOn || args[0] === failOn)) {
        fail = false
        value = { outcome: 'failed', code: 1 }
      } else if (
        expiredCursors &&
        ['list', 'search'].includes(args[0]!) &&
        ((args.includes('--cursor') && args[args.indexOf('--cursor') + 1]) || failRestart)
      ) {
        const receipt = String(++serial)
        outputs.set(
          receipt,
          JSON.stringify({
            schema: 'skillager.error.v1',
            error: {
              code: cursorError,
              message: 'inventory changed; restart from the first page',
            },
          }),
        )
        errors.set(receipt, 'Pagination cursor no longer matches the current library')
        value = native.complete(
          {
            outcome: 'completed',
            code: cursorError === 'stale_cursor' ? 15 : 2,
            receipt,
          },
          outputs.get(receipt)!,
          errors.get(receipt),
        )
      } else {
        const receipt = String(++serial),
          cursor = args[args.indexOf('--cursor') + 1]
        const sourceId = args.includes('--source-group')
          ? args[args.indexOf('--source-group') + 1]
          : undefined
        const index = sourceId
          ? sourceId.charCodeAt(7) - 97
          : args.includes('--cursor') && cursor
            ? Number(cursor)
            : 0
        const sourceGroup = {
          id: `source:${String.fromCharCode(97 + index).repeat(64)}`,
          label: `Page ${index}`,
          kind: 'project',
          detail: `/sources/${index}`,
        }
        const text =
          args[0] === '--version'
            ? `skillager ${version}`
            : JSON.stringify(
                args[0] === 'import-project'
                  ? (projectImportInventory ?? { schema: 'unsupported' })
                  : args[0] === 'library'
                    ? {
                        schema: supported ? 'skillager.library-status.v1' : 'old-status',
                        initialized,
                        library: {
                          registration: 'valid',
                          library_id: identifier,
                          root,
                        },
                        counts: { skills: count },
                      }
                    : args[0] === 'search'
                      ? {
                          schema: 'skillager.search.v1',
                          status: 'completed',
                          results: [
                            {
                              id: 'lib/search',
                              source_group: sourceGroup,
                              search: {
                                ...(canonicalIdentifier
                                  ? {
                                      canonical: {
                                        library_id: canonicalIdentifier,
                                        skill_id: 'lib/search',
                                      },
                                    }
                                  : {}),
                                occurrence: {
                                  id: `search-${index}`,
                                  kind: 'library',
                                  entrypoint: occurrencePath,
                                },
                              },
                            },
                          ],
                          next_cursor: index < 2 ? String(index + 1) : null,
                        }
                      : args[0] === 'list' &&
                          args[args.indexOf('--scope') + 1] === 'project'
                        ? (projectInventory ?? {
                            schema: 'skillager.list.v1',
                            scope: 'project',
                            project_root: currentWorkspace?.root?.path,
                            observation: {
                              status: 'complete',
                              errors: [],
                              error_count: 0,
                            },
                            skills: [],
                            next_cursor: null,
                          })
                        : args.includes('--group-by')
                          ? {
                              schema: 'skillager.library-groups.v1',
                              scope: 'library',
                              groups: count ? [{ ...sourceGroup, count: 1 }] : [],
                              total_skills: count,
                              total_groups: count,
                              discovery_error_count: libraryDiscoveryErrors,
                              next_cursor: count && index < 2 ? String(index + 1) : null,
                            }
                          : args[0] === 'review'
                            ? { selected: [], action: { changed: [] } }
                            : args[0] === 'expose'
                              ? { schema: 'skillager.exposures.v1', exposures: [] }
                              : {
                                  schema: 'skillager.list.v1',
                                  scope: 'library',
                                  total_skills: sourceId ? 1 : count,
                                  skills: count
                                    ? [
                                        {
                                          id: `lib/${index}`,
                                          source_group: sourceGroup,
                                          name: `Page ${index}`,
                                          description: '',
                                          status: 'pending',
                                          skill_file: `${root}/${index}/SKILL.md`,
                                        },
                                      ]
                                    : [],
                                  next_cursor:
                                    !sourceId && count && index < 2
                                      ? String(index + 1)
                                      : null,
                                },
              )
        outputs.set(receipt, text)
        value = native.complete(
          { outcome: 'completed', code: 0, receipt },
          outputs.get(receipt)!,
          errors.get(receipt),
        )
      }
    } else if (message.capability === 'connector.output') {
      value = native.read(message.input)
    } else if (message.capability === 'source.status') {
      value = [{ source: 'project', granted: projectReadable }]
    } else {
      value = null
    }
    const reply = () => receive({ kind: 'result', id: message.id, ok: true, value })
    if (
      hold &&
      message.capability === 'connector.execute' &&
      (!holdOn || (message.input.args as string[])[0] === holdOn)
    ) {
      hold = false
      resume = (error) =>
        error ? receive({ kind: 'result', id: message.id, ok: false, error }) : reply()
    } else reply()
  }
  const bridge = {
    onMessage: (callback: typeof receive) => {
      receive = callback
      return () => {}
    },
    send,
  }
  const ui = {
    bindPresentation: () => () => {},
    bindList: () => ({ refresh() {}, dispose() {} }),
  }
  const browser = Object.create(window) as Window & {
    hvirExtension: unknown
    hvirUI: unknown
  }
  browser.hvirExtension = bridge
  browser.hvirUI = ui
  browser.setTimeout = setTimeout
  browser.clearTimeout = clearTimeout
  const disposeListeners: (() => void)[] = []
  browser.addEventListener = ((name: string, listener: () => void) => {
    if (name === 'pagehide') disposeListeners.push(listener)
  }) as typeof window.addEventListener
  const bundle = buildSync({
    entryPoints: ['packages/skillager-extension/src/app.mjs'],
    bundle: true,
    format: 'iife',
    write: false,
  })
  runInNewContext(bundle.outputFiles[0]!.text, {
    window: browser,
    document,
    Date,
    performance,
    AbortController,
    TextEncoder,
    setTimeout,
    clearTimeout,
  })
  const dispose = () => disposeListeners.forEach((listener) => listener())
  const context = (visible = true, workspace?: unknown) => {
    currentWorkspace = workspace as typeof currentWorkspace
    receive({ kind: 'context', context: { visible, workspace } })
  }
  const button = (id: string) => document.getElementById(id) as HTMLButtonElement
  const flush = () => vi.advanceTimersByTimeAsync(1500)
  return {
    projectRead: (value: boolean) => {
      projectReadable = value
    },
    dispose,
    context,
    projectApproval: (approved: boolean) => {
      projectApproved = approved
    },
    libraryApproval: (approved: boolean) => {
      libraryApproved = approved
    },
    version: (value: string) => {
      version = value
    },
    projectInventory: (value: unknown) => {
      projectInventory = value
    },
    projectImportInventory: (value: unknown) => {
      projectImportInventory = value
    },
    unavailableProject: () => {
      unavailableProject = true
    },
    libraryDiscoveryErrors: (count: number) => {
      libraryDiscoveryErrors = count
    },
    unsupportedSourceGroups: () => {
      sourceGroupsSupported = false
    },
    unsupportedProjectQuery: () => {
      projectQuerySupported = false
    },
    unsupportedProjectScope: () => {
      projectScopeSupported = false
    },
    capabilities: (capabilities: string[]) => receive({ kind: 'hello', capabilities }),
    requests,
    trashResult: (value: unknown, error?: string) => finishTrash?.(value, error),
    button,
    flush,
    expand: async () => {
      document
        .querySelector<HTMLButtonElement>(
          '#skills [data-source-toggle][aria-expanded=false]',
        )
        ?.click()
      await flush()
    },
    calls,
    unapproved: (reason: 'unapproved' | 'executable-changed' = 'unapproved') => {
      unapproved = reason
    },
    fail: (command?: string) => {
      fail = true
      failOn = command
    },
    initializationRequests,
    opened,
    initialize: (result: unknown) => {
      initialization = result
    },
    searchPath: (path: string) => {
      occurrencePath = path
    },
    identities: (current: string, observed = current) => {
      identifier = current
      canonicalIdentifier = observed
    },
    libraryRoot: (value: string) => {
      root = value
    },
    staleCursors: (code = 'stale_cursor', firstPageAlsoFails = false) => {
      expiredCursors = true
      cursorError = code
      failRestart = firstPageAlsoFails
    },
    uninitialized: () => {
      initialized = false
    },
    unsupported: () => {
      supported = false
    },
    empty: () => {
      count = 0
    },
    hold: (command?: string) => {
      hold = true
      holdOn = command
    },
    frequency: () => {
      frequency = true
    },
    resume: (error?: string) => resume?.(error),
    connected: (value: unknown) => finishConnection?.(value),
    connectionFailed: () => finishConnection?.(undefined, 'Old connection failed'),
  }
}
