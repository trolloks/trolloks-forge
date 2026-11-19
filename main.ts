// The entry <-> env lifecycle, as env/src/wire.ts settles it: bind an ephemeral port, tell the env the
// port it bound, then poll until the env says the trial is over and exit 0. The suite scores the server
// app.ts builds; this file owns the lifecycle and the store the trial's forge writes to.
//
//   1. MAKEFUN_ENV_URL names the env's origin (http://store:8080 in a trial container). Without it
//      there is nothing to talk to, so the program exits 1 at once.
//   2. Create the server and listen(0): the kernel picks a free port. Never bind 8080 — the env owns it.
//      The store is FORGE_DATA_DIR when it is set. When it is not, this trial makes a unique temporary
//      directory of its own, so two runs on one machine (process-mode live and replay, say) never share
//      repositories; that directory is removed on exit, after the listener has closed.
//   3. POST $MAKEFUN_ENV_URL/register {"port": N}. The env records the address the request came from
//      plus N as your base URL and dials it from then on. The first register wins; a 409 means another
//      entry already registered, and this process keeps waiting like any other.
//   4. GET $MAKEFUN_ENV_URL/done until the body is {"done": true}. The env answers at once ({"done":
//      false} while the suite runs), so this is a poll, not a long-held request. A failed or slow poll
//      is retried with a short exponential backoff; the process never exits before the env says done.
//   5. Close the server and exit 0. The harness then stops the env, which writes the export the scorer
//      reads.
//
// main.ts imports its own server and nothing else: no package, no Node built-in, no model call.

import { mkdtempSync, rmSync } from 'node:fs';
import type { Server } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createApp } from './app.ts';

const ENV_URL = (process.env.MAKEFUN_ENV_URL ?? '').replace(/\/+$/, '');
if (ENV_URL === '') {
  process.stderr.write('[entry] MAKEFUN_ENV_URL is not set: there is no env to register with\n');
  process.exit(1);
}

/** How long one register or done request may take before it is abandoned and retried. */
const REQUEST_TIMEOUT_MS = 30_000;
/** The first wait between retries, and the longest. */
const RETRY_INITIAL_MS = 250;
const RETRY_MAX_MS = 2_000;

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

/** The wait after `attempt` failed requests: exponential from RETRY_INITIAL_MS, capped. */
function retryDelay(attempt: number): number {
  return Math.min(RETRY_MAX_MS, RETRY_INITIAL_MS * 2 ** Math.min(attempt, 8));
}

/**
 * POST the bound port until the env accepts it. 200 is the normal answer; 409 means a first register
 * already won, which is not this process's to fix. 400 and 405 are contract errors and end the program;
 * a network error or another status is retried, since the env may still be starting.
 */
async function register(port: number): Promise<void> {
  for (let attempt = 0; ; attempt += 1) {
    try {
      const res = await fetch(`${ENV_URL}/register`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ port }),
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      });
      if (res.status === 200 || res.status === 409) return;
      if (res.status === 400 || res.status === 405) throw new Error(`register answered HTTP ${res.status}: ${await res.text()}`);
    } catch (err) {
      if (err instanceof Error && err.message.startsWith('register answered HTTP ')) throw err;
    }
    await sleep(retryDelay(attempt));
  }
}

/** Poll GET /done until it answers {"done":true}; never return before that. */
async function waitForDone(): Promise<void> {
  for (let attempt = 0; ; attempt += 1) {
    try {
      const res = await fetch(`${ENV_URL}/done`, { signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS) });
      if (res.ok) {
        const body = (await res.json()) as { done?: unknown };
        if (body.done === true) return;
      }
    } catch {
      // The env is not answering yet, or the poll timed out: it is not done, so poll again.
    }
    await sleep(retryDelay(attempt));
  }
}

/**
 * The store this process created, or null when FORGE_DATA_DIR named one (which is never removed). Set in
 * main() before createApp() reads the environment, so the forge opens exactly this directory.
 */
let ownedStoreDir: string | null = null;

/** Point the forge at a store: the explicit FORGE_DATA_DIR, else a fresh unique temporary directory. */
function prepareStore(): void {
  const explicit = process.env.FORGE_DATA_DIR;
  if (explicit !== undefined && explicit !== '') return;
  ownedStoreDir = mkdtempSync(join(tmpdir(), 'makefun-forge-'));
  process.env.FORGE_DATA_DIR = ownedStoreDir;
}

/** Close the listener and wait until it has stopped accepting and its connections are gone. */
function closeServer(server: Server | null): Promise<void> {
  if (server === null || !server.listening) return Promise.resolve();
  return new Promise<void>((resolve) => {
    server.closeAllConnections();
    server.close(() => resolve());
  });
}

/** Remove the store this process created. Only ever the directory prepareStore() made. */
function removeOwnedStore(): void {
  if (ownedStoreDir === null) return;
  rmSync(ownedStoreDir, { recursive: true, force: true });
  ownedStoreDir = null;
}

/** Bound the port, register it, then wait for the env: the whole life of the process. */
async function main(): Promise<void> {
  let server: Server | null = null;
  try {
    prepareStore();
    const listener = createApp();
    server = listener;
    await new Promise<void>((resolve, reject) => {
      listener.once('error', reject);
      listener.listen(0, () => resolve());
    });
    const address = listener.address();
    if (address === null || typeof address === 'string') throw new Error('the server did not bind an ephemeral TCP port');
    process.stdout.write(`[entry] listening on port ${address.port}\n`);

    await register(address.port);
    process.stdout.write('[entry] registered; waiting for the env to say done\n');

    await waitForDone();
  } finally {
    // Stop the listener before the store it writes to goes away, on success and on every failure.
    await closeServer(server);
    removeOwnedStore();
  }
  process.stdout.write('[entry] done\n');
}

try {
  await main();
  process.exit(0);
} catch (err) {
  process.stderr.write(`[entry] ${err instanceof Error ? err.message : String(err)}\n`);
  process.exit(1);
}
