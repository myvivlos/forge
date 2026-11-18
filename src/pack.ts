import { createHash } from 'node:crypto';
import { deflateSync, inflateSync } from 'node:zlib';
import { hashGitObject } from './git-objects.ts';
import type { GitObjectRecord, GitObjectType } from './types.ts';

export const PKT_LINE_MAX = 65520;
export const PKT_LINE_MAX_PAYLOAD = PKT_LINE_MAX - 4;
/** Maximum raw pack/report bytes per sideband-64k pkt-line (4-byte header + 1-byte band = 5). */
export const SIDEBAND_MAX_CHUNK = PKT_LINE_MAX - 5;

export const PKT_FLUSH = Buffer.from('0000', 'ascii');
export const PKT_DELIM = Buffer.from('0001', 'ascii');
export const PKT_RESPONSE_END = Buffer.from('0002', 'ascii');

const HEX4_RE = /^[0-9a-fA-F]{4}$/;

const TYPE_TO_CODE: Readonly<Record<GitObjectType, number>> = {
  commit: 1,
  tree: 2,
  blob: 3,
  tag: 4,
};

const CODE_TO_TYPE: Readonly<Record<number, GitObjectType>> = {
  1: 'commit',
  2: 'tree',
  3: 'blob',
  4: 'tag',
};

export class PktLineError extends Error {}
export class PackError extends Error {}

export type DecodedPacket =
  | { readonly kind: 'data'; readonly payload: Buffer }
  | { readonly kind: 'flush' | 'delim' | 'response-end' };

/** Encode one data pkt-line with its 4-hex length prefix. */
export function encodePktLine(payload: string | Buffer): Buffer {
  const data = typeof payload === 'string' ? Buffer.from(payload, 'utf8') : payload;
  if (data.length > PKT_LINE_MAX_PAYLOAD) {
    throw new PktLineError(`pkt-line payload ${data.length} exceeds maximum ${PKT_LINE_MAX_PAYLOAD}`);
  }
  const out = Buffer.allocUnsafe(4 + data.length);
  out.write((data.length + 4).toString(16).padStart(4, '0'), 0, 4, 'ascii');
  data.copy(out, 4);
  return out;
}

/** Encode a sequence of pkt-line items into one Buffer. */
export function encodePktLines(
  items: ReadonlyArray<string | Buffer | 'flush' | 'delim' | 'response-end'>,
): Buffer {
  const parts: Buffer[] = [];
  for (const item of items) {
    if (item === 'flush') parts.push(PKT_FLUSH);
    else if (item === 'delim') parts.push(PKT_DELIM);
    else if (item === 'response-end') parts.push(PKT_RESPONSE_END);
    else parts.push(encodePktLine(item));
  }
  return Buffer.concat(parts);
}

/** Frame `data` into sideband-64k pkt-lines for the given band (1=data, 2=progress, 3=error). */
export function encodeSideband(band: 1 | 2 | 3, data: Buffer): Buffer[] {
  if (data.length === 0) return [];
  const packets: Buffer[] = [];
  for (let offset = 0; offset < data.length; offset += SIDEBAND_MAX_CHUNK) {
    const end = Math.min(data.length, offset + SIDEBAND_MAX_CHUNK);
    const chunkLen = end - offset;
    const pktLen = chunkLen + 5;
    const pkt = Buffer.allocUnsafe(pktLen);
    pkt.write(pktLen.toString(16).padStart(4, '0'), 0, 4, 'ascii');
    pkt[4] = band;
    data.copy(pkt, 5, offset, end);
    packets.push(pkt);
  }
  return packets;
}

/**
 * Parse pkt-lines from `buf`. When `stopOnFlush` is true, stops right after the first `0000`
 * flush packet and returns `restOffset` pointing to the remaining raw bytes (e.g. a packfile).
 */
