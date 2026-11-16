const { execFile } = require('node:child_process')
const { promisify } = require('node:util')
const { signWith } = require('./sign-agent-clients.cjs')
const { signNativeTerminal } = require('./sign-native-terminal.cjs')

exports.sign = async function sign(options) {
  const { sign: ordinarySign } = require('app-builder-lib/out/codeSign/macCodeSign')
  const execute = promisify(execFile)
  const signedNative = await signNativeTerminal(options, execute)
  await signWith(options, execute, (clientOptions) =>
    ordinarySign({
      ...clientOptions,
      ignore: (file) => signedNative.has(file) || clientOptions.ignore?.(file) === true,
    }),
  )
}
