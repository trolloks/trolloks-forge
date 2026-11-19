// The Model Context Protocol endpoint: JSON-RPC 2.0 over POST /mcp, answered as application/json (one reply
// per request, with no session state). It speaks the 2026-07-28 revision (server/discover answers the
// supported revisions) and the handshake revisions (initialize and notifications/initialized). Its tools act
// on the same store the REST, git and GraphQL surfaces use, so a repository or issue made here reads back
// over REST as the same object with the same id.

import type { IncomingMessage, ServerResponse } from 'node:http';
import { repoFor } from '../api/rest.ts';
import {
  addCommentRecord,
  createIssueRecord,
  createPullRecord,
  createRepository,
  mergeableOf,
  mergePullRecord,
  validation,
} from '../api/service.ts';
import { issueJson, pullJson, repoJson } from '../api/shapes.ts';
import { HttpError, bearerToken, parseJsonBody, readBody, sendJson, tokenMatches } from '../http/util.ts';
import type { IssueRecord, RepoRecord, Store } from '../store/store.ts';

export const MCP_BODY_LIMIT = 4 * 1024 * 1024;
export const SUPPORTED_REVISIONS = ['2026-07-28', '2025-11-25'] as const;
export const SERVER_INFO = { name: 'makefun-forge', version: '1.0.0' };

export const JSON_RPC = {
  parse: -32700,
  invalidRequest: -32600,
  methodNotFound: -32601,
  invalidParams: -32602,
} as const;

interface RpcError {
  readonly code: number;
  readonly message: string;
}

class RpcFailure extends Error {
  readonly code: number;
  constructor(code: number, message: string) {
    super(message);
    this.code = code;
  }
}

// ---------------------------------------------------------------- tools

const OWNER = { type: 'string', description: 'The account that owns the repository.' };
const REPO = { type: 'string', description: 'The repository name.' };
const NUMBER = { type: 'integer', description: 'The issue or pull request number.' };

/** The tool list. Static: tools/list answers these bytes every time. */
export const TOOLS = Object.freeze([
  {
    name: 'create_repo',
    description: 'Create a repository owned by the authenticated user.',
    inputSchema: {
      type: 'object',
      properties: {
        name: { type: 'string', description: 'The repository name.' },
        description: { type: 'string', description: 'A short description.' },
        private: { type: 'boolean', description: 'Whether the repository is private.' },
        auto_init: { type: 'boolean', description: 'Create an initial commit with a README.' },
      },
      required: ['name'],
    },
  },
  {
    name: 'get_repo',
    description: 'Get a repository by owner and name.',
    inputSchema: { type: 'object', properties: { owner: OWNER, repo: REPO }, required: ['owner', 'repo'] },
  },
  {
    name: 'create_issue',
    description: 'Create an issue in a repository.',
    inputSchema: {
      type: 'object',
      properties: { owner: OWNER, repo: REPO, title: { type: 'string', description: 'The issue title.' }, body: { type: 'string', description: 'The issue body.' } },
      required: ['owner', 'repo', 'title'],
    },
  },
  {
    name: 'list_issues',
    description: 'List issues in a repository, open ones by default.',
    inputSchema: {
      type: 'object',
      properties: { owner: OWNER, repo: REPO, state: { type: 'string', enum: ['open', 'closed', 'all'], description: 'Which issues to list.' } },
      required: ['owner', 'repo'],
    },
  },
  {
    name: 'get_issue',
    description: 'Get one issue by its number.',
    inputSchema: { type: 'object', properties: { owner: OWNER, repo: REPO, issue_number: NUMBER }, required: ['owner', 'repo', 'issue_number'] },
  },
  {
    name: 'add_issue_comment',
    description: 'Add a comment to an issue or pull request.',
    inputSchema: {
      type: 'object',
      properties: { owner: OWNER, repo: REPO, issue_number: NUMBER, body: { type: 'string', description: 'The comment text.' } },
      required: ['owner', 'repo', 'issue_number', 'body'],
    },
  },
  {
    name: 'create_pull_request',
    description: 'Open a pull request from a head branch into a base branch.',
    inputSchema: {
      type: 'object',
      properties: {
        owner: OWNER,
        repo: REPO,
        title: { type: 'string', description: 'The pull request title.' },
        body: { type: 'string', description: 'The pull request body.' },
        head: { type: 'string', description: 'The branch with the changes.' },
        base: { type: 'string', description: 'The branch to merge into.' },
      },
      required: ['owner', 'repo', 'title', 'head', 'base'],
    },
  },
  {
    name: 'list_pull_requests',
    description: 'List pull requests in a repository, open ones by default.',
    inputSchema: {
      type: 'object',
      properties: { owner: OWNER, repo: REPO, state: { type: 'string', enum: ['open', 'closed', 'all'], description: 'Which pull requests to list.' } },
      required: ['owner', 'repo'],
    },
  },
  {
    name: 'get_pull_request',
    description: 'Get one pull request by its number.',
    inputSchema: { type: 'object', properties: { owner: OWNER, repo: REPO, pull_number: NUMBER }, required: ['owner', 'repo', 'pull_number'] },
  },
  {
    name: 'merge_pull_request',
    description: 'Merge an open pull request into its base branch.',
    inputSchema: {
      type: 'object',
      properties: {
        owner: OWNER,
        repo: REPO,
        pull_number: NUMBER,
        merge_method: { type: 'string', enum: ['merge', 'squash'], description: 'How to merge; a merge commit by default.' },
      },
      required: ['owner', 'repo', 'pull_number'],
    },
  },
]);

