import { managementCli } from './management-cli.mjs'
import { registeredLibrary, sameLibrary } from './management-contract.mjs'
import { acceptanceArgs } from './management-argv.mjs'
import { exactReviewManifest, sameReviewedManifest } from './review-contract.mjs'
import { readReviewFile } from './review-reading.mjs'

const TEXT_PAGE = 32 * 1024
/** Inspection is optional; the complete manifest and CLI token bind one human decision. */
export function bindExactReview(document, client, ports) {
  const element = (id) => document.getElementById(id),
    releases = []
  let selection,
    activeFile,
    text = '',
    page = 0,
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
    activeFile = undefined
    element('accept-version').disabled = true
    element('exact-review').hidden = true
    element('review-files').replaceChildren()
    element('review-file-body').replaceChildren()
  }
  function showPage() {
    element('review-file-body').textContent = text.slice(
      page * TEXT_PAGE,
      (page + 1) * TEXT_PAGE,
    )
    const count = Math.max(1, Math.ceil(text.length / TEXT_PAGE))
    element('review-page-label').textContent = `Page ${page + 1} of ${count}`
    element('review-previous').disabled = page === 0
    element('review-next').disabled = page + 1 === count
  }
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
  async function read(file, revision) {
    element('review-file-body').replaceChildren()
    element('review-file-label').textContent =
      `${file.path} · ${file.size} bytes${file.executable ? ' · executable' : ''}`
    const decision = await client.request('source.request', {
      source: 'library',
      root: selection.library.root,
    })
    if (!available(revision)) return
    if (!decision.granted)
      throw new Error(
        'Read access was not granted. The version remains available to review.',
      )
    try {
      const value = await readReviewFile(client, selection.manifest, file, () =>
        available(revision),
      )
      if (!available(revision)) return
      activeFile = file
      page = 0
      if (value.kind === 'text') {
        text = value.text
        showPage()
      } else {
        text = ''
        const image = document.createElement('img')
        image.alt = file.path
        image.src = value.data
        element('review-file-body').replaceChildren(image)
        await image.decode()
        if (!available(revision)) return
        element('review-page-label').textContent = 'Image · complete bytes verified'
        element('review-previous').disabled = true
        element('review-next').disabled = true
      }
      ports.say(`${file.path} · complete supported bytes verified`)
    } catch (error) {
      if (!available(revision)) return
      element('review-file-body').textContent = `Preview unavailable. ${error.message}`
      element('review-page-label').textContent = ''
      element('review-previous').disabled = true
      element('review-next').disabled = true
      ports.say(
        'This file remains in the version. Inspect it with suitable file tools; Skillager determines acceptance eligibility.',
      )
    }
  }
  async function start() {
    invalidate()
    const revision = serial,
      library = ports.library(),
      id = skillId()
    const status = await io().run(['library', 'status', id, '--json'])
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
      `${result.manifest.file_count} files · ${result.manifest.total_bytes} bytes · version ${result.manifest.working_hash.slice(0, 12)}`
    for (const file of result.manifest.files) {
      const row = document.createElement('div'),
        button = document.createElement('button'),
        metadata = document.createElement('span')
      row.className = 'review-file-row'
      button.type = 'button'
      button.className = 'hvir-button'
      button.dataset.reviewPath = file.path
      button.textContent = file.path
      metadata.className = 'hvir-meta'
      metadata.textContent = `${file.size} bytes${file.executable ? ' · executable' : ''}`
      button.title = `SHA-256 ${file.sha256}`
      button.addEventListener(
        'click',
        () => void guarded((revision) => read(file, revision)),
        { signal: client.signal },
      )
      row.append(button, metadata)
      element('review-files').append(row)
    }
    element('accept-version').disabled = !result.eligible
    ports.say(
      result.gate ?? 'Inspect any file, then accept this version when you are ready.',
    )
  }
  on('start-review', start)
  on('review-previous', () => {
    if (activeFile && text && page > 0) {
      page--
      showPage()
    }
  })
  on('review-next', () => {
    if (activeFile && text && (page + 1) * TEXT_PAGE < text.length) {
      page++
      showPage()
    }
  })
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
      stop()
      element('skill-id')?.removeEventListener('input', invalidate)
      for (const release of releases) release()
    },
  }
}
