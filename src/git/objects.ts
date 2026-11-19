// Git object model: hashing, the tree, commit and tag codecs, and pack files (read with deltas, write
// without). Everything is byte-exact: an object's id is sha1 of "<type> <size>\0<data>", and the bytes we
// store are the bytes a client pushed, so clones round-trip object-for-object.

import { createHash } from 'node:crypto';
import { deflateSync, inflateSync } from 'node:zlib';

export type ObjType = 'commit' | 'tree' | 'blob' | 'tag';

export interface GitObject {
  readonly type: ObjType;
  readonly data: Buffer;
}

export const ZERO_OID = '0'.repeat(40);
const OID_RE = /^[0-9a-f]{40}$/;

/** True for a 40-character lowercase hex object id. */
export function isOid(value: string): boolean {
  return OID_RE.test(value);
}

export class ObjectError extends Error {}

export function hashObject(type: ObjType, data: Uint8Array): string {
  const hash = createHash('sha1');
  hash.update(`${type} ${data.length}\0`);
  hash.update(data);
  return hash.digest('hex');
}

// ---------------------------------------------------------------- trees

export interface TreeEntry {
  /** Octal mode as git writes it: 100644, 100755, 120000, 40000 (a tree) or 160000 (a submodule). */
  readonly mode: string;
  readonly name: string;
  readonly oid: string;
}

export function isTreeMode(mode: string): boolean {
  return mode === '40000' || mode === '040000';
}

export function parseTree(data: Buffer): TreeEntry[] {
  const entries: TreeEntry[] = [];
  let pos = 0;
  while (pos < data.length) {
    const space = data.indexOf(0x20, pos);
    if (space < 0) throw new ObjectError('malformed tree: no mode terminator');
    const nul = data.indexOf(0, space + 1);
    if (nul < 0 || nul + 21 > data.length) throw new ObjectError('malformed tree: truncated entry');
    const mode = data.toString('latin1', pos, space);
    const name = data.toString('utf8', space + 1, nul);
    const oid = data.subarray(nul + 1, nul + 21).toString('hex');
    entries.push({ mode: mode === '040000' ? '40000' : mode, name, oid });
    pos = nul + 21;
  }
  return entries;
}

/** Git orders tree entries by name, with a directory compared as if its name ended in "/". */
function sortKey(entry: TreeEntry): Buffer {
  return Buffer.from(isTreeMode(entry.mode) ? `${entry.name}/` : entry.name, 'utf8');
}

export function buildTree(entries: readonly TreeEntry[]): Buffer {
  const sorted = entries
    .map((entry) => ({ entry, key: sortKey(entry) }))
    .sort((a, b) => Buffer.compare(a.key, b.key))
    .map((item) => item.entry);
  const parts: Buffer[] = [];
  for (const entry of sorted) {
    parts.push(Buffer.from(`${entry.mode} ${entry.name}\0`, 'utf8'));
    parts.push(Buffer.from(entry.oid, 'hex'));
  }
  return Buffer.concat(parts);
}

// ---------------------------------------------------------------- commits and tags

export interface Signature {
  readonly name: string;
  readonly email: string;
  /** Seconds since the epoch. */
  readonly when: number;
  /** Timezone offset text such as +0000. */
  readonly tz: string;
}

export interface CommitView {
  readonly tree: string;
  readonly parents: string[];
  readonly author: string;
  readonly committer: string;
  readonly committerTime: number;
  readonly message: string;
}

function headerLines(data: Buffer): { headers: string[]; message: string } {
  const text = data.toString('utf8');
  const split = text.indexOf('\n\n');
  const head = split < 0 ? text : text.slice(0, split);
  const message = split < 0 ? '' : text.slice(split + 2);
  const headers: string[] = [];
  for (const line of head.split('\n')) {
    if (line.startsWith(' ') && headers.length > 0) headers[headers.length - 1] += `\n${line.slice(1)}`;
    else headers.push(line);
  }
  return { headers, message };
}

