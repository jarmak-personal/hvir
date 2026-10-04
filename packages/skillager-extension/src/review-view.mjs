import { managementCli } from './management-cli.mjs'
import { registeredLibrary, sameLibrary } from './management-contract.mjs'
import { acceptanceArgs } from './management-argv.mjs'
import { exactReviewManifest, sameReviewedManifest } from './review-contract.mjs'
import { readReviewFile } from './review-reading.mjs'

const TEXT_PAGE = 32 * 1024
/** Every file remains visible in the manifest; unsupported material cannot become approval. */
export function bindExactReview(document, client, ports) {
  const element = (id) => document.getElementById(id),
    releases = [],
    reviewed = new Set()
  let selection,
    activeFile,
    text = '',
    page = 0,
    pagesSeen = new Set(),
    busy = false,
    serial = 0,
    ready = false
  const io = () => managementCli(client)
  function available(revision) {
    try {
      return (
        client.alive &&
        ports.context().visible &&
        serial === revision &&
        (!selection ||
          (element('skill-id').value.trim() === selection.skillId &&
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
    ready = false
    element('accept-version').disabled = true
    element('acknowledge-file').disabled = true
  }
  function retarget() {
    invalidate()
    selection = undefined
    activeFile = undefined
    reviewed.clear()
    element('exact-review').hidden = true
    element('review-files').replaceChildren()
    element('review-file-body').replaceChildren()
  }
  function showPage() {
    pagesSeen.add(page)
    element('review-file-body').textContent = text.slice(
      page * TEXT_PAGE,
      (page + 1) * TEXT_PAGE,
    )
    const count = Math.max(1, Math.ceil(text.length / TEXT_PAGE))
    element('review-page-label').textContent =
      `Complete file: page ${page + 1} of ${count}`
    element('review-previous').disabled = page === 0
    element('review-next').disabled = page + 1 === count
    element('acknowledge-file').disabled = pagesSeen.size !== count
  }
  async function guarded(work) {
    if (busy || !ports.context().visible || !client.alive) return
    busy = true
    try {
      await work(serial)
    } catch (error) {
      invalidate()
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
    target.addEventListener('click', listener)
    releases.push(() => target.removeEventListener('click', listener))
  }
  async function read(file, revision) {
    ready = false
    element('accept-version').disabled = true
    element('acknowledge-file').disabled = true
    element('review-file-body').replaceChildren()
    element('review-file-label').textContent =
      `${file.path} · ${file.size} bytes · executable ${file.executable} · SHA-256 ${file.sha256}`
    const value = await readReviewFile(client, selection.manifest, file, () =>
      available(revision),
    )
    if (!available(revision)) return
    activeFile = file
    pagesSeen = new Set()
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
      try {
        await image.decode()
      } catch (error) {
        throw new Error(
          `${file.path}: the recognized image cannot be fully presented. Use suitable ordinary file tools and public Skillager CLI review/accept, then Refresh; acceptance is unavailable.`,
          { cause: error },
        )
      }
      if (!available(revision)) return
      element('review-page-label').textContent =
        'Complete recognized image decoded; exact byte SHA-256 and size verified'
      element('review-previous').disabled = true
      element('review-next').disabled = true
      element('acknowledge-file').disabled = false
    }
    ports.say(
      `${file.path}: complete supported bytes verified. Inspect all pages/image and explicitly acknowledge this file.`,
    )
  }
  on('start-review', async () => {
    retarget()
    const revision = serial,
      library = ports.library(),
      skillId = element('skill-id').value.trim()
    const status = await io().run(['library', 'status', skillId, '--json'])
    sameLibrary(library, registeredLibrary(status))
    if (status.skill?.id !== skillId || status.skill.status === 'missing')
      throw new Error('Select a current canonical skill to review')
    const value = await io().run(acceptanceArgs(skillId))
    const result = exactReviewManifest(value, {
      library,
      skillId,
      root: { hostId: 'local', path: status.skill.path },
      hash: status.skill.working_hash,
    })
    if (!available(revision) || element('skill-id').value.trim() !== skillId) return
    selection = {
      library,
      skillId,
      manifest: result.manifest,
      eligible: result.eligible,
      workspace: ports.context().workspace
        ? JSON.parse(JSON.stringify(ports.context().workspace))
        : undefined,
    }
    element('exact-review').hidden = false
    element('review-files').replaceChildren()
    element('review-file-body').replaceChildren()
    element('review-manifest').textContent = JSON.stringify(value, null, 2)
    element('review-version').textContent =
      `${result.manifest.library_id} · local: ${result.manifest.skill_root} · working hash ${result.manifest.working_hash} · ${result.manifest.file_count} eligible files / ${result.manifest.total_bytes} bytes. Every file and executable state is included.`
    for (const file of result.manifest.files) {
      const button = document.createElement('button')
      button.type = 'button'
      button.className = 'hvir-button'
      button.dataset.reviewPath = file.path
      button.textContent = `${file.path} · ${file.size} bytes · executable ${file.executable}`
      button.addEventListener(
        'click',
        () => void guarded((revision) => read(file, revision)),
        { signal: client.signal },
      )
      element('review-files').append(button)
    }
    ports.say(
      result.gate ??
        'Complete exact manifest loaded. Read and acknowledge every listed file; viewing does not accept it.',
    )
  })
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
  on('acknowledge-file', (revision) => {
    if (!activeFile || element('acknowledge-file').disabled || !available(revision))
      return
    reviewed.add(activeFile.path)
    const button = [...element('review-files').children].find(
      (node) => node.dataset.reviewPath === activeFile.path,
    )
    if (button)
      button.textContent = `Reviewed · ${activeFile.path} · executable ${activeFile.executable}`
    element('acknowledge-file').disabled = true
    ports.say(
      `${reviewed.size} of ${selection.manifest.file_count} complete files acknowledged. Prepare a fresh exact confirmation after all files.`,
    )
  })
  on('prepare-acceptance', async (revision) => {
    if (selection && !available(revision)) retarget()
    if (
      !selection ||
      !available(revision) ||
      reviewed.size !== selection.manifest.file_count
    )
      throw new Error(
        'Read and acknowledge every complete manifest file; omitted material cannot be accepted',
      )
    const fresh = exactReviewManifest(
      await io().run(acceptanceArgs(selection.skillId)),
      selection,
    )
    sameReviewedManifest(selection.manifest, fresh.manifest)
    if (!fresh.eligible) throw new Error(fresh.gate)
    if (!available(revision)) return
    ready = true
    element('accept-version').disabled = false
    ports.say(
      'Every file was presented and acknowledged; fresh complete manifest/token matches. Confirm acceptance of this exact version.',
    )
  })
  on('accept-version', async (revision) => {
    if (selection && !available(revision)) retarget()
    if (!ready || !selection || !available(revision))
      throw new Error('Prepare one fresh exact reviewed version before acceptance')
    ready = false
    element('accept-version').disabled = true
    await ports.action('accept-version', {
      library: selection.library,
      skillId: selection.skillId,
      hash: selection.manifest.working_hash,
      token: selection.manifest.confirmation_token,
    })
  })
  const stop = client.listen((message) => {
    if (message.kind !== 'context') return
    if (
      selection &&
      (JSON.stringify(selection.workspace) !==
        JSON.stringify(message.context.workspace) ||
        element('skill-id').value.trim() !== selection.skillId ||
        (message.context.input?.row?.id &&
          message.context.input.row.id !== selection.skillId))
    )
      retarget()
    else if (!message.context.visible) invalidate()
  })
  element('skill-id').addEventListener('input', retarget)
  releases.push(() => element('skill-id').removeEventListener('input', retarget))
  return {
    dispose() {
      invalidate()
      stop()
      for (const release of releases) release()
    },
  }
}