// ---------------------------------------------------------------- argument readers

type Args = Record<string, unknown>;

function requiredString(args: Args, name: string): string {
  const value = args[name];
  if (typeof value !== 'string' || value === '') throw new RpcFailure(JSON_RPC.invalidParams, `missing required argument ${name}`);
  return value;
}

function optionalString(args: Args, name: string): string | undefined {
  const value = args[name];
  if (value === undefined || value === null) return undefined;
  if (typeof value !== 'string') throw new RpcFailure(JSON_RPC.invalidParams, `argument ${name} must be a string`);
  return value;
}

function requiredNumber(args: Args, name: string): number {
  const value = args[name];
  if (typeof value !== 'number' || !Number.isInteger(value) || value < 1) throw new RpcFailure(JSON_RPC.invalidParams, `missing required argument ${name}`);
  return value;
}

function issueFor(store: Store, repo: RepoRecord, number: number): IssueRecord {
  const issue = store.issueByNumber(repo.id, number);
  if (issue === undefined) throw new HttpError(404, 'Not Found');
  return issue;
}

// ---------------------------------------------------------------- the tools

interface Outcome {
  readonly value: unknown;
}

function callTool(store: Store, origin: string, name: string, args: Args): Outcome {
  switch (name) {
    case 'create_repo': {
      const repo = createRepository(store, {
        name: requiredString(args, 'name'),
        description: optionalString(args, 'description') ?? '',
        private: args.private === true,
        defaultBranch: 'main',
        autoInit: args.auto_init === true,
      });
      return { value: repoJson(store, repo, origin) };
    }
    case 'get_repo': {
      const repo = repoFor(store, requiredString(args, 'owner'), requiredString(args, 'repo'));
      return { value: repoJson(store, repo, origin) };
    }
    case 'create_issue': {
      const repo = repoFor(store, requiredString(args, 'owner'), requiredString(args, 'repo'));
      const issue = createIssueRecord(store, repo, { title: requiredString(args, 'title'), body: optionalString(args, 'body') ?? '', labels: [] });
      return { value: issueJson(store, issue, repo, origin) };
    }
    case 'list_issues': {
      const repo = repoFor(store, requiredString(args, 'owner'), requiredString(args, 'repo'));
      const state = optionalString(args, 'state') ?? 'open';
      if (state !== 'open' && state !== 'closed' && state !== 'all') throw new RpcFailure(JSON_RPC.invalidParams, 'state must be open, closed or all');
      const issues = store.listIssueRecords(repo.id).filter((issue) => !issue.is_pull && (state === 'all' || issue.state === state));
      return { value: issues.map((issue) => issueJson(store, issue, repo, origin)) };
    }
    case 'get_issue': {
      const repo = repoFor(store, requiredString(args, 'owner'), requiredString(args, 'repo'));
      const issue = issueFor(store, repo, requiredNumber(args, 'issue_number'));
      return { value: issueJson(store, issue, repo, origin) };
    }
    case 'add_issue_comment': {
      const repo = repoFor(store, requiredString(args, 'owner'), requiredString(args, 'repo'));
      const issue = issueFor(store, repo, requiredNumber(args, 'issue_number'));
      const comment = addCommentRecord(store, repo, issue, requiredString(args, 'body'));
      return { value: { id: comment.id, body: comment.body, issue_number: issue.number, created_at: comment.created_at } };
    }
    case 'create_pull_request': {
      const repo = repoFor(store, requiredString(args, 'owner'), requiredString(args, 'repo'));
      const issue = createPullRecord(store, repo, {
        title: requiredString(args, 'title'),
        body: optionalString(args, 'body') ?? '',
        head: requiredString(args, 'head'),
        base: requiredString(args, 'base'),
      });
      return { value: pullJson(store, issue, repo, origin, mergeableOf(store, repo, issue)) };
    }
    case 'list_pull_requests': {
      const repo = repoFor(store, requiredString(args, 'owner'), requiredString(args, 'repo'));
      const state = optionalString(args, 'state') ?? 'open';
      if (state !== 'open' && state !== 'closed' && state !== 'all') throw new RpcFailure(JSON_RPC.invalidParams, 'state must be open, closed or all');
      const pulls = store.listIssueRecords(repo.id).filter((issue) => issue.is_pull && (state === 'all' || issue.state === state));
      return { value: pulls.map((issue) => pullJson(store, issue, repo, origin, mergeableOf(store, repo, issue))) };
    }
    case 'get_pull_request': {
      const repo = repoFor(store, requiredString(args, 'owner'), requiredString(args, 'repo'));
      const issue = issueFor(store, repo, requiredNumber(args, 'pull_number'));
      if (!issue.is_pull) throw new HttpError(404, 'Not Found');
      return { value: pullJson(store, issue, repo, origin, mergeableOf(store, repo, issue)) };
    }
    case 'merge_pull_request': {
      const repo = repoFor(store, requiredString(args, 'owner'), requiredString(args, 'repo'));
      const issue = issueFor(store, repo, requiredNumber(args, 'pull_number'));
      if (!issue.is_pull) throw new HttpError(404, 'Not Found');
      const method = optionalString(args, 'merge_method') ?? 'merge';
      if (method !== 'merge' && method !== 'squash') throw validation('merge_method must be merge or squash');
      const sha = mergePullRecord(store, repo, issue, { method });
      return { value: { sha, merged: true, message: 'Pull Request successfully merged' } };
    }
    default:
      throw new RpcFailure(JSON_RPC.invalidParams, `unknown tool ${name}`);
  }
}

