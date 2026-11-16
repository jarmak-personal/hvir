import { join, resolve } from 'node:path'
import { inspectNativeTerminalPackage } from './package-artifacts.mts'

const [resources, target, ...rest] = process.argv.slice(2)
if (!resources || !target || rest.length)
  throw new Error('Usage: inspect-package.mts RESOURCES TARGET')
const root = resolve(resources)
const manifest = await inspectNativeTerminalPackage(
  join(root, 'native-terminal'),
  join(root, 'app.asar.unpacked/node_modules/@hvir/native-terminal/build/Release'),
  target,
)
console.log(
  JSON.stringify({
    nativeInstalledPackage: 'passed',
    ...manifest,
    hardwareGpuQualified: false,
    controlledCapacityQualified: false,
  }),
)
