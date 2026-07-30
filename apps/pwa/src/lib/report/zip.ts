/**
 * Store-only ZIP writer (Item D1) — the container for the evidence package.
 *
 * NO COMPRESSION, deliberately. Everything going in is already compressed media, so deflate
 * would burn a survivor's battery and CPU to save nothing — and it would put an inflater
 * between a detective and her evidence. Store-only means every byte in the archive is the
 * byte we hashed and signed, findable with any tool, recoverable by hand if it comes to that.
 *
 * MEMORY DISCIPLINE. Entries carry their data as `Blob`, and the output is a `Blob` assembled
 * from parts. The browser keeps Blob data disk-backed, so a 10-minute capture (~600 segments,
 * tens of megabytes) never has to sit in RAM at once. Only ONE entry is read into memory at a
 * time, to CRC it. That is the whole reason this file does not take `Uint8Array`.
 *
 * DETERMINISTIC. A fixed DOS timestamp, so the same inputs produce the same archive bytes.
 * The manifest hashes the CONTENTS rather than the archive, but a reproducible container is
 * one less thing anyone has to argue about.
 */

/** CRC-32 (IEEE), the checksum ZIP requires per entry. */
const CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let i = 0; i < 256; i += 1) {
    let c = i;
    for (let k = 0; k < 8; k += 1) {
      c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    }
    table[i] = c >>> 0;
  }
  return table;
})();

function crc32(bytes: Uint8Array): number {
  let c = 0xffffffff;
  for (let i = 0; i < bytes.length; i += 1) {
    c = CRC_TABLE[(c ^ bytes[i]) & 0xff] ^ (c >>> 8);
  }
  return (c ^ 0xffffffff) >>> 0;
}

export interface ZipEntry {
  /** Path inside the archive. Forward slashes, no leading slash. */
  name: string;
  data: Blob;
}

/** ZIP without Zip64 tops out here. A 1-chunk-per-second capture would need ~18 hours to
 *  reach it, but a limit that fails silently is not a limit. */
const MAX_ENTRIES = 0xffff;
/** 4 GiB - 1: the 32-bit size fields. Same rule — refuse loudly rather than emit a corrupt
 *  archive that only reveals itself in a courtroom. */
const MAX_TOTAL_BYTES = 0xffffffff;

export class ZipTooLargeError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ZipTooLargeError';
  }
}

/** Fixed DOS date/time (2020-01-01 00:00:00) so archives are reproducible. */
const DOS_TIME = 0;
const DOS_DATE = ((2020 - 1980) << 9) | (1 << 5) | 1;

function u16(value: number): Uint8Array {
  return new Uint8Array([value & 0xff, (value >>> 8) & 0xff]);
}
function u32(value: number): Uint8Array {
  return new Uint8Array([value & 0xff, (value >>> 8) & 0xff, (value >>> 16) & 0xff, (value >>> 24) & 0xff]);
}
function join(...parts: Uint8Array[]): Uint8Array {
  const total = parts.reduce((sum, p) => sum + p.length, 0);
  const out = new Uint8Array(total);
  let at = 0;
  for (const p of parts) {
    out.set(p, at);
    at += p.length;
  }
  return out;
}

interface CentralRecord {
  nameBytes: Uint8Array;
  crc: number;
  size: number;
  offset: number;
}

/**
 * Build a store-only ZIP.
 *
 * Throws `ZipTooLargeError` if the archive would exceed what a non-Zip64 container can
 * honestly describe. The caller degrades — it never ships a corrupt package.
 */
export async function zipStore(entries: readonly ZipEntry[]): Promise<Blob> {
  if (entries.length > MAX_ENTRIES) {
    throw new ZipTooLargeError(`${entries.length} entries exceeds the ${MAX_ENTRIES}-entry ZIP limit`);
  }

  const parts: BlobPart[] = [];
  const central: CentralRecord[] = [];
  const encoder = new TextEncoder();
  let offset = 0;

  for (const entry of entries) {
    const nameBytes = encoder.encode(entry.name);
    // One entry in memory at a time — this is the memory ceiling for the whole operation.
    const bytes = new Uint8Array(await entry.data.arrayBuffer());
    const crc = crc32(bytes);

    const localHeader = join(
      u32(0x04034b50), // local file header signature
      u16(20), // version needed
      u16(0), // flags
      u16(0), // method 0 = store
      u16(DOS_TIME),
      u16(DOS_DATE),
      u32(crc),
      u32(bytes.length), // compressed size == uncompressed size
      u32(bytes.length),
      u16(nameBytes.length),
      u16(0), // extra field length
      nameBytes,
    );

    parts.push(localHeader as BlobPart, bytes as BlobPart);
    central.push({ nameBytes, crc, size: bytes.length, offset });
    offset += localHeader.length + bytes.length;
    if (offset > MAX_TOTAL_BYTES) {
      throw new ZipTooLargeError('archive exceeds the 4 GiB non-Zip64 limit');
    }
  }

  const centralStart = offset;
  const centralParts: Uint8Array[] = [];
  for (const record of central) {
    centralParts.push(
      join(
        u32(0x02014b50), // central directory header signature
        u16(20), // version made by
        u16(20), // version needed
        u16(0), // flags
        u16(0), // method 0 = store
        u16(DOS_TIME),
        u16(DOS_DATE),
        u32(record.crc),
        u32(record.size),
        u32(record.size),
        u16(record.nameBytes.length),
        u16(0), // extra
        u16(0), // comment
        u16(0), // disk number start
        u16(0), // internal attributes
        u32(0), // external attributes
        u32(record.offset),
        record.nameBytes,
      ),
    );
  }
  const centralBytes = join(...centralParts);

  const end = join(
    u32(0x06054b50), // end of central directory signature
    u16(0), // this disk
    u16(0), // disk with central directory
    u16(central.length),
    u16(central.length),
    u32(centralBytes.length),
    u32(centralStart),
    u16(0), // comment length
  );

  parts.push(centralBytes as BlobPart, end as BlobPart);
  return new Blob(parts, { type: 'application/zip' });
}
