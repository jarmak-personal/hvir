import { describe, expect, it } from 'vitest'

import {
  classifyElectronCpuUsage,
  median,
} from '../src/main/smoke/electron-process-metrics'

describe('Electron process metric aggregation', () => {
  it('separates named processes and reports all child-process CPU', () => {
    const metrics = [
      processMetric(10, 'Browser', 2.5),
      processMetric(20, 'Tab', 4),
      processMetric(30, 'GPU', 1.5),
      processMetric(31, 'GPU', 0.5),
      processMetric(40, 'Utility', 8),
    ]

    expect(classifyElectronCpuUsage(metrics, 20, 10)).toEqual({
      renderer: 4,
      gpu: 2,
      main: 2.5,
      aggregateChildren: 14,
      rendererPlusGpu: 6,
    })
  })

  it('calculates odd and even medians without mutating samples', () => {
    const samples = [4, 1, 3, 2]
    expect(median(samples)).toBe(2.5)
    expect(samples).toEqual([4, 1, 3, 2])
    expect(median([9, 2, 5])).toBe(5)
    expect(median([])).toBe(0)
  })
})

function processMetric(pid: number, type: string, cpu: number) {
  return {
    pid,
    type,
    cpu: { percentCPUUsage: cpu, idleWakeupsPerSecond: 0 },
    creationTime: 0,
    memory: { workingSetSize: 0, peakWorkingSetSize: 0, privateBytes: 0 },
    sandboxed: false,
    integrityLevel: 'unknown',
  } as Parameters<typeof classifyElectronCpuUsage>[0][number]
}