export function parsePktLineStream(
  buf: Buffer,
  stopOnFlush = false,
): { readonly packets: DecodedPacket[]; readonly restOffset: number } {
  const packets: DecodedPacket[] = [];
  let offset = 0;
  while (offset < buf.length) {
    if (offset + 4 > buf.length) {
      throw new PktLineError(`truncated pkt-line header at offset ${offset}`);
    }
    const header = buf.subarray(offset, offset + 4).toString('ascii');
    if (!HEX4_RE.test(header)) {
      throw new PktLineError(`invalid pkt-line header ${JSON.stringify(header)} at offset ${offset}`);
    }
    const len = Number.parseInt(header, 16);
    if (len === 0) {
      offset += 4;
      packets.push({ kind: 'flush' });
      if (stopOnFlush) return { packets, restOffset: offset };
      continue;
    }
    if (len === 1) {
      offset += 4;
      packets.push({ kind: 'delim' });
      continue;
    }
    if (len === 2) {
      offset += 4;
      packets.push({ kind: 'response-end' });
      continue;
    }
    if (len === 3 || len > PKT_LINE_MAX) {
      throw new PktLineError(`invalid pkt-line length ${len} at offset ${offset}`);
    }
    if (offset + len > buf.length) {
      throw new PktLineError(`truncated pkt-line: expected ${len} bytes at offset ${offset}, have ${buf.length - offset}`);
    }
    packets.push({ kind: 'data', payload: buf.subarray(offset + 4, offset + len) });
    offset += len;
  }
  return { packets, restOffset: offset };
}

function writePackObjectHeader(type: GitObjectType, size: number): Buffer {
  const code = TYPE_TO_CODE[type];
  const bytes: number[] = [];
  let remaining = size;
  let first = (code << 4) | (remaining & 0x0f);
  remaining = Math.floor(remaining / 16);
  while (remaining > 0) {
    bytes.push(first | 0x80);
    first = remaining & 0x7f;
    remaining = Math.floor(remaining / 128);
  }
  bytes.push(first);
  return Buffer.from(bytes);
}

/** Build a version-2 packfile from plain (non-delta) objects with trailing SHA-1 checksum. */
export function writePack(objects: ReadonlyArray<GitObjectRecord>): Buffer {
  const header = Buffer.allocUnsafe(12);
  header.write('PACK', 0, 4, 'ascii');
  header.writeUInt32BE(2, 4);
  header.writeUInt32BE(objects.length, 8);

  const parts: Buffer[] = [header];
  let bodyLen = 12;
  for (let i = 0; i < objects.length; i += 1) {
    const obj = objects[i]!;
    const objHdr = writePackObjectHeader(obj.type, obj.data.length);
    const compressed = deflateSync(obj.data);
    parts.push(objHdr, compressed);
    bodyLen += objHdr.length + compressed.length;
  }

  const out = Buffer.allocUnsafe(bodyLen + 20);
  let offset = 0;
  for (let i = 0; i < parts.length; i += 1) {
    const part = parts[i]!;
    part.copy(out, offset);
    offset += part.length;
  }
  const digest = createHash('sha1').update(out.subarray(0, bodyLen)).digest();
  digest.copy(out, bodyLen);
  return out;
}

function readVarintSize(buffer: Buffer, start: number): { readonly typeCode: number; readonly size: number; readonly next: number } {
  if (start >= buffer.length) throw new PackError('truncated pack entry header');
  let byte = buffer[start]!;
  const typeCode = (byte >> 4) & 0x07;
  let size = byte & 0x0f;
  let shift = 4;
  let offset = start + 1;
  while ((byte & 0x80) !== 0) {
    if (offset >= buffer.length) throw new PackError('truncated pack entry size varint');
    byte = buffer[offset++]!;
    size += (byte & 0x7f) * 2 ** shift;
    shift += 7;
    if (shift > 63) throw new PackError('pack entry size varint overflow');
  }
  return { typeCode, size, next: offset };
}

function readOfsDeltaOffset(buffer: Buffer, start: number): { readonly relOffset: number; readonly next: number } {
  if (start >= buffer.length) throw new PackError('truncated ofs-delta offset');
  let byte = buffer[start]!;
  let offset = start + 1;
  let value = byte & 0x7f;
  while ((byte & 0x80) !== 0) {
    if (offset >= buffer.length) throw new PackError('truncated ofs-delta offset');
    byte = buffer[offset++]!;
    value = (value + 1) * 128 + (byte & 0x7f);
  }
  return { relOffset: value, next: offset };
}