export function parseCommit(data: Buffer): CommitView {
  const { headers, message } = headerLines(data);
  let tree = '';
  const parents: string[] = [];
  let author = '';
  let committer = '';
  for (const line of headers) {
    const space = line.indexOf(' ');
    const key = space < 0 ? line : line.slice(0, space);
    const value = space < 0 ? '' : line.slice(space + 1);
    if (key === 'tree') tree = value;
    else if (key === 'parent') parents.push(value);
    else if (key === 'author') author = value;
    else if (key === 'committer') committer = value;
  }
  if (!isOid(tree)) throw new ObjectError('commit has no tree');
  const match = /> (\d+) ([+-]\d{4})$/.exec(committer);
  const committerTime = match ? Number(match[1]) : 0;
  return { tree, parents, author, committer, committerTime, message };
}

export function formatSignature(sig: Signature): string {
  return `${sig.name} <${sig.email}> ${sig.when} ${sig.tz}`;
}

export function buildCommit(input: {
  tree: string;
  parents: readonly string[];
  author: Signature;
  committer: Signature;
  message: string;
}): Buffer {
  const lines = [`tree ${input.tree}`];
  for (const parent of input.parents) lines.push(`parent ${parent}`);
  lines.push(`author ${formatSignature(input.author)}`);
  lines.push(`committer ${formatSignature(input.committer)}`);
  // The message is stored exactly as given: an API caller reads back the bytes it wrote.
  return Buffer.from(`${lines.join('\n')}\n\n${input.message}`, 'utf8');
}

export interface TagView {
  readonly object: string;
  readonly type: string;
  readonly tag: string;
  readonly message: string;
}

export function parseTag(data: Buffer): TagView {
  const { headers, message } = headerLines(data);
  let object = '';
  let type = '';
  let tag = '';
  for (const line of headers) {
    if (line.startsWith('object ')) object = line.slice(7);
    else if (line.startsWith('type ')) type = line.slice(5);
    else if (line.startsWith('tag ')) tag = line.slice(4);
  }
  if (!isOid(object)) throw new ObjectError('tag has no object');
  return { object, type, tag, message };
}

// ---------------------------------------------------------------- packs

const TYPE_NUMBER: Record<ObjType, number> = { commit: 1, tree: 2, blob: 3, tag: 4 };
const NUMBER_TYPE: Record<number, ObjType> = { 1: 'commit', 2: 'tree', 3: 'blob', 4: 'tag' };

/** Apply a git delta to its base. Every copy and insert is bounds-checked. */
export function applyDelta(base: Buffer, delta: Buffer): Buffer {
  let pos = 0;
  const varint = (): number => {
    let value = 0;
    let scale = 1;
    let byte: number;
    do {
      if (pos >= delta.length) throw new ObjectError('truncated delta header');
      byte = delta[pos++];
      value += (byte & 0x7f) * scale;
      scale *= 128;
    } while (byte & 0x80);
    return value;
  };
  const sourceSize = varint();
  const targetSize = varint();
  if (sourceSize !== base.length) throw new ObjectError('delta base size mismatch');
  const out = Buffer.alloc(targetSize);
  let written = 0;
  while (pos < delta.length) {
    const op = delta[pos++];
    if (op & 0x80) {
      let offset = 0;
      let size = 0;
      if (op & 0x01) offset += delta[pos++];
      if (op & 0x02) offset += delta[pos++] * 0x100;
      if (op & 0x04) offset += delta[pos++] * 0x10000;
      if (op & 0x08) offset += delta[pos++] * 0x1000000;
      if (op & 0x10) size += delta[pos++];
      if (op & 0x20) size += delta[pos++] * 0x100;
      if (op & 0x40) size += delta[pos++] * 0x10000;
      if (size === 0) size = 0x10000;
      if (offset + size > base.length || written + size > targetSize) throw new ObjectError('delta copy out of range');
      base.copy(out, written, offset, offset + size);
      written += size;
    } else if (op !== 0) {
      if (pos + op > delta.length || written + op > targetSize) throw new ObjectError('delta insert out of range');
      delta.copy(out, written, pos, pos + op);
      pos += op;
      written += op;
    } else {
      throw new ObjectError('delta opcode 0 is reserved');
    }
  }
  if (written !== targetSize) throw new ObjectError('delta produced the wrong size');
  return out;
}

/**
 * Read a pack. Returns every object it holds, keyed by id. Deltas (offset and reference) are resolved;
 * a reference delta may name a base outside the pack (`external`), as a thin pack does.
 * The trailing sha1 is verified over every byte before it.
 */
