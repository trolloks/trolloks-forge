// pkt-line framing (gitprotocol-common): a 4-hex-digit length that counts itself, then the payload.
// 0000 is a flush, 0001 a delimiter (protocol v2), 0002 a response end. Everything here is bytes-first:
// a pack travels inside sideband packets and must never be decoded as text.

/** Largest pkt-line a peer may send (LARGE_PACKET_MAX): 65520 bytes including the 4-byte length. */
export const PKT_MAX = 65520;
/** Largest payload carried in one side-band-64k packet: PKT_MAX minus the length and the band byte. */
export const SIDEBAND_CHUNK = PKT_MAX - 5;

export type Pkt =
  | { readonly kind: 'data'; readonly data: Buffer }
  | { readonly kind: 'flush' }
  | { readonly kind: 'delim' }
  | { readonly kind: 'response-end' };

export class PktError extends Error {}

export const FLUSH = Buffer.from('0000', 'ascii');
export const DELIM = Buffer.from('0001', 'ascii');

/** Encode one payload (a string is UTF-8) as a pkt-line. */
export function pkt(payload: string | Uint8Array): Buffer {
  const body = typeof payload === 'string' ? Buffer.from(payload, 'utf8') : Buffer.from(payload.buffer, payload.byteOffset, payload.byteLength);
  const length = body.length + 4;
  if (length > PKT_MAX) throw new PktError(`pkt-line of ${length} bytes exceeds ${PKT_MAX}`);
  const head = Buffer.from(length.toString(16).padStart(4, '0'), 'ascii');
  return Buffer.concat([head, body]);
}

/** Parse a complete buffer of pkt-lines. Throws PktError on any malformed length. */
export function parsePkts(buf: Buffer): Pkt[] {
  const out: Pkt[] = [];
  let pos = 0;
  while (pos < buf.length) {
    if (pos + 4 > buf.length) throw new PktError('truncated pkt-line length');
    const text = buf.toString('latin1', pos, pos + 4);
    if (!/^[0-9a-fA-F]{4}$/.test(text)) throw new PktError(`bad pkt-line length ${JSON.stringify(text)}`);
    const length = parseInt(text, 16);
    if (length === 0) {
      out.push({ kind: 'flush' });
      pos += 4;
      continue;
    }
    if (length === 1) {
      out.push({ kind: 'delim' });
      pos += 4;
      continue;
    }
    if (length === 2) {
      out.push({ kind: 'response-end' });
      pos += 4;
      continue;
    }
    if (length < 4 || length > PKT_MAX) throw new PktError(`pkt-line length ${length} is out of range`);
    if (pos + length > buf.length) throw new PktError('pkt-line runs past the end of the body');
    out.push({ kind: 'data', data: buf.subarray(pos + 4, pos + length) });
    pos += length;
  }
  return out;
}

/** Text of a data packet without its trailing newline, or null for a control packet. */
export function lineOf(packet: Pkt): string | null {
  if (packet.kind !== 'data') return null;
  return packet.data.toString('utf8').replace(/\n$/, '');
}

/** Split bytes into side-band-64k packets on `band` (1 = data, 2 = progress, 3 = fatal). */
export function sideband(band: 1 | 2 | 3, bytes: Buffer): Buffer[] {
  const out: Buffer[] = [];
  for (let offset = 0; offset < bytes.length; offset += SIDEBAND_CHUNK) {
    const part = bytes.subarray(offset, Math.min(bytes.length, offset + SIDEBAND_CHUNK));
    out.push(pkt(Buffer.concat([Buffer.from([band]), part])));
  }
  return out;
}
