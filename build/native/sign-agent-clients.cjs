const { execFile } = require('node:child_process')
const { promisify } = require('node:util')
const { join } = require('node:path')
const { readFile } = require('node:fs/promises')
const exec = promisify(execFile)

/** Sign client Mach-O files first, bind their final bytes, then run the ordinary app signer. */
exports.signWith = async function signAgentClients(options, execute, ordinarySign) {
  if (!options.identity)
    throw new Error(
      'The remote clients require the selected application signing identity',
    )
  const root = join(options.app, 'Contents/Resources/agent-clients')
  const original = JSON.parse(await readFile(join(root, 'manifest.json'), 'utf8'))
  const { agentClientManifest } = await import('../../scripts/agent-client-artifacts.mjs')
  await agentClientManifest(root, original.source)
  const signedClients = new Set(
    ['macos-x64', 'macos-arm64'].map((target) => join(root, target, 'hvir-agent')),
  )
  for (const target of ['macos-x64', 'macos-arm64']) {
    const binary = join(root, target, 'hvir-agent'),
      args = [
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
  await agentClientManifest(root, original.source, true)
  await ordinarySign({
    ...options,
    ignore: (file) => signedClients.has(file) || options.ignore?.(file) === true,
  })
}

exports.sign = async function sign(options) {
  const { sign: ordinarySign } = require('app-builder-lib/out/codeSign/macCodeSign')
  return exports.signWith(options, exec, ordinarySign)
}