function applyDelta(base: Buffer, delta: Buffer): Buffer {
  let offset = 0;
  const readDeltaSize = (): number => {
    let value = 0;
    let shift = 0;
    for (;;) {
      if (offset >= delta.length) throw new PackError('truncated delta size');
      const byte = delta[offset++]!;
      value += (byte & 0x7f) * 2 ** shift;
      shift += 7;
      if ((byte & 0x80) === 0) break;
      if (shift > 63) throw new PackError('delta size overflow');
    }
    return value;
  };

  const sourceSize = readDeltaSize();
  const targetSize = readDeltaSize();
  if (sourceSize !== base.length) {
    throw new PackError(`delta base size mismatch: expected ${sourceSize}, got ${base.length}`);
  }

  const out = Buffer.allocUnsafe(targetSize);
  let written = 0;
  while (offset < delta.length) {
    const op = delta[offset++]!;
    if ((op & 0x80) !== 0) {
      let copyOffset = 0;
      let copySize = 0;
      if ((op & 0x01) !== 0) {
        if (offset >= delta.length) throw new PackError('truncated delta copy offset');
        copyOffset |= delta[offset++]!;
      }
      if ((op & 0x02) !== 0) {
        if (offset >= delta.length) throw new PackError('truncated delta copy offset');
        copyOffset |= delta[offset++]! << 8;
      }
      if ((op & 0x04) !== 0) {
        if (offset >= delta.length) throw new PackError('truncated delta copy offset');
        copyOffset |= delta[offset++]! << 16;
      }
      if ((op & 0x08) !== 0) {
        if (offset >= delta.length) throw new PackError('truncated delta copy offset');
        copyOffset += delta[offset++]! * 0x1000000;
      }
      if ((op & 0x10) !== 0) {
        if (offset >= delta.length) throw new PackError('truncated delta copy size');
        copySize |= delta[offset++]!;
      }
      if ((op & 0x20) !== 0) {
        if (offset >= delta.length) throw new PackError('truncated delta copy size');
        copySize |= delta[offset++]! << 8;
      }
      if ((op & 0x40) !== 0) {
        if (offset >= delta.length) throw new PackError('truncated delta copy size');
        copySize |= delta[offset++]! << 16;
      }
      if (copySize === 0) copySize = 0x10000;
      if (copyOffset + copySize > base.length || written + copySize > targetSize) {
        throw new PackError('delta copy out of bounds');
      }
      base.copy(out, written, copyOffset, copyOffset + copySize);
      written += copySize;
    } else if (op !== 0) {
      if (offset + op > delta.length || written + op > targetSize) {
        throw new PackError('delta insert out of bounds');
      }
      delta.copy(out, written, offset, offset + op);
      offset += op;
      written += op;
    } else {
      throw new PackError('invalid delta opcode 0');
    }
  }

  if (written !== targetSize) {
    throw new PackError(`delta output size mismatch: wrote ${written}, expected ${targetSize}`);
  }
  return out;
}

interface RawPackEntry {
  readonly offset: number;
  readonly typeCode: number;
  readonly data: Buffer;
  readonly baseOffset?: number;
  readonly baseOid?: string;
  resolved?: { readonly type: GitObjectType; readonly data: Buffer; readonly oid: string };
}

/**
 * Parse a packfile (version 2 or 3), verify its SHA-1 trailer, inflate all entries, resolve
 * OFS_DELTA / REF_DELTA chains (using `resolveExternalBase` for thin packs), and return all
 * unpacked objects keyed by their recomputed SHA-1 OID.
 */
