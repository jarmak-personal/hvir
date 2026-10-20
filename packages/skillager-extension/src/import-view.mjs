import { mountSkillTasks } from './skill-task-template.mjs'
import { managementCli } from './management-cli.mjs'
import { exactImportManifest, importArgs } from './import-contract.mjs'
import { sameReviewedManifest } from './review-contract.mjs'
import { prepareImportPlacement } from './import-placement-contract.mjs'
import { bindReviewFiles } from './review-file-view.mjs'
import { readOperationReport } from './operation-report.mjs'

/** One selected external occurrence; ordinary human inspection and one acceptance decision. */
export function bindSelectedImport(document, client, ports) {
  mountSkillTasks(document)
  const el = (id) => document.getElementById(`import-${id}`)
  let row,
    prepared,
    pending,
    observation,
    preservation,
    mode,
    message = '',
    serial = 0,
    busy = false,
    submitted = false,
    disposed = false,
    refreshQueued = false
  const context = ports.context
  const available = (revision = serial) =>
    !disposed &&
    client.alive &&
    context().visible &&
    serial === revision &&
    row?.host === 'local' &&
    row.workspaceId === context().workspace?.id &&
    context().workspace?.host === 'local'
  const saved = () =>
    !mode && preservation && !el('name').value.trim() && !pending && !submitted
  const say = (text) => {
    message = text
    el('state').textContent = saved() ? '' : text
  }
  const files = bindReviewFiles(document, client, {
    prefix: 'import',
    available: () => available() && !!prepared,
    say: (text) => {
      el('file-state').textContent = text
      el('file-navigation').scrollIntoView({ block: 'start' })
    },
    tree: () => ({
      source: 'project',
      workspaceId: row.workspaceId,
      root: { hostId: 'local', path: prepared.manifest.source_root },
      files: prepared.manifest.files,
    }),
    readAccess: () =>
      client.request('source.request', {
        source: 'project',
      }),
  })
  function controls() {
    ports.activity?.(submitted)
    if (disposed) return
    document
      .getElementById('selected-import')
      .setAttribute('aria-busy', String(busy || submitted))
    const manifest = prepared?.manifest
    el('save').textContent = submitted
      ? 'Saving…'
      : busy
        ? 'Preparing…'
        : mode
          ? `Save and use ${mode === 'stub' ? 'Stub' : 'Full'}`
          : 'Save and accept'
    el('replacement').hidden = !prepared?.value
    el('save').hidden = !!saved()
    el('options').hidden = !!saved()
    el('inspect').hidden = !!saved() && !prepared
    el('destination').textContent = saved()
      ? 'Saved in library'
      : (manifest?.destination_id ?? '')
    el('destination').title = saved()
      ? preservation.sources
          .map((source) => `${source.library_id} · ${source.skill_id}`)
          .join('\n')
      : manifest
        ? `local: ${manifest.destination_path}`
        : ''
    const initialization =
      manifest?.library.status === 'will-initialize'
        ? `${manifest.library.library_id ? 'Reconnects' : 'Creates'} your personal library ${manifest.library.git_mode === 'system' ? 'with Git history' : 'without Git history'}. `
        : ''
    el('effect').textContent = saved()
      ? 'Original unchanged.'
      : manifest
        ? mode
          ? `${initialization}Saves in your library and replaces this project original with ${mode === 'stub' ? 'Stub' : 'Full'} for ${row.agent === 'claude' ? 'Claude' : 'Codex'}.`
          : `${initialization}Original stays unchanged.`
        : ''
    el('state').textContent = saved() ? '' : message
    el('save').disabled =
      busy || submitted || !available() || !prepared?.eligible || !!pending
    el('refresh').disabled = busy || submitted
    el('name').disabled = busy || submitted
    el('cancel').disabled = submitted
    el('use-library').disabled = busy || submitted
    el('reconcile').hidden = !pending
    el('reconcile').disabled = busy || submitted
    el('reconcile').textContent = observation
      ? 'Acknowledge current facts'
      : 'Inspect uncertain operation'
  }
  function inspect(open) {
    el('inspection').hidden = !open
    el('inspect').setAttribute('aria-expanded', String(open))
    el('inspect').textContent = open
      ? 'Close files'
      : `Inspect files${prepared ? ` (${prepared.manifest.file_count})` : ''}`
  }
  function invalidate() {
    serial++
    prepared = undefined
    observation = undefined
    files.reset()
    inspect(false)
    el('file-state').textContent = ''
    controls()
  }
  const scoped = (revision) => ({
    get alive() {
      return available(revision)
    },
    get visible() {
      return context().visible
    },
    delay: (ms) => client.delay(ms),
    request: (capability, input) => {
      if (!(capability === 'connector.output' && input.release) && !available(revision))
        throw new Error('The selected original or workspace changed')
      return client.request(capability, input)
    },
  })
  const io = (revision) => managementCli(scoped(revision), context())
  function selection() {
    return {
      skillId: row.skillId,
      file: { hostId: 'local', path: row.path },
      ...(mode ? { mode, agent: row.agent } : {}),
      ...(el('name').value.trim() ? { name: el('name').value.trim() } : {}),
    }
  }
  async function guard(work) {
    if (busy || submitted || !available()) return
    busy = true
    const revision = serial
    controls()
    try {
      await work(revision)
    } catch (error) {
      if (available(revision)) say(error.message)
    } finally {
      busy = false
      controls()
      if (refreshQueued && available()) {
        refreshQueued = false
        if (!pending) void refresh()
      }
    }
  }
  async function refresh() {
    if (busy || submitted) {
      refreshQueued = true
      return
    }
    invalidate()
    await guard(async (revision) => {
      say('Checking the selected original…')
      pending = undefined
      const records = await client.request('actions.invoke', {
        action: 'operation-state',
        input: { mode: 'list' },
      })
      for (const id of records.ids ?? []) {
        const record = await readOperationReport(client, id)
        if (!available(revision)) return
        if (
          ['save-and-accept', 'save-and-use-copy'].includes(record.operation.action) &&
          record.operation.file.path === row.path &&
          record.operation.source.id === row.skillId &&
          record.operation.workspace.id === row.workspaceId
        ) {
          pending = id
          el('result').textContent = JSON.stringify(record, null, 2)
          say('This operation may have completed partly. Inspect it before trying again.')
          return
        }
      }
      const input = selection(),
        result = mode
          ? await prepareImportPlacement(io(revision), input, context().workspace)
          : exactImportManifest(
              await io(revision).run(importArgs(input)),
              input,
              context().workspace,
            )
      if (!available(revision)) return
      prepared = { ...result, input: { ...input, name: result.name } }
      inspect(false)
      const manifest = result.manifest
      el('target').textContent = `Destination · local: ${manifest.destination_path}`
      el('version').textContent =
        `${manifest.file_count} files · ${manifest.total_bytes} bytes`
      el('manifest').textContent = JSON.stringify(
        result.value ?? result.manifest,
        null,
        2,
      )
      el('effects').replaceChildren(
        ...(result.value?.replacement.targets ?? []).flatMap((target) =>
          target.file_effects
            .filter((effect) => effect.action !== 'keep')
            .map((effect) => {
              const item = document.createElement('li')
              item.textContent = `${effect.action} · ${target.path}${effect.path === '.' ? '' : '/' + effect.path}`
              return item
            }),
        ),
      )
      files.show(manifest.files)
      say(result.gate ?? '')
    })
  }
  const listeners = []
  function on(id, type, callback) {
    const target = el(id)
    target.addEventListener(type, callback)
    listeners.push(() => target.removeEventListener(type, callback))
  }
  on(
    'save',
    'click',
    () =>
      void guard(async (revision) => {
        if (!prepared?.eligible || pending) return
        const chosen = prepared
        el('save').disabled = true
        try {
          if (!mode) {
            const fresh = exactImportManifest(
              await io(revision).run(importArgs(chosen.input)),
              chosen.input,
              context().workspace,
            )
            sameReviewedManifest(chosen.manifest, fresh.manifest)
            if (!fresh.eligible) throw new Error(fresh.gate)
          }
          if (!available(revision)) return
          const origin = context().workspace,
            original = row,
            selected = () =>
              !disposed &&
              row === original &&
              JSON.stringify(origin) === JSON.stringify(context().workspace)
          submitted = true
          say('Saving…')
          controls()
          const result = await client
            .request('actions.invoke', {
              action: mode ? 'save-and-use-copy' : 'save-and-accept',
              input: {
                ...chosen.input,
                hash: chosen.manifest.source_hash,
                token:
                  chosen.value?.confirmation_token ?? chosen.manifest.confirmation_token,
              },
            })
            .catch((error) => {
              // Definite message-only refusals use the public action error boundary.
              // Notify the origin to reobserve without inventing completion facts.
              ports.changed?.(undefined, origin, error)
              if (selected()) say(error.message)
              throw error
            })
          ports.changed?.(result, origin)
          if (!selected()) return
          el('result').textContent = JSON.stringify(result, null, 2)
          if (['verified', 'saved-not-replaced'].includes(result.outcome)) {
            el('name').value = ''
          }
          pending = result.operationId
          prepared = undefined
          say(result.message ?? 'Inspect the exact operation result before continuing.')
        } finally {
          submitted = false
          if (available(revision)) prepared = undefined
          controls()
        }
      }),
  )
  on('inspect', 'click', () => inspect(el('inspection').hidden))
  on('use-library', 'click', () => {
    if (!busy && !submitted) ports.useLibrary?.()
  })
  on('all-files', 'click', () => {
    el('inspection').scrollTop = 0
    el('files').querySelector('button')?.focus({ preventScroll: true })
  })
  on('refresh', 'click', () => void refresh())
  on('name', 'input', () => {
    message = ''
    invalidate()
  })
  on('cancel', 'click', () => {
    invalidate()
    say('Cancelled. No save or replacement was requested.')
  })
  on(
    'reconcile',
    'click',
    () =>
      void guard(async (revision) => {
        if (!pending) return
        const result = await client.request('actions.invoke', {
          action: 'operation-state',
          input: {
            mode: observation ? 'acknowledge' : 'observe',
            operationId: pending,
            ...(observation ? { observation } : {}),
          },
        })
        if (!available(revision)) return
        el('result').textContent = JSON.stringify(result, null, 2)
        el('operation-details').open = true
        say(result.message)
        observation = result.outcome === 'observed' ? result.observation : undefined
        if (result.outcome === 'reconciled') pending = undefined
      }),
  )
  return {
    // Presentation only: exact validated public preservation never approves an import.
    preserved(value) {
      preservation =
        row && value?.file.hostId === row.host && value.file.path === row.path
          ? value
          : undefined
      controls()
    },
    select(input, options = {}) {
      mode = options.mode
      if (mode !== undefined && !['native', 'stub'].includes(mode))
        throw new Error('Choose Full or Stub')
      invalidate()
      preservation = undefined
      message = ''
      row =
        input?.row.source === 'project' && input.row.kind === 'Project original'
          ? input.row
          : undefined
      document.getElementById('selected-import').hidden = !row
      el('use-library').hidden = !row?.canonical?.skill_id
      pending = undefined
      el('result').textContent = ''
      el('name').value = ''
      el('destination').title = ''
      el('destination').textContent =
        el('target').textContent =
        el('effect').textContent =
        el('version').textContent =
          ''
      if (row && available() && options.prepare !== false) return refresh()
      else controls()
    },
    contextChanged() {
      preservation = undefined
      invalidate()
      if (row && available()) void refresh()
    },
    visibilityChanged() {
      preservation = undefined
      invalidate()
      // Retain an admitted operation's result and recovery identity across hiding.
      if (row && available() && !pending) void refresh()
    },
    dispose() {
      disposed = true
      invalidate()
      files.dispose()
      for (const release of listeners) release()
    },
  }
}
