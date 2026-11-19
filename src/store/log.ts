// Append-only files. Every durable change is one record appended synchronously before the request that
// made it is answered, so a restart replays exactly the acknowledged state. A record cut short by a crash
// (the last one) is truncated away on open; no other damage is papered over.

import { closeSync, fsyncSync, ftruncateSync, openSync, readFileSync, writeSync } from 'node:fs';

export class AppendLog {
  private readonly fd: number;
  private size: number;
  readonly path: string;

  /** Open (creating if needed) the file at `path`. */
  constructor(path: string) {
    this.path = path;
    this.fd = openSync(path, 'a+');
    this.size = readFileSync(path).length;
  }

  /** Read the whole file. Used once, at boot. */
  readAll(): Buffer {
    return readFileSync(this.path);
  }

  /** Cut the file back to `length` bytes (drops a torn tail found during replay). */
  truncate(length: number): void {
    ftruncateSync(this.fd, length);
    this.size = length;
  }

  append(bytes: Buffer): void {
    let written = 0;
    while (written < bytes.length) {
      written += writeSync(this.fd, bytes, written, bytes.length - written, this.size + written);
    }
    this.size += bytes.length;
  }

  /** Flush to the device. Called on shutdown; each append is already in the kernel. */
  sync(): void {
    fsyncSync(this.fd);
  }

  close(): void {
    closeSync(this.fd);
  }
}
