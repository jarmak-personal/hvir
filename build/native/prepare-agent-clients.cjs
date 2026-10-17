const { execFileSync } = require('node:child_process')
const { join } = require('node:path')
module.exports = async function prepareAgentClients(context) {
  const packager = context.packager
  if (packager.platform.name === 'mac' && packager.forceCodeSigning === true) {
    const { isSignAllowed } = require('app-builder-lib/out/codeSign/macCodeSign')
    if (!isSignAllowed()) throw new Error('Required macOS signing is unavailable')
    const config = packager.platformSpecificBuildOptions
    if (config.identity === null)
      throw new Error('Required macOS signing identity is absent')
    const { keychainFile } = await packager.codeSigningInfo.value
    const identity = await packager.helper.findSigningIdentity(
      false,
      config.type === 'development',
      config.identity,
      keychainFile,
      config,
    )
    if (!identity || identity.name === '-')
      throw new Error(
        'Required macOS signing identity is absent; ad-hoc signing is development-only',
      )
  }
  const source = execFileSync('git', ['rev-parse', 'HEAD'], {
    cwd: context.packager.projectDir,
    encoding: 'utf8',
  }).trim()
  const { agentClientManifest } = await import('../../scripts/agent-client-artifacts.mjs')
  await agentClientManifest(
    join(context.packager.projectDir, 'out/agent-clients'),
    source,
  )
}
