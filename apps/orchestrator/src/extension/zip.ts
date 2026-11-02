import { crc32, deflateRawSync } from 'node:zlib';

export interface ZipEntry {
  /** Path inside the archive, forward slashes, no leading slash. */
  name: string;
  data: Buffer;
}

/** DOS date / time words of a Date (2-second resolution, local fields). */
function dos(d: Date): { time: number; date: number } {
  return {
    time: (d.getHours() << 11) | (d.getMinutes() << 5) | Math.floor(d.getSeconds() / 2),
    date: (Math.max(0, d.getFullYear() - 1980) << 9) | ((d.getMonth() + 1) << 5) | d.getDate(),
  };
}

/** A zip archive (deflate, no zip64: the extension is a few hundred KB) — written by hand so the server needs no archive library. */
export function createZip(entries: readonly ZipEntry[], when = new Date()): Buffer {
  const { time, date } = dos(when);
  const locals: Buffer[] = [];
  const central: Buffer[] = [];
  let offset = 0;
  for (const e of entries) {
    if (!e.name || e.name.startsWith('/') || e.name.includes('..') || e.name.includes('\\')) throw new Error(`bad entry name "${e.name}"`);
    const name = Buffer.from(e.name, 'utf8');
    const packed = deflateRawSync(e.data, { level: 9 });
    const useDeflate = packed.length < e.data.length;
    const body = useDeflate ? packed : e.data;
    const crc = crc32(e.data) >>> 0;
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4); // version needed
    local.writeUInt16LE(0x0800, 6); // flags: UTF-8 names
    local.writeUInt16LE(useDeflate ? 8 : 0, 8);
    local.writeUInt16LE(time, 10);
    local.writeUInt16LE(date, 12);
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(body.length, 18);
    local.writeUInt32LE(e.data.length, 22);
    local.writeUInt16LE(name.length, 26);
    local.writeUInt16LE(0, 28);
    locals.push(local, name, body);
    const cd = Buffer.alloc(46);
    cd.writeUInt32LE(0x02014b50, 0);
    cd.writeUInt16LE(0x031e, 4); // made by: unix, 3.0
    cd.writeUInt16LE(20, 6);
    cd.writeUInt16LE(0x0800, 8);
    cd.writeUInt16LE(useDeflate ? 8 : 0, 10);
    cd.writeUInt16LE(time, 12);
    cd.writeUInt16LE(date, 14);
    cd.writeUInt32LE(crc, 16);
    cd.writeUInt32LE(body.length, 20);
    cd.writeUInt32LE(e.data.length, 24);
    cd.writeUInt16LE(name.length, 28);
    cd.writeUInt32LE(((0o100644 << 16) >>> 0), 38); // external attributes: a regular file, rw-r--r--
    cd.writeUInt32LE(offset, 42);
    central.push(cd, name);
    offset += local.length + name.length + body.length;
  }
  const centralBuf = Buffer.concat(central);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(entries.length, 8);
  end.writeUInt16LE(entries.length, 10);
  end.writeUInt32LE(centralBuf.length, 12);
  end.writeUInt32LE(offset, 16);
  return Buffer.concat([...locals, centralBuf, end]);
}
