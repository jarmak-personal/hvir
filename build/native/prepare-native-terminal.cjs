const { execFileSync } = require('node:child_process')
const { existsSync } = require('node:fs')
const { join } = require('node:path')
const process = require('node:process')

module.exports = async function prepareNativeTerminal(context) {
  const project = context.packager.projectDir
  const root = join(project, 'out/native-terminal')
  if (process.env.HVIR_PACKAGE_NATIVE_TERMINAL !== '1') {
    if (existsSync(root))
      throw new Error('Native package payload requires explicit candidate selection')
    const { NATIVE_TERMINAL_BINDING_FILES } =
      await import('../../src/shared/native-terminal-package.ts')
    for (const directory of [
      'packages/native-terminal',
      'node_modules/@hvir/native-terminal',
    ])
      for (const file of Object.values(NATIVE_TERMINAL_BINDING_FILES))
        if (existsSync(join(project, directory, 'build/Release', file)))
          throw new Error('Native package bindings require explicit candidate selection')
    return
  }
  const target = `${context.packager.platform.name === 'mac' ? 'macos' : 'linux'}-${context.arch === 3 ? 'arm64' : context.arch === 1 ? 'x64' : 'unsupported'}`
  const { inspectNativeTerminalPackage } =
    await import('../../scripts/native-terminal/package-artifacts.mts')
  const manifest = await inspectNativeTerminalPackage(
    root,
    join(project, 'packages/native-terminal/build/Release'),
    target,
  )
  const source = execFileSync('git', ['rev-parse', 'HEAD'], {
    cwd: project,
    encoding: 'utf8',
  }).trim()
  const dirty = execFileSync(
    'git',
    ['status', '--porcelain', '--untracked-files=normal'],
    {
      cwd: project,
      encoding: 'utf8',
    },
  ).trim()
  if (manifest.source !== source || manifest.signed || dirty)
    throw new Error('Native package requires exact unsigned build inputs')
}
