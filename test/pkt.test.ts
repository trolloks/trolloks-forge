import { test } from 'node:test';
import assert from 'node:assert/strict';
import { FLUSH, DELIM, PKT_MAX, SIDEBAND_CHUNK, PktError, parsePkts, pkt, sideband } from '../src/git/pkt.ts';

test('pkt-line encodes a payload with its own length prefix', () => {
  assert.equal(pkt('hello\n').toString(), '000ahello\n');
  // The four length digits are ASCII, so their wire bytes are 0x30 0x30 0x30 0x37.
  assert.equal(pkt(Buffer.from([1, 2, 3])).toString('hex'), '30303037010203');
});

test('parsePkts reads data, flush, delim and response-end packets in order', () => {
  const bytes = Buffer.concat([pkt('a\n'), FLUSH, DELIM, Buffer.from('0002', 'ascii')]);
  const packets = parsePkts(bytes);
  assert.deepEqual(
    packets.map((packet) => packet.kind),
    ['data', 'flush', 'delim', 'response-end'],
  );
  const first = packets[0];
  assert.equal(first.kind === 'data' ? first.data.toString() : '', 'a\n');
});

test('parsePkts refuses lengths that are malformed, short or run past the end', () => {
  assert.throws(() => parsePkts(Buffer.from('zzzzabc')), PktError);
  assert.throws(() => parsePkts(Buffer.from('0003')), PktError);
  assert.throws(() => parsePkts(Buffer.from('0010abc')), PktError);
  assert.throws(() => parsePkts(Buffer.from('00')), PktError);
});

test('pkt refuses a payload larger than the protocol maximum', () => {
  assert.throws(() => pkt(Buffer.alloc(PKT_MAX)), PktError);
});

test('sideband splits bytes into bounded band packets that reassemble exactly', () => {
  const bytes = Buffer.alloc(SIDEBAND_CHUNK * 2 + 17, 7);
  const packets = parsePkts(Buffer.concat(sideband(1, bytes)));
  const parts = packets.map((packet) => {
    assert.equal(packet.kind, 'data');
    if (packet.kind !== 'data') throw new Error('unreachable');
    assert.equal(packet.data[0], 1);
    assert.ok(packet.data.length <= PKT_MAX - 4);
    return packet.data.subarray(1);
  });
  assert.equal(Buffer.concat(parts).equals(bytes), true);
  assert.equal(parts.length, 3);
});