export function readPack(
  pack: Buffer,
  resolveExternalBase?: (oid: string) => GitObjectRecord | undefined,
): Map<string, GitObjectRecord> {
  if (pack.length < 32) {
    throw new PackError(`pack too short (${pack.length} bytes)`);
  }
  if (pack.subarray(0, 4).toString('ascii') !== 'PACK') {
    throw new PackError('missing PACK magic');
  }
  const version = pack.readUInt32BE(4);
  if (version !== 2 && version !== 3) {
    throw new PackError(`unsupported pack version ${version}`);
  }
  const declaredCount = pack.readUInt32BE(8);
  const trailerStart = pack.length - 20;
  const computedTrailer = createHash('sha1').update(pack.subarray(0, trailerStart)).digest();
  if (!computedTrailer.equals(pack.subarray(trailerStart))) {
    throw new PackError('pack checksum mismatch');
  }

  const rawEntries: RawPackEntry[] = [];
  const byOffset = new Map<number, RawPackEntry>();
  const packDataEnd = pack.subarray(0, trailerStart);
  let offset = 12;

  for (let i = 0; i < declaredCount; i += 1) {
    const entryOffset = offset;
    const hdr = readVarintSize(packDataEnd, offset);
    offset = hdr.next;

    let baseOffset: number | undefined;
    let baseOid: string | undefined;
    if (hdr.typeCode === 6) {
      const ofs = readOfsDeltaOffset(packDataEnd, offset);
      offset = ofs.next;
      if (ofs.relOffset <= 0 || ofs.relOffset > entryOffset) {
        throw new PackError(`invalid ofs-delta offset at ${entryOffset}`);
      }
      baseOffset = entryOffset - ofs.relOffset;
    } else if (hdr.typeCode === 7) {
      if (offset + 20 > trailerStart) throw new PackError('truncated ref-delta base oid');
      baseOid = packDataEnd.subarray(offset, offset + 20).toString('hex');
      offset += 20;
    } else if (CODE_TO_TYPE[hdr.typeCode] === undefined) {
      throw new PackError(`unknown pack object type ${hdr.typeCode}`);
    }

    let inflated: { buffer: Buffer; engine: { bytesWritten: number } };
    try {
      inflated = inflateSync(packDataEnd.subarray(offset), { info: true }) as unknown as {
        buffer: Buffer;
        engine: { bytesWritten: number };
      };
    } catch (err) {
      throw new PackError(`zlib inflate failed at offset ${entryOffset}: ${(err as Error).message}`);
    }
    const bytesRead = inflated.engine.bytesWritten;
    if (!bytesRead || bytesRead <= 0) {
      throw new PackError(`zlib inflate consumed 0 bytes at offset ${entryOffset}`);
    }
    if (inflated.buffer.length !== hdr.size) {
      throw new PackError(`pack entry size mismatch at ${entryOffset}: expected ${hdr.size}, got ${inflated.buffer.length}`);
    }
    offset += bytesRead;

    const entry: RawPackEntry = {
      offset: entryOffset,
      typeCode: hdr.typeCode,
      data: inflated.buffer,
      baseOffset,
      baseOid,
    };
    rawEntries.push(entry);
    byOffset.set(entryOffset, entry);
  }

  if (offset !== trailerStart) {
    throw new PackError(`unexpected ${trailerStart - offset} trailing bytes before pack checksum`);
  }

  const objects = new Map<string, GitObjectRecord>();
  const resolvedByOid = new Map<string, RawPackEntry>();
  const resolving = new Set<number>();

  const resolve = (entry: RawPackEntry): { readonly type: GitObjectType; readonly data: Buffer; readonly oid: string } => {
    if (entry.resolved !== undefined) return entry.resolved;
    if (resolving.has(entry.offset)) throw new PackError(`delta cycle at offset ${entry.offset}`);
    resolving.add(entry.offset);

    let type: GitObjectType;
    let data: Buffer;
    if (entry.typeCode === 6) {
      const baseEntry = byOffset.get(entry.baseOffset!);
      if (baseEntry === undefined) throw new PackError(`missing ofs-delta base at ${entry.baseOffset}`);
      const base = resolve(baseEntry);
      type = base.type;
      data = applyDelta(base.data, entry.data);
    } else if (entry.typeCode === 7) {
      const baseOid = entry.baseOid!;
      const inPackBase = resolvedByOid.get(baseOid);
      if (inPackBase !== undefined) {
        const base = resolve(inPackBase);
        type = base.type;
        data = applyDelta(base.data, entry.data);
      } else {
        const ext = resolveExternalBase?.(baseOid);
        if (ext === undefined) {
          throw new PackError(`missing ref-delta base ${baseOid}`);
        }
        type = ext.type;
        data = applyDelta(ext.data, entry.data);
      }
    } else {
      type = CODE_TO_TYPE[entry.typeCode]!;
      data = entry.data;
    }

    const oid = hashGitObject(type, data);
    const resolved = { type, data, oid };
    entry.resolved = resolved;
    resolvedByOid.set(oid, entry);
    resolving.delete(entry.offset);
    return resolved;
  };

  for (let i = 0; i < rawEntries.length; i += 1) {
    const res = resolve(rawEntries[i]!);
    if (!objects.has(res.oid)) {
      objects.set(res.oid, { type: res.type, data: res.data });
    }
  }

  return objects;
}
