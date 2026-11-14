import { Buffer } from 'node:buffer'
import { MAX_CLIPBOARD_WRITE_BYTES } from '../../shared'
/** Independent resource-boundary validation after any protocol decoding. */
export function writeTerminalClipboard(
  target: { writeText(text: string): void },
  text: unknown,
): void {
  if (typeof text !== 'string' || text.length === 0)
    throw new Error('Invalid clipboard write')
  if (Buffer.byteLength(text, 'utf8') > MAX_CLIPBOARD_WRITE_BYTES)
    throw new Error('Clipboard write exceeds the permitted size')
  target.writeText(text)
}
