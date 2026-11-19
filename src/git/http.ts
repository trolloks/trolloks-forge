// Git smart HTTP routes: GET /{owner}/{repo}.git/info/refs and POST .../git-upload-pack and
// .../git-receive-pack. Every request needs the bearer token; the repository must belong to the forge's login.

import type { IncomingMessage, ServerResponse } from 'node:http';
import { HttpError, bearerToken, decodeSegment, readBody, sendJson, sendText, tokenMatches } from '../http/util.ts';
import { repoFor } from '../api/rest.ts';
import type { Store } from '../store/store.ts';
import { SmartError, advertiseV0, advertiseV2, receivePack, uploadPackV0, uploadPackV2 } from './smart.ts';

export const GIT_BODY_LIMIT = 64 * 1024 * 1024;

const GIT_PATH = /^\/([^/]+)\/([^/]+)\.git(\/.*)?$/;

/** The owner and repository of a git path, or null when the path is not a git path. */
export function gitRouteOf(path: string): { owner: string; name: string; rest: string } | null {
  const match = GIT_PATH.exec(path);
  if (!match) return null;
  return { owner: decodeSegment(match[1]), name: decodeSegment(match[2]), rest: match[3] ?? '' };
}

export async function handleGit(store: Store, token: string, req: IncomingMessage, res: ServerResponse, path: string, route: { owner: string; name: string; rest: string }): Promise<void> {
  const presented = bearerToken(req);
  if (presented === null || !tokenMatches(presented, token)) {
    sendJson(res, 401, { message: 'Requires authentication' });
    return;
  }
  const method = (req.method ?? 'GET').toUpperCase();
  // Git-Protocol carries colon-separated key=value settings; version=2 selects the v2 wire format.
  const v2 = String(req.headers['git-protocol'] ?? '').split(':').includes('version=2');

  if (method === 'GET' && route.rest === '/info/refs') {
    const url = new URL(req.url ?? '/', 'http://forge.local');
    const service = url.searchParams.get('service');
    if (service !== 'git-upload-pack' && service !== 'git-receive-pack') {
      throw new HttpError(403, 'dumb HTTP protocol is not supported');
    }
    const repo = repoFor(store, route.owner, route.name);
    const useV2 = service === 'git-upload-pack' && v2;
    const body = useV2 ? advertiseV2() : advertiseV0(store, repo, store.objects, service === 'git-upload-pack' ? 'upload-pack' : 'receive-pack');
    sendText(res, 200, `application/x-${service}-advertisement`, body, { 'cache-control': 'no-cache' });
    return;
  }

  if (method === 'POST' && (route.rest === '/git-upload-pack' || route.rest === '/git-receive-pack')) {
    const repo = repoFor(store, route.owner, route.name);
    const raw = await readBody(req, GIT_BODY_LIMIT);
    try {
      if (route.rest === '/git-upload-pack') {
        const out = v2 ? uploadPackV2(store, repo, raw) : uploadPackV0(store, repo, raw);
        sendText(res, 200, 'application/x-git-upload-pack-result', out, { 'cache-control': 'no-cache' });
      } else {
        const out = receivePack(store, repo, raw);
        sendText(res, 200, 'application/x-git-receive-pack-result', out, { 'cache-control': 'no-cache' });
      }
    } catch (err) {
      if (err instanceof SmartError) {
        sendText(res, err.status, 'text/plain; charset=utf-8', `${err.message}\n`);
        return;
      }
      throw err;
    }
    return;
  }

  throw new HttpError(404, 'Not Found');
}
