const { existsSync } = require('node:fs')
const { join } = require('node:path')

/** Sign inner native code and bind its final bytes before the containing app is sealed. */
exports.signNativeTerminal = async function signNativeTerminal(options, execute) {
  const resources = join(options.app, 'Contents/Resources')
  const root = join(resources, 'native-terminal')
  if (!existsSync(root)) return new Set()
  if (!options.identity)
    throw new Error('Native terminal requires application signing identity')
  const bindings = join(
    resources,
    'app.asar.unpacked/node_modules/@hvir/native-terminal/build/Release',
  )
  const { inspectNativeTerminalPackage, captureNativeTerminalPackage } =
    await import('../../scripts/native-terminal/package-artifacts.mts')
  const original = await inspectNativeTerminalPackage(root, bindings, 'macos-arm64')
  if (original.signed) throw new Error('Native terminal was already signed')
  const binaries = new Set([
    join(root, 'libghostty.dylib'),
    join(bindings, 'native_terminal_engine.node'),
    join(bindings, 'native_terminal_resource.node'),
  ])
  for (const binary of binaries) {
    const args = [
      '--force',
      '--sign',
      options.identity,
      '--options',
      'runtime',
      '--timestamp',
    ]
    if (options.keychain) args.push('--keychain', options.keychain)
    args.push(binary)
    await execute('codesign', args)
    await execute('codesign', ['--verify', '--strict', binary])
  }
  await captureNativeTerminalPackage(
    root,
    bindings,
    original.source,
    original.target,
    true,
  )
  return binaries
}
