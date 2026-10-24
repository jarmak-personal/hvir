import DOMPurify from 'dompurify'
import { assertMermaidOutput, MERMAID_LIMITS } from './mermaid-contract'

const LABEL_ATTRIBUTES = new Set([
  'xmlns',
  'style',
  'id',
  'title',
  'colspan',
  'rowspan',
  'lang',
  'dir',
  'role',
])
const LOCAL_REFERENCES = new Set([
  'aria-labelledby',
  'aria-describedby',
  'aria-controls',
  'aria-details',
  'aria-errormessage',
  'aria-flowto',
  'aria-owns',
  'aria-activedescendant',
])
const PAINT_REFERENCES = new Set([
  'fill',
  'stroke',
  'marker-start',
  'marker-mid',
  'marker-end',
  'clip-path',
  'mask',
  'filter',
  'cursor',
])

const LABEL_TAGS = new Set([
  'div',
  'span',
  'p',
  'br',
  'strong',
  'b',
  'em',
  'i',
  'u',
  's',
  'pre',
  'code',
  'small',
  'sub',
  'sup',
  'ol',
  'ul',
  'li',
  'table',
  'tbody',
  'thead',
  'tr',
  'td',
  'th',
])

// Passive diagram appearance, without stylesheets, layout escape, or resource loads.
const STYLE_PROPERTIES = new Set([
  'fill',
  'fill-opacity',
  'stroke',
  'stroke-width',
  'stroke-opacity',
  'stroke-dasharray',
  'stroke-linecap',
  'stroke-linejoin',
  'opacity',
  'font-family',
  'font-size',
  'font-weight',
  'font-style',
  'color',
  'text-anchor',
  'dominant-baseline',
  'text-align',
  'text-decoration',
  'white-space',
  'word-break',
  'overflow-wrap',
  'align-items',
  'justify-content',
  'flex-direction',
  'flex-wrap',
  'line-height',
  'display',
  'vertical-align',
  'width',
  'height',
  'max-width',
  'padding',
  'margin',
  'box-sizing',
])

/** Byte/code-unit admission precedes parsing; both callers independently enforce it. */
export function admitMermaidSvg(source: string, prefix: string): string {
  assertMermaidOutput(source)
  const fragment = DOMPurify.sanitize(source, {
    USE_PROFILES: { svg: true, svgFilters: false, html: true },
    ADD_TAGS: ['foreignObject'],
    ALLOW_DATA_ATTR: false,
    FORBID_ATTR: ['class', 'autofocus', 'contenteditable'],
    HTML_INTEGRATION_POINTS: { foreignobject: true },
    FORBID_TAGS: [
      'style',
      'script',
      'a',
      'img',
      'image',
      'use',
      'video',
      'audio',
      'iframe',
      'object',
      'embed',
      'input',
      'button',
      'form',
      'link',
      'meta',
      'animate',
      'animateTransform',
      'animateMotion',
      'animateColor',
      'set',
    ],
    RETURN_DOM_FRAGMENT: true,
  })
  const svg = fragment.firstElementChild
  if (!svg || svg.localName !== 'svg' || fragment.childElementCount !== 1)
    throw new Error('Diagram preview unavailable: invalid SVG output')
  for (const element of svg.querySelectorAll('*')) {
    if (
      element.namespaceURI === 'http://www.w3.org/1999/xhtml' &&
      !LABEL_TAGS.has(element.localName)
    )
      element.replaceWith(document.createTextNode(element.textContent ?? ''))
  }
  const elements = [svg, ...svg.querySelectorAll('*')]
  if (elements.length > MERMAID_LIMITS.elements)
    throw new Error(
      'Diagram preview unavailable: too many rendered elements. Use Source.',
    )
  const ids = new Map<string, string>()
  for (const [index, element] of elements.entries()) {
    let depth = 0
    for (let parent = element.parentElement; parent; parent = parent.parentElement)
      if (++depth > MERMAID_LIMITS.depth)
        throw new Error('Diagram preview unavailable: SVG nesting limit')
    const id = element.getAttribute('id')
    if (id) {
      if (ids.has(id))
        throw new Error('Diagram preview unavailable: duplicate SVG identity')
      ids.set(id, `${prefix}-${index}`)
    }
  }
  for (const element of elements) {
    const style = (element as HTMLElement | SVGElement).style
    const declarations: string[] = []
    if (style) {
      for (const name of Array.from(style)) {
        const value = style.getPropertyValue(name)
        if (STYLE_PROPERTIES.has(name) && !/url\s*\(|var\s*\(|[\\@]/i.test(value))
          declarations.push(`${name}:${value}`)
      }
    }
    element.removeAttribute('style')
    if (declarations.length) element.setAttribute('style', declarations.join(';'))
    for (const attribute of [...element.attributes]) {
      const name = attribute.name.toLowerCase()
      if (
        (element.namespaceURI === 'http://www.w3.org/1999/xhtml' &&
          !LABEL_ATTRIBUTES.has(name) &&
          !name.startsWith('aria-')) ||
        name === 'xml:base' ||
        name === 'focusable' ||
        name === 'accesskey' ||
        (PAINT_REFERENCES.has(name) && attribute.value.includes('\\'))
      ) {
        element.removeAttribute(attribute.name)
      } else if (name === 'id') {
        element.setAttribute('id', ids.get(attribute.value)!)
      } else if (LOCAL_REFERENCES.has(name)) {
        const references = attribute.value.split(/\s+/).flatMap((id) => ids.get(id) ?? [])
        if (references.length) element.setAttribute(attribute.name, references.join(' '))
        else element.removeAttribute(attribute.name)
      } else if (
        name === 'href' ||
        name.endsWith(':href') ||
        name.startsWith('on') ||
        name === 'src' ||
        name === 'tabindex'
      ) {
        element.removeAttribute(attribute.name)
      } else if (/url\s*\(/i.test(attribute.value)) {
        const match = /^url\(\s*["']?#([^\s"')]+)["']?\s*\)$/.exec(attribute.value)
        const target = match && ids.get(match[1]!)
        if (
          target &&
          [
            'fill',
            'stroke',
            'marker-start',
            'marker-mid',
            'marker-end',
            'clip-path',
            'mask',
          ].includes(name)
        )
          element.setAttribute(attribute.name, `url(#${target})`)
        else element.removeAttribute(attribute.name)
      }
    }
  }
  svg.setAttribute('overflow', 'hidden')
  const rootStyle = (svg as SVGElement).style
  rootStyle.maxWidth = '100%'
  rootStyle.maxHeight = '32768px'
  rootStyle.height = 'auto'
  const result = svg.outerHTML
  assertMermaidOutput(result)
  return result
}

/** Resolve theme styles inside the isolated page; no stylesheet crosses into the workbench. */
export function inlineMermaidAppearance(root: SVGElement): void {
  for (const element of [root, ...root.querySelectorAll<SVGElement>('*')]) {
    const computed = getComputedStyle(element)
    for (const property of STYLE_PROPERTIES) {
      const value = computed.getPropertyValue(property)
      if (value && !/url\s*\(/i.test(value)) element.style.setProperty(property, value)
    }
    // Mermaid commonly emits absolute references in marker styles.
    for (const name of [
      'marker-start',
      'marker-mid',
      'marker-end',
      'fill',
      'stroke',
      'clip-path',
      'mask',
    ]) {
      const value = computed.getPropertyValue(name)
      const fragment = /#([^"')\s]+)["']?\)$/.exec(value)
      if (fragment) element.setAttribute(name, `url(#${fragment[1]})`)
    }
  }
}
