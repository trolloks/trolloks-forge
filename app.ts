// The forge's HTTP server: one listener, one route table. The store is opened here (its data directory is
// FORGE_DATA_DIR, default /tmp/makefun-forge) and shared by every surface: REST, git smart HTTP, GraphQL
// and MCP read and write the same objects, so a change made on one shows on the others.

import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { handleRest, API_ROOT, JSON_BODY_LIMIT } from './src/api/rest.ts';
import { handleGraphql } from './src/graphql/http.ts';
import { handleMcp } from './src/mcp/server.ts';
import { gitRouteOf, handleGit } from './src/git/http.ts';
import { bearerToken, originOf, parseUrl, readBody, sendError, sendJson, tokenMatches } from './src/http/util.ts';
import { Store } from './src/store/store.ts';

const DEFAULT_DATA_DIR = '/tmp/makefun-forge';

const NO_BODY = Buffer.alloc(0);

/**
 * The request body, read only for an authorized request that carries one. An unauthenticated request is
 * answered without buffering its body; the surface then refuses it with its own 401.
 */
function bodyOf(ctx: Context, req: IncomingMessage, method: string): Promise<Buffer> {
  if (method === 'GET' || method === 'HEAD') return Promise.resolve(NO_BODY);
  const presented = bearerToken(req);
  if (presented === null || !tokenMatches(presented, ctx.token)) return Promise.resolve(NO_BODY);
  return readBody(req, JSON_BODY_LIMIT);
}

interface Context {
  readonly store: Store;
  readonly token: string;
}

async function dispatch(ctx: Context, req: IncomingMessage, res: ServerResponse): Promise<void> {
  const { path, query } = parseUrl(req);
  const method = (req.method ?? 'GET').toUpperCase();
  const origin = originOf(req);

  if (method === 'GET' && path === '/healthz') {
    sendJson(res, 200, { ok: true });
    return;
  }

  if (path === API_ROOT || path.startsWith(`${API_ROOT}/`)) {
    const raw = await bodyOf(ctx, req, method);
    handleRest(ctx.store, ctx.token, req, res, path, query, origin, raw);
    return;
  }

  if (path === '/mcp') {
    await handleMcp(ctx.store, ctx.token, origin, req, res);
    return;
  }

  if (path === '/api/graphql') {
    const raw = await bodyOf(ctx, req, method);
    handleGraphql(ctx.store, ctx.token, origin, req, res, raw);
    return;
  }

  const git = gitRouteOf(path);
  if (git !== null) {
    await handleGit(ctx.store, ctx.token, req, res, path, git);
    return;
  }

  sendJson(res, 404, { message: 'Not Found' });
}

/** Build the server. It binds nothing until the caller listens (the entry listens on an ephemeral port). */
export function createApp(): Server {
  const dir = process.env.FORGE_DATA_DIR && process.env.FORGE_DATA_DIR !== '' ? process.env.FORGE_DATA_DIR : DEFAULT_DATA_DIR;
  const token = process.env.MAKEFUN_SHOP_TOKEN ?? '';
  const ctx: Context = { store: new Store(dir), token };
  const server = createServer((req, res) => {
    dispatch(ctx, req, res).catch((err: unknown) => {
      if (res.headersSent) {
        res.destroy();
        return;
      }
      sendError(res, err);
    });
  });
  server.requestTimeout = 0;
  server.headersTimeout = 60_000;
  server.keepAliveTimeout = 65_000;
  return server;
}
