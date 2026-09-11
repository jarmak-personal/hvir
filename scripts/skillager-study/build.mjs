import process from 'node:process'
import console from 'node:console'
import { build } from 'esbuild'
import { readFile, mkdir, writeFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import { fileURLToPath, URL } from 'node:url'
const root = fileURLToPath(new URL('.', import.meta.url))
const output = resolve(process.argv[2] || '/tmp/hvir-skillager-study')
const bundle = await build({
  entryPoints: [resolve(root, 'study.mjs')],
  bundle: true,
  write: false,
  format: 'iife',
  platform: 'browser',
})
const html = (await readFile(resolve(root, 'shell.html'), 'utf8'))
  .replace(
    '<!-- STYLE -->',
    `<style>${await readFile(resolve(root, 'study.css'), 'utf8')}</style>`,
  )
  .replace(
    '<!-- SCRIPT -->',
    `<script>${bundle.outputFiles[0].text.replaceAll('</script', '<\\/script')}</script>`,
  )
await mkdir(output, { recursive: true })
await writeFile(resolve(output, 'index.html'), html)
console.log(resolve(output, 'index.html'))
