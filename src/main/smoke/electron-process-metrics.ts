import { app, type ProcessMetric } from 'electron'

export interface ElectronCpuUsage {
  readonly renderer: number
  readonly gpu: number
  readonly main: number
  readonly rendererPlusGpu: number
}

export interface ElectronProcessMetricReport {
  readonly durationMs: number
  readonly samples: number
  readonly cpu: ElectronCpuUsage
  readonly memoryStartKiB: number
  readonly memoryEndKiB: number
  readonly memoryPeakKiB: number
  readonly memoryGrowthKiB: number
}

export function classifyElectronCpuUsage(
  metrics: readonly ProcessMetric[],
  rendererProcessId: number,
  mainProcessId: number,
): ElectronCpuUsage {
  const renderer = sumCpu(metrics, (metric) => metric.pid === rendererProcessId)
  const gpu = sumCpu(metrics, (metric) => metric.type === 'GPU')
  const main = sumCpu(metrics, (metric) => metric.pid === mainProcessId)
  return {
    renderer,
    gpu,
    main,
    rendererPlusGpu: renderer + gpu,
  }
}

export async function sampleElectronProcessMetrics(
  rendererProcessId: number,
  durationMs: number,
  intervalMs = 1_000,
): Promise<ElectronProcessMetricReport> {
  const initial = app.getAppMetrics()
  const memoryStartKiB = workingSetKiB(initial)
  let memoryEndKiB = memoryStartKiB
  let memoryPeakKiB = memoryStartKiB
  const cpuSamples: ElectronCpuUsage[] = []
  const started = Date.now()

  while (Date.now() - started < durationMs) {
    await delay(Math.min(intervalMs, durationMs - (Date.now() - started)))
    const metrics = app.getAppMetrics()
    memoryEndKiB = workingSetKiB(metrics)
    memoryPeakKiB = Math.max(memoryPeakKiB, memoryEndKiB)
    cpuSamples.push(classifyElectronCpuUsage(metrics, rendererProcessId, process.pid))
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
  }
}

export function median(values: readonly number[]): number {
  if (values.length === 0) return 0
  const sorted = [...values].sort((left, right) => left - right)
  const middle = Math.floor(sorted.length / 2)
  return sorted.length % 2 === 0
    ? (sorted[middle - 1]! + sorted[middle]!) / 2
    : sorted[middle]!
}

function averageCpu(samples: readonly ElectronCpuUsage[]): ElectronCpuUsage {
  if (samples.length === 0) {
    return { renderer: 0, gpu: 0, main: 0, rendererPlusGpu: 0 }
  }
  const totals = samples.reduce(
    (total, sample) => ({
      renderer: total.renderer + sample.renderer,
      gpu: total.gpu + sample.gpu,
      main: total.main + sample.main,
      rendererPlusGpu: total.rendererPlusGpu + sample.rendererPlusGpu,
    }),
    { renderer: 0, gpu: 0, main: 0, rendererPlusGpu: 0 },
  )
  return {
    renderer: totals.renderer / samples.length,
    gpu: totals.gpu / samples.length,
    main: totals.main / samples.length,
    rendererPlusGpu: totals.rendererPlusGpu / samples.length,
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

function delay(durationMs: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, Math.max(0, durationMs)))
}
