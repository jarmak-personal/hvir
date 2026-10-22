/** A closed, passive path-image vocabulary; this is not a general SVG renderer. */
const NUMBER = '-?(?:\\d+(?:\\.\\d+)?|\\.\\d+)'
const NUMBERS = new RegExp(`^${NUMBER}(?:[ ,]+${NUMBER})*$`, 'u')
const PATH_TOKEN = new RegExp(`[MmLlHhVvZz]|${NUMBER}`, 'gu')
const PAINT = ['fill', 'stroke', 'stroke-width', 'stroke-linecap', 'stroke-linejoin']

function attributes(text: string, allowed: readonly string[]): Map<string, string> {
  const result = new Map<string, string>()
  let rest = text
  while (rest.trim()) {
    const value = /^\s+([A-Za-z-]+)="([^"<>&]*)"/u.exec(rest)
    if (!value || !allowed.includes(value[1]!) || result.has(value[1]!))
      throw new Error('Unsupported SVG attributes')
    result.set(value[1]!, value[2]!)
    rest = rest.slice(value[0].length)
  }
  return result
}

function paint(values: Map<string, string>): string {
  const result: string[] = []
  for (const name of PAINT) {
    const value = values.get(name)
    if (value === undefined) continue
    const valid =
      name === 'fill' || name === 'stroke'
        ? ['none', 'currentColor'].includes(value)
        : name === 'stroke-linecap'
          ? ['butt', 'round', 'square'].includes(value)
          : name === 'stroke-linejoin'
            ? ['miter', 'round', 'bevel'].includes(value)
            : new RegExp(`^${NUMBER}$`, 'u').test(value) &&
              Number(value) >= 0.1 &&
              Number(value) <= 4
    if (!valid) throw new Error('Unsupported SVG paint')
    result.push(`${name}="${value}"`)
  }
  return result.join(' ')
}

function pathGeometry(
  value: string | undefined,
  box: readonly number[],
): {
  d: string
  stroke: boolean
  fill: boolean
} {
  if (!value || value.length > 1024) throw new Error('Invalid SVG path length')
  const tokens = [...value.matchAll(PATH_TOKEN)].map((match) => match[0])
  if (value.replace(PATH_TOKEN, '').replace(/[\s,]/gu, '') || tokens.length > 256)
    throw new Error('Unsupported SVG path geometry')
  if (!['M', 'm'].includes(tokens[0] ?? '')) throw new Error('Start a path with Move')
  let x = 0,
    y = 0,
    startX = 0,
    startY = 0,
    area = 0
  let stroke = false,
    fill = false
  const closeArea = (): void => {
    fill ||= area + x * startY - startX * y !== 0
    area = 0
  }
  const line = (nextX: number, nextY: number): void => {
    if (Math.abs(nextX) > 4096 || Math.abs(nextY) > 4096)
      throw new Error('SVG coordinates exceed their bound')
    stroke ||= nextX !== x || nextY !== y
    area += x * nextY - nextX * y
    x = nextX
    y = nextY
  }
  for (let index = 0; index < tokens.length;) {
    const command = tokens[index++]!
    const arity = /[MmLl]/u.test(command)
      ? 2
      : /[HhVv]/u.test(command)
        ? 1
        : /[Zz]/u.test(command)
          ? 0
          : -1
    if (arity < 0) throw new Error('Provide explicit SVG path commands')
    const begin = index
    let count = 0
    while (index < tokens.length && /^[-.\d]/u.test(tokens[index]!)) {
      if (
        !Number.isFinite(Number(tokens[index])) ||
        Math.abs(Number(tokens[index])) > 4096
      )
        throw new Error('SVG coordinates exceed their bound')
      index++
      count++
    }
    if (arity === 0 ? count !== 0 : count === 0 || count % arity !== 0)
      throw new Error('Incomplete SVG path command')
    if (arity === 0) {
      line(startX, startY)
      closeArea()
      continue
    }
    for (let offset = 0; offset < count; offset += arity) {
      const relative = command === command.toLowerCase()
      const a = Number(tokens[begin + offset]),
        b = Number(tokens[begin + offset + 1])
      const nextX = /[Vv]/u.test(command) ? x : a + (relative ? x : 0)
      const nextY = /[Hh]/u.test(command) ? y : (arity === 1 ? a : b) + (relative ? y : 0)
      if (
        nextX < box[0]! ||
        nextX > box[0]! + box[2]! ||
        nextY < box[1]! ||
        nextY > box[1]! + box[3]!
      )
        throw new Error('Keep SVG path geometry inside its viewBox')
      if (/[Mm]/u.test(command) && offset === 0) {
        closeArea()
        x = nextX
        y = nextY
        startX = x
        startY = y
      } else line(nextX, nextY)
    }
  }
  closeArea()
  return { d: tokens.join(' '), stroke, fill }
}

/** Capture calls this off paint; only reconstructed geometry can cross to trusted UI. */
export function passiveNavigationIcon(bytes: Uint8Array | undefined): string {
  if (!bytes || bytes.byteLength === 0 || bytes.byteLength > 8192)
    throw new Error('Provide an SVG of at most 8 KiB')
  const text = new TextDecoder('utf-8', { fatal: true }).decode(bytes)
  const root = /^\s*<svg(\s[^<>]*)>([\s\S]*)<\/svg>\s*$/u.exec(text)
  if (!root) throw new Error('Provide one static SVG root')
  const attrs = attributes(root[1]!, ['xmlns', 'viewBox', ...PAINT])
  if (attrs.has('xmlns') && attrs.get('xmlns') !== 'http://www.w3.org/2000/svg')
    throw new Error('Unsupported SVG namespace')
  const viewBox = attrs.get('viewBox')
  if (!viewBox || !NUMBERS.test(viewBox)) throw new Error('Provide a finite viewBox')
  const box = viewBox.split(/[ ,]+/u).map(Number)
  if (
    box.length !== 4 ||
    box.some((value) => !Number.isFinite(value) || Math.abs(value) > 4096) ||
    box[2]! <= 0 ||
    box[3]! <= 0
  )
    throw new Error('Invalid SVG viewBox')
  const paths: string[] = []
  let rest = root[2]!
  while (rest.trim()) {
    const match = /^\s*<path(\s[^<>]*)\/>/u.exec(rest)
    if (!match || paths.length === 16) throw new Error('Use at most sixteen simple paths')
    const path = attributes(match[1]!, ['d', ...PAINT])
    const fill = path.get('fill') ?? attrs.get('fill') ?? 'currentColor'
    const stroke = path.get('stroke') ?? attrs.get('stroke') ?? 'none'
    const geometry = pathGeometry(path.get('d'), box)
    if (
      !(fill === 'currentColor' && geometry.fill) &&
      !(stroke === 'currentColor' && geometry.stroke)
    )
      throw new Error('Provide visible nonempty path geometry')
    paths.push(`<path d="${geometry.d}" ${paint(path)}/>`)
    rest = rest.slice(match[0].length)
  }
  if (!paths.length) throw new Error('Provide nonempty SVG paths')
  // No original XML, URLs or unvalidated attributes survive reconstruction.
  const image = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="${box.join(' ')}" ${paint(attrs)}>${paths.join('')}</svg>`
  return `data:image/svg+xml;base64,${Buffer.from(image).toString('base64')}`
}
