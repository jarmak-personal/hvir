/* global crypto, atob, TextEncoder */
import { sourcePages } from './reader.mjs'

function selectedMatches(selected, tree, file) {
  if (
    selected.path?.hostId !== 'local' ||
    selected.path.path !== `${tree.root.path}/${file.path}` ||
    selected.currentFile !== true ||
    selected.bytes !== file.size ||
    selected.sha256 !== file.sha256
  )
    throw new Error(
      `${file.path}: current confined file does not match the exact manifest SHA-256/size. Start a fresh review.`,
    )
}
async function fileDigest(bytes) {
  return [...new Uint8Array(await crypto.subtle.digest('SHA-256', bytes))]
    .map((byte) => byte.toString(16).padStart(2, '0'))
    .join('')
}
/** Read through D7 human origin only; verify generic file identity, never Skillager tree hashes. */
export async function readReviewFile(client, tree, file, current) {
  let documentReceipt, imageReceipt
  try {
    const image = /\.(avif|bmp|gif|jpe?g|png|svg|webp)$/iu.test(file.path)
    const entry = image ? tree.files.find((item) => item.path === 'SKILL.md') : file
    const selected = await client.request('source.select', {
      source: tree.source,
      ...(tree.workspaceId ? { workspaceId: tree.workspaceId } : {}),
      path: { hostId: 'local', path: `${tree.root.path}/${entry.path}` },
    })
    documentReceipt = selected.receipt
    selectedMatches(selected, tree, entry)
    if (!image) {
      const text = await sourcePages(client, documentReceipt)
      if (text.includes('\0'))
        throw new Error(
          `${file.path}: nonimage binary content cannot be fully presented as supported UTF-8 instructions`,
        )
      if (!current())
        throw new Error(
          'Review reading ended; partial or hidden material is not reviewed',
        )
      const bytes = new TextEncoder().encode(text)
      if (bytes.length !== file.size || (await fileDigest(bytes)) !== file.sha256)
        throw new Error(
          `${file.path}: complete received UTF-8 bytes differ from the manifest`,
        )
      return { kind: 'text', text, file }
    }
    const asset = await client.request('source.asset', {
      receipt: documentReceipt,
      path: file.path,
    })
    imageReceipt = asset.receipt
    const base64 = await sourcePages(client, imageReceipt)
    const decoded = atob(base64),
      bytes = new Uint8Array(decoded.length)
    for (let index = 0; index < decoded.length; index++)
      bytes[index] = decoded.charCodeAt(index)
    const hash = await fileDigest(bytes)
    if (
      !current() ||
      asset.bytes !== file.size ||
      bytes.length !== file.size ||
      hash !== file.sha256 ||
      !asset.mime?.startsWith('image/')
    )
      throw new Error(
        `${file.path}: complete image bytes do not match the reviewed manifest`,
      )
    return { kind: 'image', data: `data:${asset.mime};base64,${base64}`, file }
  } catch (error) {
    throw new Error(
      `${file.path}: ${error.message}. Use suitable file tools for unsupported binary, oversized or unreadable material. This preview does not determine acceptance eligibility.`,
      { cause: error },
    )
  } finally {
    for (const receipt of [imageReceipt, documentReceipt])
      if (receipt)
        await client.request('source.read', { receipt, release: true }).catch(() => {})
  }
}
