// Shared test plumbing: a throwaway data directory and a live server on an ephemeral port.

import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { AddressInfo } from 'node:net';
import type { Server } from 'node:http';
import { createApp } from '../app.ts';

export const TOKEN = 'test-token';

export interface Running {
  readonly base: string;
  readonly dir: string;
  close(): Promise<void>;
}

/** Start a fresh forge on a random port with its own data directory. */
export async function startForge(): Promise<Running> {
  const dir = mkdtempSync(join(tmpdir(), 'forge-test-'));
  process.env.FORGE_DATA_DIR = dir;
  process.env.MAKEFUN_SHOP_TOKEN = TOKEN;
  const server: Server = createApp();
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()));
  const port = (server.address() as AddressInfo).port;
  return {
    base: `http://127.0.0.1:${port}`,
    dir,
    close: () =>
      new Promise<void>((resolve) => {
        server.closeAllConnections();
        server.close(() => {
          rmSync(dir, { recursive: true, force: true });
          resolve();
        });
      }),
  };
}

export function authed(extra: Record<string, string> = {}): Record<string, string> {
  return { authorization: `Bearer ${TOKEN}`, ...extra };
}

export async function json(response: Response): Promise<any> {
  return JSON.parse(await response.text());
}
