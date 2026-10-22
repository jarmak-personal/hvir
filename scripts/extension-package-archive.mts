import { ZipFile } from 'yazl'
import { EXTENSION_LIMITS } from '../src/shared/extensions/contract.ts'

/** Release and installed-authoring probes encode ordinary packages; capture still validates them. */
export async function extensionPackageArchive(
  files: ReadonlyMap<string, Uint8Array>,
): Promise<Buffer> {
  if (
    !files.has('hvir-extension.json') ||
    files.size > EXTENSION_LIMITS.files ||
    [...files.values()].reduce((total, bytes) => total + bytes.byteLength, 0) >
      EXTENSION_LIMITS.packageBytes
  )
    throw new Error('Extension archive inputs exceed the ordinary package bounds')
  const archive = new ZipFile()
  for (const [name, bytes] of [...files].sort(([a], [b]) =>
    a < b ? -1 : a > b ? 1 : 0,
  )) {
    archive.addBuffer(Buffer.from(bytes), name, {
      // DOS stores a local calendar, not an instant; this yields identical encoded fields in every TZ.
      mtime: new Date(2000, 0, 1, 0, 0, 0),
      mode: 0o100644,
      forceDosTimestamp: true,
      compressionLevel: 9,
    })
  }
  archive.end()
  const chunks: Buffer[] = []
  for await (const chunk of archive.outputStream) chunks.push(chunk as Buffer)
  return Buffer.concat(chunks)
}