function toolResult(value: unknown): Record<string, unknown> {
  const text = JSON.stringify(value);
  const result: Record<string, unknown> = { content: [{ type: 'text', text }], isError: false };
  if (value !== null && typeof value === 'object' && !Array.isArray(value)) result.structuredContent = value;
  return result;
}

function toolError(message: string): Record<string, unknown> {
  return { content: [{ type: 'text', text: message }], isError: true };
}

// ---------------------------------------------------------------- JSON-RPC

function ok(id: unknown, result: unknown): Record<string, unknown> {
  return { jsonrpc: '2.0', id, result };
}

function fail(id: unknown, error: RpcError): Record<string, unknown> {
  return { jsonrpc: '2.0', id, error };
}

/** Answer one JSON-RPC message. Returns null for a notification (no reply). */
function dispatchMessage(store: Store, origin: string, message: unknown): Record<string, unknown> | null {
  if (typeof message !== 'object' || message === null || Array.isArray(message)) {
    return fail(null, { code: JSON_RPC.invalidRequest, message: 'Invalid Request' });
  }
  const request = message as Record<string, unknown>;
  const hasId = Object.prototype.hasOwnProperty.call(request, 'id');
  const id = request.id ?? null;
  if (request.jsonrpc !== '2.0' || typeof request.method !== 'string') {
    return hasId ? fail(id, { code: JSON_RPC.invalidRequest, message: 'Invalid Request' }) : null;
  }
  const method = request.method;
  const params = typeof request.params === 'object' && request.params !== null && !Array.isArray(request.params) ? (request.params as Args) : {};
  if (!hasId) return null;
  try {
    switch (method) {
      case 'server/discover':
        return ok(id, {
          supportedVersions: [...SUPPORTED_REVISIONS],
          capabilities: { tools: { listChanged: false } },
          serverInfo: { ...SERVER_INFO },
        });
      case 'initialize': {
        const requested = typeof params.protocolVersion === 'string' ? params.protocolVersion : '';
        const negotiated = (SUPPORTED_REVISIONS as readonly string[]).includes(requested) ? requested : SUPPORTED_REVISIONS[SUPPORTED_REVISIONS.length - 1];
        return ok(id, { protocolVersion: negotiated, capabilities: { tools: { listChanged: false } }, serverInfo: { ...SERVER_INFO } });
      }
      case 'ping':
        return ok(id, {});
      case 'tools/list':
        return ok(id, { tools: TOOLS });
      case 'tools/call': {
        const name = typeof params.name === 'string' ? params.name : '';
        if (name === '' || !TOOLS.some((tool) => tool.name === name)) {
          return fail(id, { code: JSON_RPC.invalidParams, message: `Unknown tool: ${name}` });
        }
        const args = typeof params.arguments === 'object' && params.arguments !== null && !Array.isArray(params.arguments) ? (params.arguments as Args) : {};
        try {
          return ok(id, toolResult(callTool(store, origin, name, args).value));
        } catch (err) {
          if (err instanceof RpcFailure) return fail(id, { code: err.code, message: err.message });
          if (err instanceof HttpError) return ok(id, toolError(err.message));
          throw err;
        }
      }
      default:
        return fail(id, { code: JSON_RPC.methodNotFound, message: `Method not found: ${method}` });
    }
  } catch (err) {
    const message = err instanceof Error ? err.message : 'internal error';
    return ok(id, toolError(message));
  }
}

