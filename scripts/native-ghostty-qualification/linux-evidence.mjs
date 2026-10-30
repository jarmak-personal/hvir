/* global process, console */
// Content-free environment and stage evidence; build/runtime logs remain separate.
import { readFileSync, writeFileSync, readdirSync, realpathSync } from 'node:fs'
import { platform, arch, release, cpus } from 'node:os'
import { basename, join } from 'node:path'
const [output, source, stage, buildCode, runtimeCode] = process.argv.slice(2)
if (!output || !source || !stage) throw new Error('Missing Linux evidence identity')
function read(path) {
  try {
    return readFileSync(path, 'utf8').trim()
  } catch {
    return null
  }
}
function entries(path) {
  try {
    return readdirSync(path)
  } catch {
    return []
  }
}
const drm = entries('/sys/class/drm')
  .filter((name) => /^card\d+$/u.test(name))
  .map((card) => {
    const device = `/sys/class/drm/${card}/device`
    let driver = null
    try {
      driver = basename(realpathSync(join(device, 'driver')))
    } catch {
      /* Missing driver. */
    }
    return {
      card,
      driver,
      vendor: read(join(device, 'vendor')),
      device: read(join(device, 'device')),
    }
  })
const result = {
  schema: 1,
  sourceCommit: source,
  upstreamCommit: '83fb95624b0439ee660c2679b43b38c8b63769cd',
  platform: platform(),
  arch: arch(),
  kernel: release(),
  cpu: cpus()[0]?.model ?? null,
  display: {
    sessionType: process.env.XDG_SESSION_TYPE ?? null,
    waylandDisplay: process.env.WAYLAND_DISPLAY ?? null,
    display: process.env.DISPLAY ?? null,
  },
  drm,
  renderNodes: entries('/dev/dri').filter((name) => /^renderD\d+$/u.test(name)),
  stage,
  buildExitCode: buildCode === 'not-run' ? null : Number(buildCode),
  runtimeExitCode: runtimeCode === 'not-run' ? null : Number(runtimeCode),
  gpuQualified: false,
  knownBoundary:
    'Pinned embedded API declares macOS/iOS only; no Linux runtime facade or Electron DMA-BUF importer is supplied.',
  logs: ['build.log', 'runtime.log', 'egl.log', 'cc.log', 'versions.log'],
}
writeFileSync(join(output, 'result.json'), JSON.stringify(result, null, 2) + '\n')
console.log(
  JSON.stringify({
    sourceCommit: source,
    stage,
    gpuQualified: false,
    result: join(output, 'result.json'),
  }),
)
