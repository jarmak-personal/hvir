export async function sourcePages(client, receipt) {
  let text = '',
    offset = 0
  for (;;) {
    const page = await client.request('source.read', { receipt, offset })
    text += page.data
    if (text.length > 3 * 1024 * 1024)
      throw new Error('Selected document exceeds the public limit')
    if (page.nextOffset === null) return text
    if (page.nextOffset <= offset) throw new Error('Source page did not advance')
    offset = page.nextOffset
  }
}
export async function loadInstructionImages(client, element, receipt, current) {
  // Bounded visible image demand; large/excess assets remain explicitly labeled.
  const placeholders = [...element.querySelectorAll('[data-instruction-image]')]
  for (const placeholder of placeholders.slice(8))
    placeholder.textContent = `${placeholder.textContent || 'Image'} · not loaded: eight-image display limit`
  for (const placeholder of placeholders.slice(0, 8)) {
    if (!current()) return
    const path = placeholder.dataset.instructionImage
    let imageReceipt
    try {
      const image = await client.request('source.asset', { receipt, path })
      imageReceipt = image.receipt
      const bytes = await sourcePages(client, imageReceipt)
      if (!current()) return
      const img = element.ownerDocument.createElement('img')
      img.alt = placeholder.textContent
      img.src = `data:${image.mime};base64,${bytes}`
      placeholder.replaceWith(img)
    } catch {
      if (current())
        placeholder.textContent = `${placeholder.textContent || 'Image'} · unavailable or outside the selected source`
    } finally {
      if (imageReceipt)
        await client
          .request('source.read', { receipt: imageReceipt, release: true })
          .catch(() => {})
    }
  }
}
