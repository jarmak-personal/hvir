import { afterEach, describe, expect, it, vi } from 'vitest'

const metricsPort = vi.hoisted(() => ({ getAppMetrics: vi.fn() }))
vi.mock('electron', () => ({ app: metricsPort }))

import {
  classifyElectronCpuUsage,
  median,
  sampleElectronProcessMetrics,
} from '../src/main/smoke/electron-process-metrics'

describe('Electron process metric aggregation', () => {
  afterEach(() => vi.useRealTimers())

  it('takes the final actual sample when stopped and cancels its pending interval', async () => {
    vi.useFakeTimers()
    metricsPort.getAppMetrics
      .mockReturnValueOnce([processMetric(20, 'Tab', 1)])
      .mockReturnValueOnce([processMetric(20, 'Tab', 7)])
    const stop = new AbortController()
    const report = sampleElectronProcessMetrics(20, Infinity, 1000, stop.signal)
    await vi.advanceTimersByTimeAsync(125)
    stop.abort()
    expect(await report).toMatchObject({
      durationMs: 125,
      samples: 1,
      cpu: { renderer: 7 },
    })
    expect(metricsPort.getAppMetrics).toHaveBeenCalledTimes(2)
    expect(vi.getTimerCount()).toBe(0)
  })

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
      nativeHost: 0,
      wholeApp: 16.5,
    })
  })

  it('includes native utility work in whole-app CPU without hiding it in renderer/GPU', () => {
    const native = {
      ...processMetric(40, 'Utility', 8),
      name: 'hvir-native-terminal',
      serviceName: 'node.mojom.NodeService',
    }
    const unrelated = {
      ...processMetric(41, 'Utility', 3),
      name: 'hvir-other-worker',
      serviceName: 'node.mojom.NodeService',
    }
    expect(
      classifyElectronCpuUsage(
        [
          processMetric(10, 'Browser', 2),
          processMetric(20, 'Tab', 4),
          processMetric(30, 'GPU', 1),
          native,
          unrelated,
        ],
        20,
        10,
      ),
    ).toMatchObject({
      rendererPlusGpu: 5,
      nativeHost: 8,
      aggregateChildren: 16,
      wholeApp: 18,
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
