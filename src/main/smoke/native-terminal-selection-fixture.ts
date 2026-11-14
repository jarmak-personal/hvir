import { createHash } from 'node:crypto'

export const PREFIX = '__HVIR_NATIVE_SELECTION_'
export const NATIVE_SELECTION_RETENTION_MARKER = 'HVIR_M9_RETENTION_EPOCH'
export const NATIVE_READONLY_SELECTION = 'HVIR_READONLY_SELECTION'
const LARGE_ROWS = 4096

/** Synthetic goldens come from the fixture, never from observed selected text. */
export function nativeSelectionFixture(columns: number) {
  const word = 'alpha beta',
    unicode = '  A界e\u0301B  ',
    wrap = 'w'.repeat(columns) + 'tail'
  const plain = './package.json',
    external = 'https://example.com/native-selection'
  return { word, unicode, wrap, plain, external }
}
export function nativeSelectionLargeRow(columns: number, row: number): string {
  const prefix = 'L' + String(row).padStart(4, '0') + ':'
  return prefix + 'x'.repeat(columns - prefix.length)
}
export function nativeSelectionLargeExpected(columns: number) {
  const hash = createHash('sha256')
  let bytes = 0
  for (let row = 0; row < LARGE_ROWS; row++) {
    const text =
      nativeSelectionLargeRow(columns, row) + (row + 1 === LARGE_ROWS ? '' : '\n')
    hash.update(text)
    bytes += Buffer.byteLength(text)
  }
  return { bytes, sha256: hash.digest('hex') }
}

/** One raw recorder in the already-owned Shell PTY. Only fixed protocol markers are observed. */
export function nativeSelectionRecorderSource(
  columns: number,
  rows: number,
  fileUri: string,
  loopback: string,
): string {
  const fixture = nativeSelectionFixture(columns)
  return `
const prefix=${JSON.stringify(PREFIX)}, fixture=${JSON.stringify(fixture)}, columns=${columns}, rows=${rows}, fileUri=${JSON.stringify(fileUri)}, loopback=${JSON.stringify(loopback)};
let command=null, waiting=false, query='', phase='', producing=false, produced=0, producerTimer, producerDeadline, largeRow=0, closed=false;
const marker=text=>process.stdout.write('\\x1b]0;'+prefix+text+'__\\x07');
const stopProducer=()=>{producing=false;clearTimeout(producerTimer);clearTimeout(producerDeadline);process.stdout.off('drain',produce);};
const stop=code=>{if(closed)return;closed=true;stopProducer();clearTimeout(deadline);process.stdin.setRawMode(false);process.stdin.pause();process.stdout.write('\\x1b[?1000l\\x1b[?1006l\\x1b[?1049l',()=>process.exit(code));};
const fail=reason=>{marker('FAILED_'+reason);stop(2);};
const row=(n,text)=>'\\x1b['+(n+1)+';1H'+text;
const setup=()=>{process.stdout.write('\\x1b[?1049h\\x1b[?25l\\x1b[?1000l\\x1b[?1006l\\x1b[?1004l\\x1b[?2004l\\x1b[2J'+row(4,'\\x1b[48;2;0;0;255;97m'+fixture.word+'\\x1b[0m')+row(6,fixture.unicode)+row(8,fixture.wrap)+row(11,'\\x1b]8;;'+fileUri+'\\x1b\\\\OSC8-file\\x1b]8;;\\x1b\\\\')+row(13,fixture.plain)+row(15,loopback)+row(17,fixture.external));};
function produce(){if(!producing||closed)return;if(produced>=262144)return fail('continuous-cap');const ready=produced>=65536&&phase==='continuous-warmup';if(ready){phase='continuous';marker('CONTINUOUS_TRIGGER_'+produced);}let body=('\\x1b7'+row(rows-2,'\\r\\x1b[2Kunrelated-output')+'\\x1b8').repeat(16);produced+=Buffer.byteLength(body);if(process.stdout.write(body)===false)process.stdout.once('drain',produce);else producerTimer=setTimeout(produce,0);}
function large(){while(largeRow<${LARGE_ROWS}){const n=largeRow++,head='L'+String(n).padStart(4,'0')+':',body=head+'x'.repeat(columns-head.length)+(largeRow===${LARGE_ROWS}?'':'\\r\\n');if(!process.stdout.write(body)){process.stdout.once('drain',large);return;}}waiting=true;query='';process.stdout.write('\\x1b[5n');}
const start=name=>{stopProducer();phase=name;if(name==='quit'){marker('CLOSED');stop(0);return;}if(name==='grid'||name==='continuous-warmup'){setup();waiting=true;query='';process.stdout.write('\\x1b[5n');return;}if(name==='primary'){process.stdout.write('\\x1b[?1049l');waiting=true;query='';process.stdout.write('\\x1b[5n');return;}if(name==='large'){process.stdout.write('\\x1b[?1049l');largeRow=0;large();return;}fail('command');};
process.stdin.setRawMode(true);process.stdin.resume();
process.stdin.on('data',data=>{for(const byte of data){if(command!==null){if(byte===29){const name=command;command=null;start(name);}else command+=String.fromCharCode(byte);continue;}if(byte===29){command='';continue;}if(waiting){query+=String.fromCharCode(byte);if(query.length===4){if(query!=='\\x1b[0n')return fail('query');waiting=false;marker(phase.toUpperCase()+'_READY');if(phase==='continuous-warmup'){producing=true;producerDeadline=setTimeout(()=>fail('continuous-deadline'),2000);produce();}}continue;}if(byte===3&&phase==='continuous'){const active=producing;stopProducer();if(!active)return fail('continuous-inactive');marker('CONTINUOUS_INTERRUPTED_'+produced);continue;}if(byte===3&&phase==='large'){process.stdout.write('\\x1b[Hchanged');marker('LARGE_INTERRUPTED');continue;}if(byte===97&&phase==='large'){marker('LARGE_KEY');continue;}return fail('unexpected-input');}});
const deadline=setTimeout(()=>fail('deadline'),45000);marker('READY');
`
}
