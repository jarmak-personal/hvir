import { readReviewFile } from './review-reading.mjs'

const TEXT_PAGE = 32 * 1024
/** Shared optional inspection of a complete public file manifest through confined reads. */
export function bindReviewFiles(document, client, ports) {
  const el = (suffix) => document.getElementById(`${ports.prefix}-${suffix}`)
  let serial = 0,
    busy = false,
    text = '',
    page = 0
  const listeners = []
  const current = (revision) => client.alive && serial === revision && ports.available()
  function reset() {
    serial++
    el('files').replaceChildren()
    clearPreview()
  }
  function clearPreview() {
    text = ''
    page = 0
    el('file-body').replaceChildren()
    el('file-label').textContent = ''
    el('page-label').textContent = ''
    if (el('pages')) el('pages').hidden = true
    el('previous').disabled = el('next').disabled = true
  }
  function showPage() {
    el('file-body').textContent = text.slice(page * TEXT_PAGE, (page + 1) * TEXT_PAGE)
    const count = Math.max(1, Math.ceil(text.length / TEXT_PAGE))
    el('page-label').textContent = count > 1 ? `Page ${page + 1} of ${count}` : ''
    if (el('pages')) el('pages').hidden = count === 1
    el('previous').disabled = page === 0
    el('next').disabled = page + 1 === count
  }
  async function read(file) {
    if (busy || !ports.available()) return
    const revision = serial,
      tree = ports.tree()
    busy = true
    clearPreview()
    el('file-label').textContent =
      `${file.path} · ${file.size} bytes${file.executable ? ' · executable' : ''}`
    try {
      const decision = await ports.readAccess()
      if (!current(revision)) return
      if (!decision.granted)
        throw new Error(
          'Read access was not granted. The version remains available to review.',
        )
      const value = await readReviewFile(client, tree, file, () => current(revision))
      if (!current(revision)) return
      page = 0
      if (value.kind === 'text') {
        text = value.text
        showPage()
      } else {
        text = ''
        const image = document.createElement('img')
        image.alt = file.path
        image.src = value.data
        el('file-body').replaceChildren(image)
        await image.decode()
        if (!current(revision)) return
        el('page-label').textContent = ''
        if (el('pages')) el('pages').hidden = true
        el('previous').disabled = el('next').disabled = true
      }
      ports.say('')
    } catch (error) {
      if (!current(revision)) return
      el('file-body').textContent = `Preview unavailable. ${error.message}`
      if (el('pages')) el('pages').hidden = true
      ports.say(
        'This file remains in the version. Inspect it with suitable file tools; Skillager determines acceptance eligibility.',
      )
    } finally {
      busy = false
    }
  }
  for (const [id, delta] of [
    ['previous', -1],
    ['next', 1],
  ]) {
    const button = el(id),
      listener = () => {
        if (
          !busy &&
          current(serial) &&
          text &&
          page + delta >= 0 &&
          (page + delta) * TEXT_PAGE < text.length
        ) {
          page += delta
          showPage()
        }
      }
    button.addEventListener('click', listener)
    listeners.push(() => button.removeEventListener('click', listener))
  }
  return {
    reset,
    show(files) {
      reset()
      for (const file of files) {
        const row = document.createElement('div'),
          button = document.createElement('button'),
          metadata = document.createElement('span')
        row.className = 'review-file-row'
        button.type = 'button'
        button.className = 'hvir-button'
        button.dataset.reviewPath = file.path
        button.textContent = file.path
        button.title = `SHA-256 ${file.sha256}`
        metadata.className = 'hvir-meta'
        metadata.textContent = `${file.size} bytes${file.executable ? ' · executable' : ''}`
        button.addEventListener('click', () => void read(file))
        row.append(button, metadata)
        el('files').append(row)
      }
    },
    dispose() {
      reset()
      for (const release of listeners) release()
    },
  }
}
