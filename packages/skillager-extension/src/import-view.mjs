import { managementCli } from './management-cli.mjs'
import { exactImportManifest, importArgs } from './import-contract.mjs'
import { sameReviewedManifest } from './review-contract.mjs'
import { bindReviewFiles } from './review-file-view.mjs'
import { readOperationReport } from './operation-report.mjs'

/** One selected external occurrence; ordinary human inspection and one acceptance decision. */
export function bindSelectedImport(document, client, ports) {
  const el = (id) => document.getElementById(`import-${id}`)
  let row,
    prepared,
    pending,
    observation,
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
  const say = (text) => {
    el('state').textContent = text
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
        void refresh()
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
          record.operation.action === 'save-and-accept' &&
          record.operation.file.path === row.path &&
          record.operation.source.id === row.skillId &&
          record.operation.workspace.id === row.workspaceId
        ) {
          pending = id
          el('result').textContent = JSON.stringify(record, null, 2)
          say(
            'Save and accept may have completed partly. Inspect this operation before trying again.',
          )
          return
        }
      }
      const input = selection(),
        result = exactImportManifest(
          await io(revision).run(importArgs(input)),
          input,
          context().workspace,
        )
      if (!available(revision)) return
      prepared = { ...result, input: { ...input, name: result.name } }
      inspect(false)
      const manifest = result.manifest
      el('destination').textContent = manifest.destination_id
      el('destination').title = `local: ${manifest.destination_path}`
      el('target').textContent = `Destination · local: ${manifest.destination_path}`
      el('effect').textContent =
        manifest.library.status === 'will-initialize'
          ? `Creates personal library ${manifest.library.git_mode === 'system' ? 'with Git history' : 'without Git history'}. Original unchanged.`
          : 'Original stays unchanged.'
      el('version').textContent =
        `${manifest.file_count} files · ${manifest.total_bytes} bytes`
      el('manifest').textContent = JSON.stringify(result.manifest, null, 2)
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
          const fresh = exactImportManifest(
            await io(revision).run(importArgs(chosen.input)),
            chosen.input,
            context().workspace,
          )
          sameReviewedManifest(chosen.manifest, fresh.manifest)
          if (!fresh.eligible) throw new Error(fresh.gate)
          if (!available(revision)) return
          submitted = true
          controls()
          const result = await client.request('actions.invoke', {
            action: 'save-and-accept',
            input: {
              ...chosen.input,
              hash: chosen.manifest.source_hash,
              token: chosen.manifest.confirmation_token,
            },
          })
          if (!available(revision)) return
          el('result').textContent = JSON.stringify(result, null, 2)
          pending = result.operationId
          prepared = undefined
          say(result.message ?? 'Inspect the exact operation result before continuing.')
        } finally {
          submitted = false
          if (available(revision)) {
            prepared = undefined
            controls()
          }
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
  on('name', 'input', invalidate)
  on('cancel', 'click', () => {
    invalidate()
    say('Save and accept cancelled. No import was requested.')
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
    select(input) {
      invalidate()
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
      if (row && available()) void refresh()
    },
    contextChanged() {
      invalidate()
      if (row && available()) void refresh()
    },
    dispose() {
      disposed = true
      invalidate()
      files.dispose()
      for (const release of listeners) release()
    },
  }
}
