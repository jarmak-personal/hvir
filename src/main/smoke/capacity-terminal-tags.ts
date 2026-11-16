/** A synthetic VT background-cell witness, independent of glyph rasterization.
 * The producer and compositor reader share this exact bounded field layout. */
export const CAPACITY_TERMINAL_TAG_FIELDS = [
  ['row', 12],
  ['sequence', 10],
  ['columns', 8],
  ['rows', 8],
] as const
export const CAPACITY_TERMINAL_TAG_PREFIX = [0, 1, 0, 1, 0, 1, 0, 1] as const
export const CAPACITY_TERMINAL_TAG_COLORS = [
  [240, 16, 32],
  [16, 32, 240],
] as const
export interface CapacityTerminalTag {
  readonly row: number
  readonly sequence: number
  readonly columns: number
  readonly rows: number
}

export function capacityTerminalTagBits(tag: CapacityTerminalTag): readonly number[] {
  const result: number[] = [...CAPACITY_TERMINAL_TAG_PREFIX]
  for (const [field, bits] of CAPACITY_TERMINAL_TAG_FIELDS) {
    const value = tag[field]
    if (!Number.isSafeInteger(value) || value < 0 || value >= 2 ** bits)
      throw new Error('capacity-terminal-tag-field')
    for (let bit = 0; bit < bits; bit++) result.push((value >>> bit) & 1)
  }
  return result
}

/** Sample the middle of each known actual terminal cell in a clipped BGRA
 * bitmap. No OCR, parser readback or DOM overlay can satisfy this witness. */
export function readCapacityTerminalTag(
  bitmap: Uint8Array,
  width: number,
  height: number,
  cellWidth: number,
  firstCenter: number,
): CapacityTerminalTag | undefined {
  if (
    !Number.isSafeInteger(width) ||
    !Number.isSafeInteger(height) ||
    width < 1 ||
    height < 1 ||
    bitmap.length !== width * height * 4 ||
    !Number.isFinite(cellWidth) ||
    cellWidth < 1 ||
    !Number.isFinite(firstCenter) ||
    firstCenter < 0
  )
    return
  const bits: number[] = []
  const count =
    CAPACITY_TERMINAL_TAG_PREFIX.length +
    CAPACITY_TERMINAL_TAG_FIELDS.reduce((sum, [, size]) => sum + size, 0)
  for (let index = 0; index < count; index++) {
    const x = Math.floor(firstCenter + index * cellWidth)
    if (x < 0 || x >= width) return
    const offset = (Math.floor(height / 2) * width + x) * 4
    if (bitmap[offset + 3]! < 240) return
    const color = CAPACITY_TERMINAL_TAG_COLORS.findIndex(
      ([red, green, blue]) =>
        Math.abs(bitmap[offset + 2]! - red) <= 12 &&
        Math.abs(bitmap[offset + 1]! - green) <= 12 &&
        Math.abs(bitmap[offset]! - blue) <= 12,
    )
    if (color < 0) return
    bits.push(color)
  }
  if (CAPACITY_TERMINAL_TAG_PREFIX.some((value, index) => bits[index] !== value)) return
  let offset: number = CAPACITY_TERMINAL_TAG_PREFIX.length
  const tag = { row: 0, sequence: 0, columns: 0, rows: 0 }
  for (const [field, size] of CAPACITY_TERMINAL_TAG_FIELDS) {
    for (let bit = 0; bit < size; bit++) tag[field] += bits[offset++]! * 2 ** bit
  }
  if (tag.columns < count || tag.rows < 2) return
  return tag
}

/** Source text runs only as the deterministic real-PTY capacity producer. */
export function capacityTerminalTaggedProducer(): string {
  return String.raw`
const fields=${JSON.stringify(CAPACITY_TERMINAL_TAG_FIELDS)};
const prefix=${JSON.stringify(CAPACITY_TERMINAL_TAG_PREFIX)};
const colors=${JSON.stringify(CAPACITY_TERMINAL_TAG_COLORS)};
const input=process.stdin,output=process.stdout;
if(!input.isTTY||!output.isTTY)throw new Error('capacity-fixture-requires-real-tty');
input.setRawMode(true);input.resume();
let row=0,sequence=0,pendingResize=0,buffer='';
const geometry=()=>({columns:output.columns,rows:output.rows});
const metadata=(kind,seq)=>{
 const g=geometry();output.write('\x1b]9999;hvir-capacity;'+[kind,seq,row,g.columns,g.rows].join(';')+'\x07');
};
const line=(seq,kind)=>{
 const g=geometry();const tag={row:++row,sequence:seq,...g};
 let bits=[...prefix];
 for(const [field,size]of fields){
  if(!Number.isSafeInteger(tag[field])||tag[field]<0||tag[field]>=2**size)throw new Error('capacity-fixture-tag-overflow');
  for(let bit=0;bit<size;bit++)bits.push((tag[field]>>>bit)&1);
 }
 if(g.columns<bits.length+8||g.rows<2)throw new Error('capacity-fixture-geometry');
 let data=row>1?'\r\n':'';
 if(seq%3===2)data+='\x1b[?2026h';
 for(const bit of bits)data+='\x1b[48;2;'+colors[bit].join(';')+'m ';
 data+='\x1b[0m '+(seq%3===1?'\x1b[32mANSI λ 漢字\x1b[0m':'plain')+' '+row;
 if(seq%3===2)data+='\x1b[?2026l';
 metadata(kind,seq);output.write(data);
};
metadata('armed',0);
input.on('data',chunk=>{
 for(const byte of chunk){
  if(byte===3){input.setRawMode(false);process.exit(0);}
  if(byte===13||byte===10){
   const match=/^(start|output|echo|prepare|position):([0-9]{1,4})$/.exec(buffer);buffer='';
   if(!match)continue;
   const seq=Number(match[2]);
   if(match[1]==='start'){
    if(row!==0)throw new Error('capacity-fixture-started-twice');
    output.write('\x1b[2J\x1b[H');
    for(let i=0;i<300;i++)output.write('\x1b]133;A\x07p\r\n\x1b]133;B\x07c\r\n\x1b]133;C\x07o\r\n\x1b]133;D;0\x07');
    for(let i=0;i<3000;i++)line(0,'initial');
    metadata('ready',0);
   }
   else if(match[1]==='prepare'){pendingResize=seq;metadata('armed',seq);}
   else if(match[1]==='position'){metadata('positioned',seq);}
   else{sequence=seq;line(sequence,match[1]);}
  }else if(byte>=32&&byte<=126&&buffer.length<48)buffer+=String.fromCharCode(byte);
 }
});
output.on('resize',()=>{metadata('positioned',0);if(pendingResize){const seq=pendingResize;pendingResize=0;sequence=seq;line(seq,'resize');}});
const close=()=>{try{input.setRawMode(false);}finally{process.exit(0);}};
process.on('SIGTERM',close);process.on('SIGHUP',close);
`
}
