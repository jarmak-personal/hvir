import { describe, expect, it } from 'vitest'

import { languageForPath } from '../src/renderer/src/viewer/highlight-protocol'
import {
  resolveViewerGrammar,
  VIEWER_GRAMMAR_DEFINITIONS,
} from '../src/renderer/src/viewer/shiki-language-catalog'

describe('source highlighting language inference', () => {
  it.each([
    ['eslint.config.mjs', 'javascript'],
    ['legacy.cjs', 'javascript'],
    ['config.mts', 'typescript'],
    ['config.cts', 'typescript'],
  ] as const)('classifies %s as %s', (path, language) => {
    expect(resolveViewerGrammar(languageForPath(`/project/${path}`) ?? '')?.id).toBe(
      language,
    )
  })

  it('matches module extensions case-insensitively', () => {
    expect(resolveViewerGrammar(languageForPath('/project/SCRIPT.MJS') ?? '')?.id).toBe(
      'javascript',
    )
  })

  it('recognizes every non-excluded bundled grammar id and alias as an extension', () => {
    const excluded = new Set(['ps', 'v'])
    for (const grammar of VIEWER_GRAMMAR_DEFINITIONS) {
      for (const name of [grammar.id, ...grammar.aliases]) {
        const inferred = languageForPath(`/project/file.${name}`)
        if (excluded.has(name)) expect(inferred, name).toBeUndefined()
        else expect(resolveViewerGrammar(inferred ?? '')?.id, name).toBe(grammar.id)
      }
    }
  })

  it.each([
    ['legacy.htm', 'html'],
    ['component.mdx', 'mdx'],
  ] as const)('applies the explicit %s override as %s', (path, language) => {
    expect(languageForPath(`/project/${path}`)).toBe(language)
  })

  it.each([
    ['Dockerfile', 'docker'],
    ['Dockerfile.dev', 'docker'],
    ['Dockerfile.md', 'docker'],
    ['Container.Dockerfile', 'docker'],
    ['DOCKERFILE.PRODUCTION', 'docker'],
    ['Makefile', 'make'],
    ['GNUmakefile', 'make'],
    ['Makefile.release', 'make'],
    ['Makefile.md', 'make'],
    ['CMakeLists.txt', 'cmake'],
    ['CODEOWNERS', 'codeowners'],
    ['.env.local', 'dotenv'],
    ['.env.ts', 'dotenv'],
    ['Justfile', 'just'],
    ['Jenkinsfile', 'groovy'],
    ['Gemfile', 'ruby'],
    ['nginx.conf', 'nginx'],
    ['ssh_config', 'ssh-config'],
  ] as const)('classifies conventional filename %s as %s', (path, language) => {
    expect(resolveViewerGrammar(languageForPath(`/project/${path}`) ?? '')?.id).toBe(
      language,
    )
  })

  it.each(['Dockerfilex', 'myDockerfile', 'notes', 'program.v', 'poster.ps'])(
    'leaves unsupported or ambiguous filename %s plain',
    (path) => {
      expect(languageForPath(`/project/${path}`)).toBeUndefined()
    },
  )

  it('classifies the same filename for local and SSH host-qualified paths', () => {
    expect(languageForPath('local:/project/Dockerfile.dev')).toBe('docker')
    expect(languageForPath('remote:/srv/project/Dockerfile.dev')).toBe('docker')
  })
})
