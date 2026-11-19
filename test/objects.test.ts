import { test } from 'node:test';
import assert from 'node:assert/strict';
import { deflateSync } from 'node:zlib';
import { createHash } from 'node:crypto';
import {
  ObjectError,
  applyDelta,
  buildCommit,
  buildTree,
  hashObject,
  isOid,
  parseCommit,
  parseTree,
  readPack,
  writePack,
  type GitObject,
} from '../src/git/objects.ts';

test('blob ids match git: the empty blob and "hello\\n"', () => {
  assert.equal(hashObject('blob', Buffer.alloc(0)), 'e69de29bb2d1d6434b8b29ae775ad8c2e48c5391');
  assert.equal(hashObject('blob', Buffer.from('hello\n')), 'ce013625030ba8dba906f756967f9e9ca394464a');
});

test('tree entries sort with directories compared as name plus slash', () => {
  const blob = hashObject('blob', Buffer.from('x'));
  const tree = buildTree([
    { mode: '100644', name: 'a.txt', oid: blob },
    { mode: '40000', name: 'a', oid: blob },
    { mode: '100644', name: 'a-b', oid: blob },
  ]);
  const names = parseTree(tree).map((entry) => entry.name);
  // Sort keys are "a-b", "a.txt" and "a/": '-' (0x2d) < '.' (0x2e) < '/' (0x2f).
  assert.deepEqual(names, ['a-b', 'a.txt', 'a']);
});

test('parseTree round-trips buildTree and rejects truncated entries', () => {
  const oid = hashObject('blob', Buffer.from('content'));
  const data = buildTree([{ mode: '100755', name: 'run.sh', oid }]);
  assert.deepEqual(parseTree(data), [{ mode: '100755', name: 'run.sh', oid }]);
  assert.throws(() => parseTree(data.subarray(0, data.length - 3)), ObjectError);
});

test('commit round-trips its tree, parents, identity and message byte for byte', () => {
  const tree = hashObject('tree', Buffer.alloc(0));
  const parent = hashObject('commit', Buffer.from('p'));
  const sig = { name: 'Ada', email: 'ada@example.invalid', when: 1700000000, tz: '+0000' };
  const data = buildCommit({ tree, parents: [parent], author: sig, committer: sig, message: 'Subject\n\nBody line' });
  const view = parseCommit(data);
  assert.equal(view.tree, tree);
  assert.deepEqual(view.parents, [parent]);
  assert.equal(view.author, 'Ada <ada@example.invalid> 1700000000 +0000');
  assert.equal(view.committerTime, 1700000000);
  assert.equal(view.message, 'Subject\n\nBody line');
  assert.equal(Buffer.from(data.toString('utf8')).equals(data), true);
});

test('isOid accepts only 40 lowercase hex digits', () => {
  assert.equal(isOid('a'.repeat(40)), true);
  assert.equal(isOid('A'.repeat(40)), false);
  assert.equal(isOid('a'.repeat(39)), false);
  assert.equal(isOid('g'.repeat(40)), false);
});

test('a pack written then read yields the same objects with the same ids', () => {
  const objects: GitObject[] = [
    { type: 'blob', data: Buffer.from('one') },
    { type: 'blob', data: Buffer.alloc(5000, 'z') },
    { type: 'tree', data: buildTree([{ mode: '100644', name: 'f', oid: hashObject('blob', Buffer.from('one')) }]) },
  ];
  const pack = writePack(objects);
  const read = readPack(pack);
  assert.equal(read.size, 3);
  for (const object of objects) {
    const oid = hashObject(object.type, object.data);
    assert.equal(read.get(oid)?.data.equals(object.data), true);
  }
});

test('readPack refuses a pack whose trailer does not match its bytes', () => {
  const pack = writePack([{ type: 'blob', data: Buffer.from('payload') }]);
  pack[pack.length - 1] ^= 0xff;
  assert.throws(() => readPack(pack), /checksum/);
});

/** Build an ofs-delta pack by hand: a base blob, then a delta that copies and inserts. */
function packWithOfsDelta(base: Buffer, target: Buffer, delta: Buffer): Buffer {
  const header = Buffer.alloc(12);
  header.write('PACK', 0, 'latin1');
  header.writeUInt32BE(2, 4);
  header.writeUInt32BE(2, 8);
  const baseEntry = Buffer.concat([Buffer.from([0x30 | (base.length & 0x0f)]), deflateSync(base)]);
  // base: type 3 (blob); the varint size fits in one byte for the test sizes used here.
  const baseHeader = Buffer.from([(3 << 4) | (base.length & 0x0f) | (base.length > 15 ? 0x80 : 0)]);
  const sizeRest = base.length > 15 ? Buffer.from([Math.floor(base.length / 16)]) : Buffer.alloc(0);
  const baseBytes = Buffer.concat([baseHeader, sizeRest, deflateSync(base)]);
  const deltaStart = header.length + baseBytes.length;
  void baseEntry;
  const offset = deltaStart - header.length; // distance back to the base object
  const deltaHeader = Buffer.from([(6 << 4) | (delta.length & 0x0f) | (delta.length > 15 ? 0x80 : 0)]);
  const deltaSize = delta.length > 15 ? Buffer.from([Math.floor(delta.length / 16)]) : Buffer.alloc(0);
  const ofs = Buffer.from([offset]);
  const body = Buffer.concat([header, baseBytes, deltaHeader, deltaSize, ofs, deflateSync(delta)]);
  void target;
  return Buffer.concat([body, createHash('sha1').update(body).digest()]);
}

test('an ofs-delta copies from its base and inserts new bytes', () => {
  const base = Buffer.from('hello world');
  // delta: source size 11, target size 11 ("hello there"): copy "hello " (0..6), insert "there" (5 bytes).
  const delta = Buffer.from([11, 11, 0x90, 6, 5, ...Buffer.from('there')]);
  const target = applyDelta(base, delta);
  assert.equal(target.toString(), 'hello there');
  const pack = packWithOfsDelta(base, target, delta);
  const read = readPack(pack);
  assert.equal(read.get(hashObject('blob', target))?.data.toString(), 'hello there');
});

test('applyDelta refuses copies outside the base and size mismatches', () => {
  const base = Buffer.from('abc');
  assert.throws(() => applyDelta(base, Buffer.from([4, 3, 0x90, 3])), ObjectError);
  assert.throws(() => applyDelta(base, Buffer.from([3, 9, 0x90, 3])), ObjectError);
  assert.throws(() => applyDelta(base, Buffer.from([3, 3, 0])), ObjectError);
});
