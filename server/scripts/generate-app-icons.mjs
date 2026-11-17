// Use the device's own renderer so the app icon and happy face stay identical.
import { B, boxBot, MOODS } from '../public/bolt.js';
import { deflateSync } from 'node:zlib';
import { writeFileSync } from 'node:fs';
const bitmap=new B(320,320);
boxBot(bitmap,48,98,224,162,MOODS.happy,0);
// The approved preview adds one source pixel around each stroke for icon weight.
const iconPixel=(x,y)=>bitmap.get(x,y)||bitmap.get(x-1,y)||bitmap.get(x+1,y)||bitmap.get(x,y-1)||bitmap.get(x,y+1);
function crc32(bytes) {
  let crc=0xffffffff;
  for(const byte of bytes) { crc^=byte; for(let i=0;i<8;i++) crc=(crc>>>1)^((crc&1)?0xedb88320:0); }
  return (crc^0xffffffff)>>>0;
}
function chunk(type,data) {
  const tag=Buffer.from(type), size=Buffer.alloc(4), crc=Buffer.alloc(4);
  size.writeUInt32BE(data.length); crc.writeUInt32BE(crc32(Buffer.concat([tag,data])));
  return Buffer.concat([size,tag,data,crc]);
}
for(const [file,size] of [['icon-192.png',192],['icon-512.png',512],['apple-touch-icon.png',180]]) {
  const pixels=Buffer.alloc((size*3+1)*size);
  for(let y=0;y<size;y++) for(let x=0;x<size;x++) {
    const color=iconPixel(Math.floor(x*320/size),Math.floor(y*320/size))?[27,27,25]:[233,230,220];
    const offset=y*(size*3+1)+1+x*3;
    color.forEach((v,i)=>pixels[offset+i]=v);
  }
  const header=Buffer.alloc(13); header.writeUInt32BE(size,0);header.writeUInt32BE(size,4);header[8]=8;header[9]=2;
  writeFileSync(new URL(`../public/${file}`,import.meta.url),Buffer.concat([Buffer.from([137,80,78,71,13,10,26,10]),chunk('IHDR',header),chunk('IDAT',deflateSync(pixels)),chunk('IEND',Buffer.alloc(0))]));
}
