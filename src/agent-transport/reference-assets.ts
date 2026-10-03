import { readFileSync, existsSync } from 'node:fs'
import { resolve, dirname, basename } from 'node:path'

import { AGENT_GUIDE_TOPICS as topics } from '../shared/agent/reference-catalog'
/** Static reference reads only fixed installed assets; it never starts a runtime owner. */
export function readAgentGuide(topic?: string): unknown {
  if (!topic) return Object.entries(topics).map(([id, title]) => ({ id, title }))
  if (!Object.hasOwn(topics, topic)) throw new Error('Unknown guide topic')
  const directory = basename(__dirname) === 'chunks' ? dirname(__dirname) : __dirname
  const packaged = resolve(directory, '../../../agent-guides', `${topic}.md`)
  const development = resolve(directory, '../../build/native/agent-guides', `${topic}.md`)
  return {
    id: topic,
    title: topics[topic as keyof typeof topics],
    content: readFileSync(existsSync(packaged) ? packaged : development, 'utf8'),
  }
}
