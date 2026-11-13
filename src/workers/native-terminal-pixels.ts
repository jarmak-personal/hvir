import { NATIVE_TERMINAL_PRESENTATION } from '../shared/native-terminal-presentation'

/** Runs only on the designated native caller for explicit compatibility copies.
 * The C copy is independently owned; the leased GPU source is never mutated. */
export function normalizeNativeTerminalPixels(
  bytes: Uint8Array,
  stride: number,
  origin: number,
): Uint8Array {
  if (
    !(bytes instanceof Uint8Array) ||
    bytes.buffer instanceof SharedArrayBuffer ||
    !Number.isInteger(stride) ||
    stride < 4 ||
    stride > 8192 * 4 ||
    stride % 4 ||
    !bytes.length ||
    bytes.length % stride ||
    bytes.length > NATIVE_TERMINAL_PRESENTATION.maximumPixelBytes ||
    ![1, 2].includes(origin)
  )
    throw new Error('native-pixel-format')
  for (let i = 0; i < bytes.length; i += 4) {
    const alpha = bytes[i + 3]!
    const blue = bytes[i]!
    bytes[i] = alpha ? Math.min(255, Math.round((bytes[i + 2]! * 255) / alpha)) : 0
    bytes[i + 1] = alpha ? Math.min(255, Math.round((bytes[i + 1]! * 255) / alpha)) : 0
    bytes[i + 2] = alpha ? Math.min(255, Math.round((blue * 255) / alpha)) : 0
  }
  if (origin === 2) {
    const row = new Uint8Array(stride)
    const height = bytes.length / stride
    for (let y = 0; y < Math.floor(height / 2); y++) {
      const top = y * stride,
        bottom = (height - y - 1) * stride
      row.set(bytes.subarray(top, top + stride))
      bytes.copyWithin(top, bottom, bottom + stride)
      bytes.set(row, bottom)
    }
  }
  return bytes
}
