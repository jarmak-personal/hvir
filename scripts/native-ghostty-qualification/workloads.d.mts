export const RESET: string
export function numberedLines(prefix: string, count: number, body?: string): string[]
export interface Fixture {
  name: string
  bytes: string
  expected: string
}
export function burst(name: string, count?: number): Fixture
export function unicodeFixture(): Fixture
export function demoFixture(count?: number): Fixture
export function normalize(text: string): string
export function distribution(samples: number[]): {
  count: number
  p50: number | null
  p95: number | null
  p99: number | null
  max: number | null
}
