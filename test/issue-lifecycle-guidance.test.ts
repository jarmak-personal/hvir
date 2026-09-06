import { existsSync, readFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import MarkdownIt from 'markdown-it'
import { describe, expect, it } from 'vitest'

const markdown = new MarkdownIt()
const documents = [
  'CONTRIBUTING.md',
  '.claude/skills/hvir-create-issue/SKILL.md',
  '.claude/skills/hvir-review-issue/SKILL.md',
  '.claude/skills/hvir-implement-issue/SKILL.md',
]

// Derive GitHub-style heading fragments from rendered inline text, including duplicate headings.
function headingFragments(source: string): Set<string> {
  const tokens = markdown.parse(source, {})
  const fragments = new Set<string>()
  for (const [index, token] of tokens.entries()) {
    if (token.type !== 'heading_open') continue
    const text = (tokens[index + 1]?.children ?? [])
      .filter((child) => ['text', 'code_inline', 'image'].includes(child.type))
      .map((child) => child.content)
      .join('')
    const slug = text
      .toLowerCase()
      .replace(/[^\p{L}\p{N}_\-\s]/gu, '')
      .replace(/\s/g, '-')
    let fragment = slug
    for (let suffix = 1; fragments.has(fragment); suffix++) fragment = `${slug}-${suffix}`
    fragments.add(fragment)
  }
  return fragments
}

describe.each(documents)('issue lifecycle guidance: %s', (document) => {
  const source = readFileSync(document, 'utf8')

  it('resolves its local links and heading fragments', () => {
    const tokens = markdown.parse(source, {}).flatMap((token) => token.children ?? [])
    for (const token of tokens) {
      if (token.type !== 'link_open') continue
      const href = token.attrGet('href')
      if (typeof href !== 'string') throw new Error(`${document}: link has no href`)
      if (/^(?:[a-z][a-z0-9+.-]*:|\/\/)/i.test(href)) continue
      const [local = '', fragment] = href.split('#', 2)
      const relative = decodeURIComponent(local.split('?', 1)[0]!)
      const target = relative ? resolve(dirname(document), relative) : resolve(document)
      expect(existsSync(target), `${document}: ${href}`).toBe(true)
      if (fragment) {
        expect(
          headingFragments(readFileSync(target, 'utf8')),
          `${document}: ${href}`,
        ).toContain(decodeURIComponent(fragment))
      }
    }
  })

  it('references existing npm scripts', () => {
    const { scripts } = JSON.parse(readFileSync('package.json', 'utf8')) as {
      scripts: Record<string, string>
    }
    for (const match of source.matchAll(
      /npm run\s+(?:--silent\s+)?([a-z][a-z0-9:-]*)/g,
    )) {
      const command = match[1]!
      expect(Object.hasOwn(scripts, command), `${document}: npm run ${command}`).toBe(
        true,
      )
    }
  })
})
