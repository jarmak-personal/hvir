import { app, type ProcessMetric } from 'electron'
export { median } from './capacity-statistics'

export interface ElectronCpuUsage {
  readonly renderer: number
  readonly gpu: number
  readonly main: number
  readonly aggregateChildren: number
  readonly rendererPlusGpu: number
  readonly nativeHost: number
  readonly wholeApp: number
}

export interface ElectronProcessMetricReport {
  readonly durationMs: number
  readonly samples: number
  readonly cpu: ElectronCpuUsage
  readonly memoryStartKiB: number
  readonly memoryEndKiB: number
  readonly memoryPeakKiB: number
  readonly memoryGrowthKiB: number
  readonly nativeHostMemoryStartKiB: number
  readonly nativeHostMemoryEndKiB: number
  readonly nativeHostMemoryPeakKiB: number
}

export function classifyElectronCpuUsage(
  metrics: readonly ProcessMetric[],
  rendererProcessId: number,
  mainProcessId: number,
): ElectronCpuUsage {
  const renderer = sumCpu(metrics, (metric) => metric.pid === rendererProcessId)
  const gpu = sumCpu(metrics, (metric) => metric.type === 'GPU')
  const main = sumCpu(metrics, (metric) => metric.pid === mainProcessId)
  const aggregateChildren = sumCpu(metrics, (metric) => metric.pid !== mainProcessId)
  return {
    renderer,
    gpu,
    main,
    aggregateChildren,
    rendererPlusGpu: renderer + gpu,
    nativeHost: sumCpu(metrics, isNativeHost),
    wholeApp: main + aggregateChildren,
  }
}

export async function sampleElectronProcessMetrics(
  rendererProcessId: number,
  durationMs: number,
  intervalMs = 1_000,
  stop?: AbortSignal,
): Promise<ElectronProcessMetricReport> {
  const initial = app.getAppMetrics()
  const memoryStartKiB = workingSetKiB(initial)
  let memoryEndKiB = memoryStartKiB
  let memoryPeakKiB = memoryStartKiB
  const nativeHostMemoryStartKiB = nativeHostWorkingSetKiB(initial)
  let nativeHostMemoryEndKiB = nativeHostMemoryStartKiB
  let nativeHostMemoryPeakKiB = nativeHostMemoryStartKiB
  const cpuSamples: ElectronCpuUsage[] = []
  const started = Date.now()

  while (Date.now() - started < durationMs) {
    await delay(Math.min(intervalMs, durationMs - (Date.now() - started)), stop)
    const metrics = app.getAppMetrics()
    memoryEndKiB = workingSetKiB(metrics)
    memoryPeakKiB = Math.max(memoryPeakKiB, memoryEndKiB)
    nativeHostMemoryEndKiB = nativeHostWorkingSetKiB(metrics)
    nativeHostMemoryPeakKiB = Math.max(nativeHostMemoryPeakKiB, nativeHostMemoryEndKiB)
    cpuSamples.push(classifyElectronCpuUsage(metrics, rendererProcessId, process.pid))
    // Stop still takes a final real sample, covering the complete measured interval.
    if (stop?.aborted) break
  }

  const cpu = averageCpu(cpuSamples)
  return {
    durationMs: Date.now() - started,
    samples: cpuSamples.length,
    cpu,
    memoryStartKiB,
    memoryEndKiB,
    memoryPeakKiB,
    memoryGrowthKiB: memoryEndKiB - memoryStartKiB,
    nativeHostMemoryStartKiB,
    nativeHostMemoryEndKiB,
    nativeHostMemoryPeakKiB,
  }
}

function averageCpu(samples: readonly ElectronCpuUsage[]): ElectronCpuUsage {
  if (samples.length === 0) {
    return {
      renderer: 0,
      gpu: 0,
      main: 0,
      aggregateChildren: 0,
      rendererPlusGpu: 0,
      nativeHost: 0,
      wholeApp: 0,
    }
  }
  const totals = samples.reduce(
    (total, sample) => ({
      renderer: total.renderer + sample.renderer,
      gpu: total.gpu + sample.gpu,
      main: total.main + sample.main,
      aggregateChildren: total.aggregateChildren + sample.aggregateChildren,
      rendererPlusGpu: total.rendererPlusGpu + sample.rendererPlusGpu,
      nativeHost: total.nativeHost + sample.nativeHost,
      wholeApp: total.wholeApp + sample.wholeApp,
    }),
    {
      renderer: 0,
      gpu: 0,
      main: 0,
      aggregateChildren: 0,
      rendererPlusGpu: 0,
      nativeHost: 0,
      wholeApp: 0,
    },
  )
  return {
    renderer: totals.renderer / samples.length,
    gpu: totals.gpu / samples.length,
    main: totals.main / samples.length,
    aggregateChildren: totals.aggregateChildren / samples.length,
    rendererPlusGpu: totals.rendererPlusGpu / samples.length,
    nativeHost: totals.nativeHost / samples.length,
    wholeApp: totals.wholeApp / samples.length,
  }
}

function sumCpu(
  metrics: readonly ProcessMetric[],
  predicate: (metric: ProcessMetric) => boolean,
): number {
  return metrics.reduce(
    (total, metric) => total + (predicate(metric) ? metric.cpu.percentCPUUsage : 0),
    0,
  )
}

function workingSetKiB(metrics: readonly ProcessMetric[]): number {
  return metrics.reduce((total, metric) => total + metric.memory.workingSetSize, 0)
}

function isNativeHost(metric: ProcessMetric): boolean {
  // utilityProcess.fork's explicit serviceName appears in ProcessMetric.name;
  // serviceName itself remains Chromium's shared node.mojom.NodeService type.
  return metric.type === 'Utility' && metric.name === 'hvir-native-terminal'
}

function nativeHostWorkingSetKiB(metrics: readonly ProcessMetric[]): number {
  return workingSetKiB(metrics.filter(isNativeHost))
}

function delay(durationMs: number, stop?: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    const finish = () => {
      clearTimeout(timer)
      stop?.removeEventListener('abort', finish)
      resolve()
    }
    const timer = setTimeout(finish, Math.max(0, durationMs))
    stop?.addEventListener('abort', finish, { once: true })
    if (stop?.aborted) finish()
  })
}
