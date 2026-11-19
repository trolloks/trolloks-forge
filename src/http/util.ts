// HTTP plumbing shared by every surface: JSON replies with a request id, bounded body reads (gzip-aware),
// bearer-token checks that compare in constant time, and the error type handlers throw.

import { randomBytes, timingSafeEqual, createHash } from 'node:crypto';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { gunzipSync, inflateSync } from 'node:zlib';

export const JSON_TYPE = 'application/json; charset=utf-8';

/** An error that becomes an HTTP reply. The body is `{message, ...extra}`. */
export class HttpError extends Error {
  readonly status: number;
  readonly extra: Record<string, unknown>;
  constructor(status: number, message: string, extra: Record<string, unknown> = {}) {
    super(message);
    this.status = status;
    this.extra = extra;
  }
}

let requestCounter = 0;
const requestSalt = randomBytes(4).toString('hex').toUpperCase();

/** A request id in GitHub's shape, unique per process. */
export function newRequestId(): string {
  requestCounter += 1;
  return `${requestSalt}:${requestCounter.toString(16).toUpperCase()}`;
}

export function sendJson(res: ServerResponse, status: number, body: unknown, headers: Record<string, string> = {}): void {
  const text = `${JSON.stringify(body)}\n`;
  res.writeHead(status, {
    'content-type': JSON_TYPE,
    'content-length': Buffer.byteLength(text),
    'x-github-request-id': newRequestId(),
    ...headers,
  });
  res.end(text);
}

export function sendError(res: ServerResponse, error: unknown): void {
  if (error instanceof HttpError) {
    sendJson(res, error.status, { message: error.message, ...error.extra });
    return;
  }
  const message = error instanceof Error ? error.message : 'internal error';
  process.stderr.write(`[forge] unhandled: ${message}\n`);
  sendJson(res, 500, { message: 'Server Error' });
}

export function sendText(res: ServerResponse, status: number, contentType: string, body: Buffer | string, headers: Record<string, string> = {}): void {
  const bytes = typeof body === 'string' ? Buffer.from(body, 'utf8') : body;
  res.writeHead(status, {
    'content-type': contentType,
    'content-length': bytes.length,
    'x-github-request-id': newRequestId(),
    ...headers,
  });
  res.end(bytes);
}

/** Read a request body, refusing anything over `limit` bytes. Gzip and deflate encodings are undone. */
export function readBody(req: IncomingMessage, limit: number): Promise<Buffer> {
  return new Promise<Buffer>((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    let failed = false;
    req.on('data', (chunk: Buffer) => {
      if (failed) return;
      size += chunk.length;
      if (size > limit) {
        failed = true;
        reject(new HttpError(413, 'Request body is too large'));
        req.resume();
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => {
      if (failed) return;
      const raw = Buffer.concat(chunks);
      const encoding = String(req.headers['content-encoding'] ?? '').toLowerCase();
      try {
        if (encoding === 'gzip' || encoding === 'x-gzip') {
          const out = gunzipSync(raw, { maxOutputLength: limit });
          resolve(out);
        } else if (encoding === 'deflate') {
          resolve(inflateSync(raw, { maxOutputLength: limit }));
        } else {
          resolve(raw);
        }
      } catch {
        reject(new HttpError(400, 'Request body could not be decoded'));
      }
    });
    req.on('error', (err) => reject(err));
  });
}

/** Parse a JSON request body. An empty body is `null`; malformed JSON is a 400. */
export function parseJsonBody(raw: Buffer): unknown {
  if (raw.length === 0) return null;
  try {
    return JSON.parse(raw.toString('utf8'));
  } catch {
    throw new HttpError(400, 'Problems parsing JSON');
  }
}

/** The bearer token from an Authorization header (`Bearer x` or `token x`), or null. */
export function bearerToken(req: IncomingMessage): string | null {
  const header = req.headers.authorization;
  if (typeof header !== 'string') return null;
  const match = /^(?:bearer|token)\s+(\S+)\s*$/i.exec(header);
  return match ? match[1] : null;
}

/** Constant-time equality of two secrets (hashes first so the lengths never leak). */
export function tokenMatches(presented: string, expected: string): boolean {
  if (expected.length === 0) return false;
  const a = createHash('sha256').update(presented).digest();
  const b = createHash('sha256').update(expected).digest();
  return timingSafeEqual(a, b) && presented.length === expected.length;
}

/** The request path (no query) and query parameters. Never throws. */
export function parseUrl(req: IncomingMessage): { path: string; query: URLSearchParams; url: URL } {
  const url = new URL(req.url ?? '/', 'http://forge.local');
  return { path: url.pathname, query: url.searchParams, url };
}

/** The origin a client used to reach us, for absolute links (Link headers, clone URLs). */
export function originOf(req: IncomingMessage): string {
  const host = typeof req.headers.host === 'string' && req.headers.host !== '' ? req.headers.host : 'localhost';
  return `http://${host}`;
}

export function decodeSegment(segment: string): string {
  try {
    return decodeURIComponent(segment);
  } catch {
    throw new HttpError(400, 'Malformed path encoding');
  }
}

/** Parse `per_page` and `page` with GitHub's defaults and bounds. */
export function pageParams(query: URLSearchParams, defaultPerPage = 30): { page: number; perPage: number } {
  const perPageRaw = Number(query.get('per_page') ?? defaultPerPage);
  const pageRaw = Number(query.get('page') ?? 1);
  const perPage = Number.isInteger(perPageRaw) && perPageRaw >= 1 ? Math.min(100, perPageRaw) : defaultPerPage;
  const page = Number.isInteger(pageRaw) && pageRaw >= 1 ? pageRaw : 1;
  return { page, perPage };
}

/** A Link header for a page of `total` items, built from the request's own path and query. */
export function linkHeader(origin: string, path: string, query: URLSearchParams, page: number, perPage: number, total: number): string | undefined {
  const last = Math.max(1, Math.ceil(total / perPage));
  const link = (target: number, rel: string): string => {
    const params = new URLSearchParams(query);
    params.set('page', String(target));
    params.set('per_page', String(perPage));
    return `<${origin}${path}?${params.toString()}>; rel="${rel}"`;
  };
  const parts: string[] = [];
  if (page < last) parts.push(link(page + 1, 'next'));
  if (page > 1) parts.push(link(page - 1, 'prev'));
  if (page > 1) parts.push(link(1, 'first'));
  if (page < last) parts.push(link(last, 'last'));
  return parts.length > 0 ? parts.join(', ') : undefined;
}

/** Slice one page out of a list. */
export function pageOf<T>(items: readonly T[], page: number, perPage: number): T[] {
  const start = (page - 1) * perPage;
  return items.slice(start, start + perPage);
}