export function readPack(pack: Buffer, external?: (oid: string) => GitObject | undefined): Map<string, GitObject> {
  if (pack.length < 32 || pack.toString('latin1', 0, 4) !== 'PACK') throw new ObjectError('not a pack');
  const version = pack.readUInt32BE(4);
  if (version !== 2 && version !== 3) throw new ObjectError(`unsupported pack version ${version}`);
  const count = pack.readUInt32BE(8);
  const trailer = pack.length - 20;
  const actual = createHash('sha1').update(pack.subarray(0, trailer)).digest('hex');
  if (actual !== pack.subarray(trailer).toString('hex')) throw new ObjectError('pack checksum does not match its bytes');

  interface Raw {
    offset: number;
    type: number;
    data: Buffer;
    baseOffset: number | null;
    baseOid: string | null;
  }
  const raws: Raw[] = [];
  let pos = 12;
  for (let index = 0; index < count; index += 1) {
    const start = pos;
    if (pos >= trailer) throw new ObjectError('pack ends before its objects');
    let byte = pack[pos++];
    const type = (byte >> 4) & 7;
    let size = byte & 15;
    let scale = 16;
    while (byte & 0x80) {
      byte = pack[pos++];
      size += (byte & 0x7f) * scale;
      scale *= 128;
    }
    let baseOffset: number | null = null;
    let baseOid: string | null = null;
    if (type === 6) {
      byte = pack[pos++];
      let distance = byte & 0x7f;
      while (byte & 0x80) {
        byte = pack[pos++];
        distance = (distance + 1) * 128 + (byte & 0x7f);
      }
      baseOffset = start - distance;
      if (baseOffset < 12) throw new ObjectError('offset delta points before the pack');
    } else if (type === 7) {
      baseOid = pack.subarray(pos, pos + 20).toString('hex');
      pos += 20;
    } else if (!NUMBER_TYPE[type]) {
      throw new ObjectError(`unknown pack object type ${type}`);
    }
    const inflated = inflateSync(pack.subarray(pos, trailer), { info: true });
    pos += inflated.engine.bytesWritten;
    if (inflated.buffer.length !== size) throw new ObjectError('pack object size does not match its header');
    raws.push({ offset: start, type, data: inflated.buffer, baseOffset, baseOid });
  }
  if (pos !== trailer) throw new ObjectError('pack has bytes after its last object');

  const out = new Map<string, GitObject>();
  const byOffset = new Map<number, GitObject>();
  const resolve = (raw: Raw): GitObject | undefined => {
    if (raw.type !== 6 && raw.type !== 7) {
      const object: GitObject = { type: NUMBER_TYPE[raw.type], data: raw.data };
      return object;
    }
    let base: GitObject | undefined;
    if (raw.baseOffset !== null) base = byOffset.get(raw.baseOffset);
    else if (raw.baseOid !== null) base = out.get(raw.baseOid) ?? external?.(raw.baseOid);
    if (base === undefined) return undefined;
    return { type: base.type, data: applyDelta(base.data, raw.data) };
  };
  let pending = raws;
  while (pending.length > 0) {
    const next: Raw[] = [];
    for (const raw of pending) {
      const object = resolve(raw);
      if (object === undefined) {
        next.push(raw);
        continue;
      }
      const oid = hashObject(object.type, object.data);
      out.set(oid, object);
      byOffset.set(raw.offset, object);
    }
    if (next.length === pending.length) throw new ObjectError('pack has a delta whose base is missing');
    pending = next;
  }
  return out;
}

/** Write a pack of whole (non-delta) objects, with its sha1 trailer. */
export function writePack(objects: ReadonlyArray<GitObject>): Buffer {
  const header = Buffer.alloc(12);
  header.write('PACK', 0, 'latin1');
  header.writeUInt32BE(2, 4);
  header.writeUInt32BE(objects.length, 8);
  const parts: Buffer[] = [header];
  for (const object of objects) {
    const bytes: number[] = [];
    let size = object.data.length;
    let first = (TYPE_NUMBER[object.type] << 4) | (size % 16);
    size = Math.floor(size / 16);
    if (size > 0) first |= 0x80;
    bytes.push(first);
    while (size > 0) {
      let byte = size % 128;
      size = Math.floor(size / 128);
      if (size > 0) byte |= 0x80;
      bytes.push(byte);
    }
    parts.push(Buffer.from(bytes), deflateSync(object.data));
  }
  const body = Buffer.concat(parts);
  const trailer = createHash('sha1').update(body).digest();
  return Buffer.concat([body, trailer]);
}
