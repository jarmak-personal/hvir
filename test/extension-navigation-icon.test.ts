import { describe, expect, it } from 'vitest'
import { passiveNavigationIcon } from '../src/main/extensions/navigation-icon'
import { validateCapturedExtension } from '../src/main/extensions/package-store'
import { exampleManifest } from './fixtures/extension-package'

const encode = (text: string): Uint8Array => new TextEncoder().encode(text)
const image =
  '<svg viewBox="0 0 20 20" fill="none" stroke="currentColor"><path d="M2 2h8v8H2z"/></svg>'

function capture(icon?: string, declaration: unknown = 'icon.svg') {
  return validateCapturedExtension({
    sourceIdentity: 'owned:1',
    files: new Map([
      [
        'hvir-extension.json',
        encode(
          JSON.stringify(
            exampleManifest({
              views: [
                {
                  ...exampleManifest().views[0]!,
                  navigation: 'left',
                  placement: 'workspace',
                  navigationIcon: declaration,
                },
              ],
            }),
          ),
        ),
      ],
      ['index.html', encode('<p>Usable view</p>')],
      ...(icon === undefined ? [] : [['icon.svg', encode(icon)] as const]),
    ]),
  })
}

describe('accepted passive navigation image boundary', () => {
  it('reconstructs bounded path geometry without passing original XML through', () => {
    const result = passiveNavigationIcon(encode(image))
    const svg = Buffer.from(result.split(',')[1]!, 'base64').toString('utf8')
    expect(svg).toContain('xmlns="http://www.w3.org/2000/svg"')
    expect(svg).toContain('d="M 2 2 h 8 v 8 H 2 z"')
    expect(svg).not.toBe(image)
    expect(result).toMatch(/^data:image\/svg\+xml;base64,[\w+/=]+$/u)
  })
  it.each([
    '<svg viewBox="0 0 20 20"><script>alert(1)</script><path d="M0 0H2"/></svg>',
    image.replace('<path ', '<path onclick="alert(1)" '),
    image.replace('<path ', '<path style="stroke:red" '),
    image.replace('<path ', '<path href="https://example.invalid/a" '),
    image.replace('currentColor', 'url(https://example.invalid/a)'),
    image.replace('<path d="M2 2h8v8H2z"/>', '<image href="file:///etc/passwd"/>'),
    image.replace(
      '<path d="M2 2h8v8H2z"/>',
      '<foreignObject><p>Content</p></foreignObject>',
    ),
    '<!DOCTYPE svg [<!ENTITY x "x">]>' + image,
    '<?xml version="1.0"?>' + image,
    image.replace('M2 2h8v8H2z', 'M2 2&#72;8'),
    image.replace('M2 2h8v8H2z', 'M2'),
    image.replace('M2 2h8v8H2z', 'M2 2'),
    image.replace('M2 2h8v8H2z', 'M2 2h0v0z'),
    '<svg viewBox="0 0 20 20"><path d="M1 1H2"/></svg>',
    image.replace('M2 2h8v8H2z', 'M2 2C1 1 2 2 3 3'),
    image.replace('0 0 20 20', '0 0 0 20'),
    image.replace('0 0 20 20', '0 0 Infinity 20'),
    image.replace('M2 2h8', 'M2 2h5000'),
    image.replace('M2 2h8v8H2z', 'M30 30h8v8H30z'),
    '<svg viewBox="0 0 20 20"></svg>',
    image.replace('stroke="currentColor"', 'stroke="none"'),
    image.replace('</svg>', '') + ' '.repeat(8192),
  ])(
    'refuses unsupported or nonexecuting-boundary violations and preserves navigation',
    (bad) => {
      expect(() => passiveNavigationIcon(encode(bad))).toThrow()
      const revision = capture(bad)
      expect(revision.manifest.views[0]?.navigation).toBe('left')
      expect(revision.navigationIcons).toEqual({})
      expect(revision.warnings).toContainEqual(
        expect.stringContaining('text navigation remains available'),
      )
    },
  )
  it.each([
    '../icon.svg',
    '/icon.svg',
    'https://example.invalid/icon.svg',
    'icon.svg?x=1',
    'icon.png',
    null,
  ])(
    'treats invalid optional path %j as a warning, not a package prerequisite',
    (path) => {
      const revision = capture(image, path)
      expect(revision.manifest.views[0]?.navigation).toBe('left')
      expect(revision.manifest.views[0]?.navigationIcon).toBeUndefined()
      expect(revision.navigationIcons).toEqual({})
      expect(revision.warnings).toContainEqual(
        expect.stringContaining('Navigation icon ignored'),
      )
    },
  )
  it('warns on missing/invalid UTF-8 and keeps image data bound to exact captured bytes', () => {
    expect(capture().warnings).toContainEqual(expect.stringContaining('Navigation icon'))
    expect(() => passiveNavigationIcon(new Uint8Array([255]))).toThrow()
    const first = capture(image),
      second = capture(image.replace('h8', 'h9'))
    expect(first.hash).not.toBe(second.hash)
    expect(first.navigationIcons).not.toEqual(second.navigationIcons)
    first.files.get('icon.svg')!.fill(0)
    expect(first.navigationIcons).toEqual(capture(image).navigationIcons)
  })
  it('bounds path count and does not accept unknown or duplicate attributes', () => {
    for (const bad of [
      `<svg viewBox="0 0 20 20">${'<path d="M1 1H2"/>'.repeat(17)}</svg>`,
      image.replace('viewBox=', 'unknown="1" viewBox='),
      image.replace('viewBox=', 'viewBox="0 0 20 20" viewBox='),
    ])
      expect(() => passiveNavigationIcon(encode(bad))).toThrow()
  })
})
