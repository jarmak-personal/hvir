const prepareClients = require('./prepare-agent-clients.cjs')
const prepareNativeTerminal = require('./prepare-native-terminal.cjs')

module.exports = async function prepareRuntimePayloads(context) {
  await prepareClients(context)
  await prepareNativeTerminal(context)
}
