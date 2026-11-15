// One Node process owns the timed stream. Per-row external sleep processes can
// exceed the nominal cadence on CI before the qualifying match is even emitted.
const SOURCE = `const[m,d,r,e]=process.argv.slice(2),n=e==='crlf'?'\\r\\n':'\\n';let i=0;function tick(){if(i===150){process.stdout.write(d+n);return}let s='stream filler '+i+n;if(i===30)s+=m+n;i++;const next=()=>setTimeout(tick,20);if(process.stdout.write(s))next();else process.stdout.once('drain',next)}const start=()=>setTimeout(tick,200);if(r&&!process.stdout.write(r+n))process.stdout.once('drain',start);else start();`

/** Developer smoke already requires Node in this supervised shell's PATH. */
export function terminalSearchStreamProducer(options: {
  matchVariable: string
  doneVariable: string
  readyVariable?: string
  lineEnding: 'lf' | 'crlf'
}): string {
  const { matchVariable, doneVariable, readyVariable, lineEnding } = options
  for (const variable of [matchVariable, doneVariable, readyVariable])
    if (variable !== undefined && !/^[A-Za-z_][A-Za-z0-9_]*$/.test(variable))
      throw new Error('terminal-stream-producer-variable')
  const source = Buffer.from(SOURCE).toString('base64')
  // Only variable references and encoded code are echoed; neither the actual
  // search needle nor the completion marker can become retained command text.
  return `node -e "eval(Buffer.from(process.argv[1],'base64').toString())" '${source}' "$${matchVariable}" "$${doneVariable}" ${readyVariable ? `"$${readyVariable}"` : "''"} '${lineEnding}'`
}
