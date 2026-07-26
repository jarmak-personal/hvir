import { readFileSync, statSync } from 'node:fs'

import { describe, expect, it } from 'vitest'

const commandUrl = new URL('../build/native/hvir-command', import.meta.url)
const command = readFileSync(commandUrl, 'utf8')

describe('native hvir command', () => {
  it('is package-owned and resolves one relative local project from the caller', () => {
    expect(statSync(commandUrl).mode & 0o111).not.toBe(0)
    expect(command).toContain('hvir-native-package-command-v1')
    expect(command).toContain('caller_directory=$(pwd -P)')
    expect(command).toContain('project_candidate=$caller_directory/$1')
    expect(command).toContain('[ ! -d "$project_candidate" ]')
    expect(command).toContain('project_root=$(CDPATH= cd -P "$project_candidate"')
    expect(command).toContain('set -- "--project-root=$project_root" "$@"')
  })

  it('preserves remembered-workspace launches and explicit internal options', () => {
    expect(command).toContain('if [ "$#" -gt 0 ]')
    expect(command).toContain('-*)')
    expect(command).toContain('exec "$application" "$@"')
    expect(command).not.toContain('--no-sandbox')
  })

  it('uses only the package-owned platform executable', () => {
    expect(command).toContain("application='/opt/hvir/hvir'")
    expect(command).toContain("application='/Applications/hvir.app/Contents/MacOS/hvir'")
  })
})
