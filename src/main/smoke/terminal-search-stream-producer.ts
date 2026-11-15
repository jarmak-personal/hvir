// Fixed Node producers avoid per-tick external sleep processes. Neither workload
// catches up by dropping rows; backpressure drains before its next 20 ms timer.
const STREAM_SOURCE = `const[m,d,r,e]=process.argv.slice(2),n=e==='crlf'?'\\r\\n':'\\n';let i=0;function tick(){if(i===150){process.stdout.write(d+n);return}let s='stream filler '+i+n;if(i===30)s+=m+n;i++;const next=()=>setTimeout(tick,20);if(process.stdout.write(s))next();else process.stdout.once('drain',next)}const start=()=>setTimeout(tick,200);if(r&&!process.stdout.write(r+n))process.stdout.once('drain',start);else start();`
const EVICTION_SOURCE = `const[,d,,e]=process.argv.slice(2),n=e==='crlf'?'\\r\\n':'\\n';let i=0;function tick(){if(i===300){process.stdout.write(d+n);return}i++;const next=()=>setTimeout(tick,20);if(process.stdout.write(('unrelated output'+n).repeat(50)))next();else process.stdout.once('drain',next)}tick();`

type LineEnding = 'lf' | 'crlf'

/** Developer smoke already requires Node in this supervised shell's PATH. */
export function terminalSearchStreamProducer(options: {
  matchVariable: string
  doneVariable: string
  readyVariable?: string
  lineEnding: LineEnding
}): string {
  return producerCommand(STREAM_SOURCE, options)
}

/** The capacity fixture retains its fixed 300 batches of 50 complete rows. */
export function terminalSearchEvictionProducer(options: {
  doneVariable: string
  lineEnding: LineEnding
}): string {
  return producerCommand(EVICTION_SOURCE, options)
}

function producerCommand(
  source: string,
  options: {
    matchVariable?: string
    doneVariable: string
    readyVariable?: string
    lineEnding: LineEnding
  },
): string {
  const { matchVariable, doneVariable, readyVariable, lineEnding } = options
  for (const variable of [matchVariable, doneVariable, readyVariable])
    if (variable !== undefined && !/^[A-Za-z_][A-Za-z0-9_]*$/.test(variable))
      throw new Error('terminal-stream-producer-variable')
  const encoded = Buffer.from(source).toString('base64')
  // Echoed commands contain only encoded code and quoted variable references.
  return `node -e "eval(Buffer.from(process.argv[1],'base64').toString())" '${encoded}' ${matchVariable ? `"$${matchVariable}"` : "''"} "$${doneVariable}" ${readyVariable ? `"$${readyVariable}"` : "''"} '${lineEnding}'`
}
