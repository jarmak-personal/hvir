/** UTF-8 bounds and chunk-boundary-safe source sanitization for rich Markdown. */

const encoder = new TextEncoder()

export function richMarkdownUtf8Bytes(value: string): number {
  return encoder.encode(value).byteLength
}

export function takeRichMarkdownUtf8Prefix(
  value: string,
  byteLimit: number,
): [string, string] {
  let bytes = 0
  let index = 0
  for (const point of value) {
    const size = richMarkdownUtf8Bytes(point)
    if (bytes + size > byteLimit) break
    bytes += size
    index += point.length
  }
  if (index === 0 && value) index = value.codePointAt(0)! > 0xffff ? 2 : 1
  return [value.slice(0, index), value.slice(index)]
}

export class RichMarkdownSourceSanitizer {
  private pendingHighSurrogate = ''
  private pendingCarriageReturn = false

  push(chunk: string): string {
    let value = chunk
    if (this.pendingHighSurrogate) {
      value = this.pendingHighSurrogate + value
      this.pendingHighSurrogate = ''
    }
    const last = value.charCodeAt(value.length - 1)
    if (last >= 0xd800 && last <= 0xdbff) {
      this.pendingHighSurrogate = value.at(-1) ?? ''
      value = value.slice(0, -1)
    }
    value = replaceUnpairedSurrogates(value)

    if (this.pendingCarriageReturn) {
      value = value.startsWith('\n') ? value : `�${value}`
      this.pendingCarriageReturn = false
    }
    if (value.endsWith('\r')) {
      value = value.slice(0, -1)
      this.pendingCarriageReturn = true
    }
    return sanitizeControls(value.replaceAll('\r\n', '\n').replaceAll('\r', '�'))
  }

  finish(): string {
    const suffix =
      (this.pendingHighSurrogate ? '�' : '') + (this.pendingCarriageReturn ? '�' : '')
    this.pendingHighSurrogate = ''
    this.pendingCarriageReturn = false
    return suffix
  }
}

function replaceUnpairedSurrogates(value: string): string {
  let output = ''
  for (let index = 0; index < value.length; index += 1) {
    const unit = value.charCodeAt(index)
    if (unit >= 0xd800 && unit <= 0xdbff) {
      const next = value.charCodeAt(index + 1)
      if (next >= 0xdc00 && next <= 0xdfff) {
        output += value.slice(index, index + 2)
        index += 1
      } else output += '�'
    } else if (unit >= 0xdc00 && unit <= 0xdfff) output += '�'
    else output += value.charAt(index)
  }
  return output
}

function sanitizeControls(value: string): string {
  let output = ''
  for (const point of value) {
    const code = point.codePointAt(0) ?? 0
    output +=
      (code <= 0x1f && code !== 0x09 && code !== 0x0a) || (code >= 0x7f && code <= 0x9f)
        ? '�'
        : point
  }
  return output
}
