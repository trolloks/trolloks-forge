// POST /api/graphql: the bearer token is required (401 without it); a body is one {query, variables,
// operationName} object or an array of them (operation batching, answered in order). Query-level failures
// are HTTP 200 with an errors array; only a body that is not JSON is a 400.

import type { IncomingMessage, ServerResponse } from 'node:http';
import { bearerToken, parseJsonBody, sendJson, tokenMatches, HttpError } from '../http/util.ts';
import type { Store } from '../store/store.ts';
import { runQuery, type ExecutionResult } from './engine.ts';

interface RequestItem {
  query: string;
  operationName: string | null;
  variables: Record<string, unknown>;
}

function itemOf(value: unknown): RequestItem {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) throw new HttpError(400, 'Problems parsing JSON');
  const object = value as Record<string, unknown>;
  if (typeof object.query !== 'string') throw new HttpError(400, 'A GraphQL request needs a query string');
  let variables: Record<string, unknown> = {};
  if (typeof object.variables === 'string' && object.variables.trim() !== '') {
    try {
      variables = JSON.parse(object.variables) as Record<string, unknown>;
    } catch {
      throw new HttpError(400, 'variables is not valid JSON');
    }
  } else if (typeof object.variables === 'object' && object.variables !== null && !Array.isArray(object.variables)) {
    variables = object.variables as Record<string, unknown>;
  }
  const operationName = typeof object.operationName === 'string' ? object.operationName : null;
  return { query: object.query, operationName, variables };
}

export function handleGraphql(store: Store, token: string, origin: string, req: IncomingMessage, res: ServerResponse, raw: Buffer): void {
  const presented = bearerToken(req);
  if (presented === null || !tokenMatches(presented, token)) {
    sendJson(res, 401, { message: 'Requires authentication', documentation_url: 'https://docs.github.com/graphql' });
    return;
  }
  if ((req.method ?? 'GET').toUpperCase() !== 'POST') {
    sendJson(res, 405, { message: 'GraphQL requests must be POST' });
    return;
  }
  const body = parseJsonBody(raw);
  if (body === null) throw new HttpError(400, 'Problems parsing JSON');
  const ctx = { store, origin };
  if (Array.isArray(body)) {
    const answers: ExecutionResult[] = body.map((entry) => {
      const item = itemOf(entry);
      return runQuery(item.query, item.operationName, item.variables, ctx);
    });
    sendJson(res, 200, answers);
    return;
  }
  const item = itemOf(body);
  sendJson(res, 200, runQuery(item.query, item.operationName, item.variables, ctx));
}