/** Handle POST /mcp. The bearer token is required on every request. */
export async function handleMcp(store: Store, token: string, origin: string, req: IncomingMessage, res: ServerResponse): Promise<void> {
  const presented = bearerToken(req);
  if (presented === null || !tokenMatches(presented, token)) {
    sendJson(res, 401, { jsonrpc: '2.0', id: null, error: { code: JSON_RPC.invalidRequest, message: 'Requires authentication' } });
    return;
  }
  if ((req.method ?? 'GET').toUpperCase() !== 'POST') {
    sendJson(res, 405, { jsonrpc: '2.0', id: null, error: { code: JSON_RPC.invalidRequest, message: 'Use POST for JSON-RPC requests' } }, { allow: 'POST' });
    return;
  }
  const raw = await readBody(req, MCP_BODY_LIMIT);
  let body: unknown;
  try {
    body = parseJsonBody(raw);
  } catch {
    sendJson(res, 400, { jsonrpc: '2.0', id: null, error: { code: JSON_RPC.parse, message: 'Parse error' } });
    return;
  }
  if (body === null) {
    sendJson(res, 400, { jsonrpc: '2.0', id: null, error: { code: JSON_RPC.parse, message: 'Parse error' } });
    return;
  }
  if (Array.isArray(body)) {
    const replies = body.map((entry) => dispatchMessage(store, origin, entry)).filter((reply): reply is Record<string, unknown> => reply !== null);
    if (replies.length === 0) {
      res.writeHead(202);
      res.end();
      return;
    }
    sendJson(res, 200, replies);
    return;
  }
  const reply = dispatchMessage(store, origin, body);
  if (reply === null) {
    res.writeHead(202);
    res.end();
    return;
  }
  sendJson(res, 200, reply);
}
