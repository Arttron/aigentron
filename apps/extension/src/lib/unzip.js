// Reads a zip archive (the one the server builds: deflate or stored, no zip64) and checks every file's CRC-32.

const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return t;
})();

export function crc32(bytes) {
  let c = 0xffffffff;
  for (let i = 0; i < bytes.length; i++) c = CRC_TABLE[(c ^ bytes[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

async function inflateRaw(data) {
  const stream = new Blob([data]).stream().pipeThrough(new DecompressionStream('deflate-raw'));
  return new Uint8Array(await new Response(stream).arrayBuffer());
}

/** → Map(name → Uint8Array). Throws on a broken archive, a file that does not match its CRC, or a path that climbs out. */
export async function readZip(buffer) {
  const buf = buffer instanceof Uint8Array ? buffer : new Uint8Array(buffer);
  const dv = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
  let end = -1;
  for (let i = buf.length - 22; i >= Math.max(0, buf.length - 65_557); i--) {
    if (dv.getUint32(i, true) === 0x06054b50) {
      end = i;
      break;
    }
  }
  if (end < 0) throw new Error('This is not a zip archive');
  const count = dv.getUint16(end + 10, true);
  let p = dv.getUint32(end + 16, true);
  const files = new Map();
  const dec = new TextDecoder();
  for (let i = 0; i < count; i++) {
    if (dv.getUint32(p, true) !== 0x02014b50) throw new Error('The zip directory is damaged');
    const method = dv.getUint16(p + 10, true);
    const crc = dv.getUint32(p + 16, true);
    const csize = dv.getUint32(p + 20, true);
    const usize = dv.getUint32(p + 24, true);
    const nlen = dv.getUint16(p + 28, true);
    const elen = dv.getUint16(p + 30, true);
    const clen = dv.getUint16(p + 32, true);
    const off = dv.getUint32(p + 42, true);
    const name = dec.decode(buf.subarray(p + 46, p + 46 + nlen));
    p += 46 + nlen + elen + clen;
    if (name.endsWith('/')) continue; // a folder entry
    if (name.startsWith('/') || name.split('/').some((s) => s === '..' || s === '') || name.includes('\\')) throw new Error(`The archive has an unsafe path: ${name}`);
    const lnlen = dv.getUint16(off + 26, true);
    const lelen = dv.getUint16(off + 28, true);
    const raw = buf.subarray(off + 30 + lnlen + lelen, off + 30 + lnlen + lelen + csize);
    const data = method === 0 ? new Uint8Array(raw) : method === 8 ? await inflateRaw(raw) : null;
    if (!data) throw new Error(`${name}: unsupported compression`);
    if (data.length !== usize || crc32(data) !== crc) throw new Error(`${name}: the file is damaged (checksum)`);
    files.set(name, data);
  }
  return files;
}
