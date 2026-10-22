export async function sourcePages(client, receipt, signal) {
  let text = '',
    offset = 0
  for (;;) {
    const page = await client.request('source.read', { receipt, offset }, signal)
    text += page.data
    if (text.length > 3 * 1024 * 1024)
      throw new Error('Selected document exceeds the public limit')
    if (page.nextOffset === null) return text
    if (page.nextOffset <= offset) throw new Error('Source page did not advance')
    offset = page.nextOffset
  }
}
export async function loadInstructionImages(client, element, receipt, current, signal) {
  // Bounded visible image demand; large/excess assets remain explicitly labeled.
  const placeholders = [...element.querySelectorAll('[data-instruction-image]')],
    labels = new Map(
      placeholders.map((placeholder) => [
        placeholder,
        placeholder.textContent || 'Image',
      ]),
    )
  for (const placeholder of placeholders.slice(8))
    placeholder.textContent = `${placeholder.textContent || 'Image'} · not loaded: eight-image display limit`
  for (const placeholder of placeholders.slice(0, 8)) {
    if (!current()) break
    const path = placeholder.dataset.instructionImage
    let imageReceipt
    try {
      const image = await client.request('source.asset', { receipt, path }, signal)
      imageReceipt = image.receipt
      if (!current()) break
      const bytes = await sourcePages(client, imageReceipt, signal)
      if (!current()) break
      const img = element.ownerDocument.createElement('img')
      img.alt = placeholder.textContent
      img.src = `data:${image.mime};base64,${bytes}`
      placeholder.replaceWith(img)
    } catch (error) {
      if (current()) {
        placeholder.dataset.imageState = 'unavailable'
        placeholder.textContent = `${labels.get(placeholder)} · not loaded: ${error.message}. Use Read current to retry.`
      }
    } finally {
      if (imageReceipt)
        await client
          .request('source.read', { receipt: imageReceipt, release: true })
          .catch(() => {})
    }
  }
  if (!current())
    for (const placeholder of placeholders.slice(0, 8))
      if (placeholder.parentNode && !placeholder.dataset.imageState) {
        placeholder.dataset.imageState = 'interrupted'
        placeholder.textContent = `${labels.get(placeholder)} · image reading interrupted. Use Read current to retry.`
      }
}
