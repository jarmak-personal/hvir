import { ZipFile } from 'yazl'

export async function extensionZip(
  files: ReadonlyMap<string, Uint8Array>,
): Promise<Buffer> {
  const archive = new ZipFile()
  for (const [name, bytes] of files) archive.addBuffer(Buffer.from(bytes), name)
  archive.end()
  const chunks: Buffer[] = []
  for await (const chunk of archive.outputStream) chunks.push(chunk as Buffer)
  return Buffer.concat(chunks)
}

/** Mutate central metadata to exercise hostile archives the writer deliberately refuses. */
export function alterZipCentral(
  zip: Buffer,
  change: (header: Buffer, name: string) => void,
): Buffer {
  const copy = Buffer.from(zip)
  for (let offset = 0; offset + 46 <= copy.length; offset++) {
    if (copy.readUInt32LE(offset) !== 0x02014b50) continue
    const length = copy.readUInt16LE(offset + 28)
    const header = copy.subarray(offset, offset + 46 + length)
    change(header, header.subarray(46).toString('utf8'))
    offset += header.length - 1
  }
  return copy
}
