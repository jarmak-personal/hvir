import { managementCli } from './management-cli.mjs'
import { registeredLibrary, sameLibrary } from './management-contract.mjs'
import { acceptanceArgs } from './management-argv.mjs'
import { exactReviewManifest, sameReviewedManifest } from './review-contract.mjs'
import { bindReviewFiles } from './review-file-view.mjs'

/** Inspection is optional; the complete manifest and CLI token bind one human decision. */
export function bindExactReview(document, client, ports) {
  const element = (id) => document.getElementById(id),
    releases = []
  let selection,
    busy = false,
    serial = 0
  const skillId = () => ports.skillId?.() ?? element('skill-id').value.trim()
  const io = () => managementCli(client)
  function available(revision) {
    try {
      return (
        client.alive &&
        ports.context().visible &&
        serial === revision &&
        (!selection ||
          (skillId() === selection.skillId &&
            JSON.stringify(selection.workspace) ===
              JSON.stringify(ports.context().workspace) &&
            (sameLibrary(selection.library, ports.library()), true)))
      )
    } catch {
      return false
    }
  }
  function invalidate() {
    serial++
    selection = undefined
    element('accept-version').disabled = true
    element('exact-review').hidden = true
    files.reset()
  }
  const files = bindReviewFiles(document, client, {
    prefix: 'review',
    available: () => available(serial),
    say: ports.say,
    tree: () => ({
      source: 'library',
      root: { hostId: 'local', path: selection.manifest.skill_root },
      files: selection.manifest.files,
    }),
    readAccess: () =>
      client.request('source.request', {
        source: 'library',
        root: selection.library.root,
      }),
  })
  async function guarded(work) {
    if (busy || !ports.context().visible || !client.alive) return
    busy = true
    const revision = serial,
      identity = JSON.stringify([skillId(), ports.context().workspace])
    try {
      await work(revision)
    } catch (error) {
      if (
        client.alive &&
        ports.context().visible &&
        identity === JSON.stringify([skillId(), ports.context().workspace])
      )
        ports.say(error.message)
    } finally {
      busy = false
    }
  }
  function on(id, callback) {
    const target = element(id),
      listener = () => {
        void guarded(callback)
      }
    target?.addEventListener('click', listener)
    releases.push(() => target?.removeEventListener('click', listener))
  }
  async function start() {
    invalidate()
    const revision = serial,
      library = ports.library(),
      id = skillId()
    const status = await io().run(['library', 'status', id, '--json'])
    if (!available(revision) || skillId() !== id) return
    sameLibrary(library, registeredLibrary(status))
    if (status.skill?.id !== id || status.skill.status === 'missing')
      throw new Error('Select a current canonical skill to review')
    const value = await io().run(acceptanceArgs(id))
    const result = exactReviewManifest(value, {
      library,
      skillId: id,
      root: { hostId: 'local', path: status.skill.path },
      hash: status.skill.working_hash,
    })
    if (!available(revision) || skillId() !== id) return
    selection = {
      library,
      skillId: id,
      manifest: result.manifest,
      eligible: result.eligible,
      workspace: ports.context().workspace
        ? JSON.parse(JSON.stringify(ports.context().workspace))
        : undefined,
    }
    element('exact-review').hidden = false
    element('review-manifest').textContent = JSON.stringify(value, null, 2)
    element('review-version').textContent =
      `${result.manifest.file_count} ${result.manifest.file_count === 1 ? 'file' : 'files'} · ${result.manifest.total_bytes} bytes`
    files.show(result.manifest.files)
    element('accept-version').disabled = !result.eligible
    ports.say(result.gate ?? '')
  }
  on('start-review', start)
  on('cancel-review', invalidate)
  on('accept-version', async (revision) => {
    if (!selection?.eligible || !available(revision)) {
      invalidate()
      throw new Error('Review the current version before acceptance')
    }
    const chosen = selection
    element('accept-version').disabled = true
    try {
      const fresh = exactReviewManifest(
        await io().run(acceptanceArgs(chosen.skillId)),
        chosen,
      )
      sameReviewedManifest(chosen.manifest, fresh.manifest)
      if (!fresh.eligible) throw new Error(fresh.gate)
      if (!available(revision)) return
      const result = await ports.action('accept-version', {
        library: chosen.library,
        skillId: chosen.skillId,
        hash: chosen.manifest.working_hash,
        token: chosen.manifest.confirmation_token,
      })
      if (available(revision) && result?.outcome === 'verified') {
        invalidate()
        ports.accepted?.(result)
      }
    } catch (error) {
      invalidate()
      throw error
    }
  })
  const stop = client.listen((message) => {
    const row = message.context?.input?.row
    if (
      message.kind === 'context' &&
      selection &&
      (!message.context.visible ||
        JSON.stringify(selection.workspace) !==
          JSON.stringify(message.context.workspace) ||
        skillId() !== selection.skillId ||
        (row &&
          ((row.canonical?.skill_id ?? row.id) !== selection.skillId ||
            (row.canonical?.library_id &&
              row.canonical.library_id !== selection.library.id))))
    )
      invalidate()
  })
  element('skill-id')?.addEventListener('input', invalidate)
  return {
    start: () => guarded(start),
    invalidate,
    dispose() {
      invalidate()
      files.dispose()
      stop()
      element('skill-id')?.removeEventListener('input', invalidate)
      for (const release of releases) release()
    },
  }
}
