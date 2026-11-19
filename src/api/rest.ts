// REST v3 under /api/v3: repositories, branches, commits, git refs, contents, labels, issues, comments,
// pull requests, their files, and merges. Every reply is JSON. Status codes and bodies follow GitHub's
// shapes; where GitHub has a rule (422 for an unknown label, 409 for a stale contents sha, 405 for a
// conflicted merge, 404 for another owner's repository) the same rule holds here.

import type { IncomingMessage, ServerResponse } from 'node:http';
import { HttpError, bearerToken, decodeSegment, linkHeader, newRequestId as requestIdFor, pageOf, pageParams, parseJsonBody, sendJson, tokenMatches } from '../http/util.ts';
import {
  commitOf,
  commitsReachable,
  editPath,
  flattenTree,
  isAncestor,
  logOrder,
  lookupEntry,
  mergeBaseOne,
  mergeTrees,
  peelToCommit,
  requireObject,
  validRefName,
} from '../git/ops.ts';
import { buildCommit, isOid, isTreeMode, parseTree, type GitObject } from '../git/objects.ts';
import { NAME_RE, StoreError, type IssueRecord, type RepoRecord, type Store } from '../store/store.ts';
import {
  commentJson,
  commitJson,
  dirEntryJson,
  diffTrees,
  fileJson,
  issueJson,
  labelJsonFor,
  pullJson,
  repoFullName,
  repoJson,
  userJson,
  nodeId,
} from './shapes.ts';
import {
  addCommentRecord,
  createRepository,
  createIssueRecord,
  createPullRecord,
  emptyTree,
  labelNamesFor,
  mergeableOf,
  mergePullRecord,
  putObject,
  signatureFor,
  validation,
} from './service.ts';

export const API_ROOT = '/api/v3';
export const META_VERSION = '3.16.0+makefun.1';

/** The body limit for JSON requests: the contents API's largest file is well below this. */
export const JSON_BODY_LIMIT = 16 * 1024 * 1024;

export interface RestRequest {
  readonly method: string;
  readonly path: string;
  readonly query: URLSearchParams;
  readonly origin: string;
  readonly body: unknown;
  readonly params: Record<string, string>;
  readonly store: Store;
  readonly rawHeaders: IncomingMessage['headers'];
}

type Handler = (request: RestRequest) => Reply;

/** What a handler returns: a status, a JSON body (or none), and extra headers. */
export interface Reply {
  readonly status: number;
  readonly body?: unknown;
  readonly headers?: Record<string, string>;
}

interface Route {
  readonly method: string;
  readonly pattern: string[];
  readonly handler: Handler;
}

const routes: Route[] = [];

function route(method: string, pattern: string, handler: Handler): void {
  routes.push({ method, pattern: pattern.split('/').filter(Boolean), handler });
}

/** Match a path against a pattern. `:name` is one segment; a trailing `*name` takes the rest (maybe empty). */
function matchPattern(pattern: string[], segments: string[]): Record<string, string> | null {
  const params: Record<string, string> = {};
  for (let index = 0; index < pattern.length; index += 1) {
    const part = pattern[index];
    if (part.startsWith('*')) {
      params[part.slice(1)] = segments.slice(index).map(decodeSegment).join('/');
      return params;
    }
    if (index >= segments.length) return null;
    if (part.startsWith(':')) params[part.slice(1)] = decodeSegment(segments[index]);
    else if (part !== segments[index]) return null;
  }
  return pattern.length === segments.length ? params : null;
}

// ---------------------------------------------------------------- helpers

function notFound(): HttpError {
  return new HttpError(404, 'Not Found');
}

function asObject(body: unknown): Record<string, unknown> {
  if (typeof body !== 'object' || body === null || Array.isArray(body)) throw new HttpError(400, 'Problems parsing JSON');
  return body as Record<string, unknown>;
}

function requireString(object: Record<string, unknown>, field: string): string {
  const value = object[field];
  if (typeof value !== 'string' || value.length === 0) {
    throw validation(`${field} is required`, [{ resource: 'Issue', code: 'missing_field', field }]);
  }
  return value;
}

function optionalString(object: Record<string, unknown>, field: string): string | undefined {
  const value = object[field];
  if (value === undefined || value === null) return undefined;
  if (typeof value !== 'string') throw validation(`${field} must be a string`, [{ resource: 'Issue', code: 'invalid', field }]);
  return value;
}

/**
 * Resolve the repository an owner-scoped request names. The first owner-scoped request binds the token's
 * login (this forge serves exactly one); any other owner, or a name the forge does not hold, is a 404.
 */
export function repoFor(store: Store, owner: string, name: string): RepoRecord {
  if (store.login === null) store.bindLogin(owner);
  if (store.login === null || store.login.toLowerCase() !== owner.toLowerCase()) throw notFound();
  const repo = store.repoByName(name);
  if (repo === undefined) throw notFound();
  return repo;
}

function link(req: RestRequest, total: number, page: number, perPage: number): Record<string, string> {
  const header = linkHeader(req.origin, req.path, req.query, page, perPage, total);
  return header === undefined ? {} : { link: header };
}

/** Commit ids of a ref or sha text: a branch, a tag, a full object id. */
function resolveCommitish(store: Store, repo: RepoRecord, text: string): string | undefined {
  if (isOid(text)) return peelToCommit(store.objects, text);
  const candidates = [text, `refs/heads/${text}`, `refs/tags/${text}`];
  for (const candidate of candidates) {
    const oid = store.getRef(repo.id, candidate);
    if (oid !== undefined) return peelToCommit(store.objects, oid);
  }
  return undefined;
}

function defaultTip(store: Store, repo: RepoRecord): string | undefined {
  const oid = store.getRef(repo.id, `refs/heads/${repo.default_branch}`);
  return oid === undefined ? undefined : peelToCommit(store.objects, oid);
}

/**
 * Write one commit that changes one path on a branch: the file (or its deletion), a new root tree and a
 * commit on top of the branch tip, then the branch moves. Returns the new commit and the blob that was written.
 */
function commitFileChange(
  store: Store,
  repo: RepoRecord,
  options: {
    branch: string;
    path: string;
    content: Buffer | null;
    message: string;
    expectSha: string | undefined;
    author?: Record<string, unknown>;
    committer?: Record<string, unknown>;
  },
): { commit: string; blob: string | null; created: boolean; mode: string | null } {
  const refName = `refs/heads/${options.branch}`;
  const tipOid = store.getRef(repo.id, refName);
  const tip = tipOid === undefined ? undefined : peelToCommit(store.objects, tipOid);
  const rootTree = tip === undefined ? null : commitOf(store.objects, tip).tree;
  const existing = rootTree === null ? undefined : lookupEntry(store.objects, rootTree, options.path);
  if (existing !== undefined && isTreeMode(existing.mode)) throw validation(`${options.path} is a directory`, [{ resource: 'Blob', code: 'invalid', field: 'path' }]);
  if (options.content === null && existing === undefined) throw notFound();
  if (existing !== undefined && options.expectSha === undefined) {
    throw validation(`Invalid request.\n\n"sha" wasn't supplied.`, [{ resource: 'Blob', code: 'missing_field', field: 'sha' }]);
  }
  if (options.expectSha !== undefined && (existing === undefined ? true : existing.oid !== options.expectSha)) {
    throw new HttpError(409, `${options.path} does not match ${options.expectSha}`);
  }

  let blob: string | null = null;
  let mode: string | null = null;
  let newRoot: string | null;
  if (options.content === null) {
    newRoot = rootTree === null ? null : editPath(store.objects, rootTree, options.path, null);
  } else {
    blob = putObject(store, { type: 'blob', data: options.content });
    mode = existing?.mode ?? '100644';
    newRoot = editPath(store.objects, rootTree, options.path, { mode, oid: blob });
  }
  const tree = newRoot ?? emptyTree(store);
  const parents = tip === undefined ? [] : [tip];
  const commit = putObject(store, {
    type: 'commit',
    data: buildCommit({
      tree,
      parents,
      author: signatureFor(store, options.author),
      committer: signatureFor(store, options.committer),
      message: options.message,
    }),
  });
  store.setRef(repo.id, refName, commit);
  store.touchRepo(repo, true);
  return { commit, blob, created: existing === undefined, mode };
}

function decodeContent(text: unknown): Buffer {
  if (typeof text !== 'string') throw validation('content is required', [{ resource: 'Blob', code: 'missing_field', field: 'content' }]);
  const compact = text.replace(/\s+/g, '');
  if (compact.length % 4 !== 0 || !/^[A-Za-z0-9+/]*={0,2}$/.test(compact)) {
    throw validation('content is not valid base64', [{ resource: 'Blob', code: 'invalid', field: 'content' }]);
  }
  return Buffer.from(compact, 'base64');
}

/** A repository path from the URL: no empty, dot or .git segments, and no control characters. */
function safeRepoPath(path: string): string {
  if (path.length === 0) throw validation('path is required', [{ resource: 'Blob', code: 'missing_field', field: 'path' }]);
  if (path.length > 4096) throw validation('path is too long');
  for (const segment of path.split('/')) {
    if (segment === '' || segment === '.' || segment === '..' || segment.toLowerCase() === '.git') {
      throw validation(`path ${JSON.stringify(path)} is not a valid repository path`, [{ resource: 'Blob', code: 'invalid', field: 'path' }]);
    }
  }
  if (/[\u0000-\u001f\\]/.test(path)) throw validation('path contains a forbidden character', [{ resource: 'Blob', code: 'invalid', field: 'path' }]);
  return path;
}

function trimPath(path: string): string {
  return path.replace(/^\/+|\/+$/g, '');
}

// ---------------------------------------------------------------- root, meta, user

route('GET', '/', (req) => ({
  status: 200,
  body: {
    current_user_url: `${req.origin}${API_ROOT}/user`,
    repository_url: `${req.origin}${API_ROOT}/repos/{owner}/{repo}`,
    user_repositories_url: `${req.origin}${API_ROOT}/user/repos{?type,page,per_page,sort}`,
    issues_url: `${req.origin}${API_ROOT}/issues`,
    rate_limit_url: `${req.origin}${API_ROOT}/rate_limit`,
  },
  headers: { 'x-oauth-scopes': 'repo, read:org', 'x-accepted-oauth-scopes': '' },
}));

route('GET', '/meta', () => ({ status: 200, body: { installed_version: META_VERSION, verifiable_password_authentication: false } }));

route('GET', '/user', (req) => {
  const login = req.store.login;
  if (login === null) throw notFound();
  return { status: 200, body: userJson(login, req.origin) };
});

// ---------------------------------------------------------------- repositories

route('GET', '/user/repos', (req) => {
  const repos = req.store.listRepos();
  const { page, perPage } = pageParams(req.query);
  return { status: 200, body: pageOf(repos, page, perPage).map((repo) => repoJson(req.store, repo, req.origin)), headers: link(req, repos.length, page, perPage) };
});

route('POST', '/user/repos', (req) => {
  const body = asObject(req.body);
  const name = requireString(body, 'name');
  const repo = createRepository(req.store, {
    name,
    description: optionalString(body, 'description') ?? '',
    private: body.private === true,
    defaultBranch: optionalString(body, 'default_branch') ?? 'main',
    autoInit: body.auto_init === true,
  });
  return { status: 201, body: repoJson(req.store, repo, req.origin) };
});

route('GET', '/repos/:owner/:repo', (req) => {
  const repo = repoFor(req.store, req.params.owner, req.params.repo);
  return { status: 200, body: repoJson(req.store, repo, req.origin) };
});

route('PATCH', '/repos/:owner/:repo', (req) => {
  const repo = repoFor(req.store, req.params.owner, req.params.repo);
  const body = asObject(req.body);
  const patch: Partial<Pick<RepoRecord, 'name' | 'description' | 'private' | 'default_branch'>> = {};
  if (body.name !== undefined) {
    const name = requireString(body, 'name');
    if (!NAME_RE.test(name)) throw validation('name is invalid', [{ resource: 'Repository', code: 'invalid', field: 'name' }]);
    if (name.toLowerCase() !== repo.name.toLowerCase() && req.store.repoByName(name)) {
      throw new HttpError(422, 'Repository creation failed.', { errors: [{ resource: 'Repository', code: 'custom', field: 'name', message: 'name already exists on this account' }] });
    }
    patch.name = name;
  }
  if (body.description !== undefined) patch.description = optionalString(body, 'description') ?? '';
  if (body.private !== undefined) patch.private = body.private === true;
  if (body.default_branch !== undefined) {
    const branch = requireString(body, 'default_branch');
    if (req.store.getRef(repo.id, `refs/heads/${branch}`) === undefined) throw validation('default_branch does not exist', [{ resource: 'Repository', code: 'invalid', field: 'default_branch' }]);
    patch.default_branch = branch;
  }
  const updated = req.store.updateRepo(repo, patch);
  return { status: 200, body: repoJson(req.store, updated, req.origin) };
});

route('DELETE', '/repos/:owner/:repo', (req) => {
  const repo = repoFor(req.store, req.params.owner, req.params.repo);
  req.store.deleteRepo(repo);
  return { status: 204 };
});

// ---------------------------------------------------------------- branches, commits, git refs

route('GET', '/repos/:owner/:repo/branches', (req) => {
  const repo = repoFor(req.store, req.params.owner, req.params.repo);
  const branches = [...req.store.refsOf(repo.id).entries()]
    .filter(([name]) => name.startsWith('refs/heads/'))
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  const { page, perPage } = pageParams(req.query);
  const body = pageOf(branches, page, perPage).map(([name, oid]) => ({
    name: name.slice('refs/heads/'.length),
    commit: { sha: oid, url: `${req.origin}${API_ROOT}/repos/${repoFullName(req.store.login ?? '', repo.name)}/commits/${oid}` },
    protected: false,
  }));
  return { status: 200, body, headers: link(req, branches.length, page, perPage) };
});

route('GET', '/repos/:owner/:repo/branches/*branch', (req) => {
  const repo = repoFor(req.store, req.params.owner, req.params.repo);
  const oid = req.store.getRef(repo.id, `refs/heads/${req.params.branch}`);
  if (oid === undefined) throw notFound();
  return { status: 200, body: { name: req.params.branch, commit: { sha: oid, commit: { message: messageOf(req.store, oid) } }, protected: false } };
});

function messageOf(store: Store, oid: string): string {
  const commit = peelToCommit(store.objects, oid);
  return commit === undefined ? '' : commitOf(store.objects, commit).message;
}

route('GET', '/repos/:owner/:repo/commits', (req) => {
  const repo = repoFor(req.store, req.params.owner, req.params.repo);
  const sha = req.query.get('sha');
  const tip = sha === null ? defaultTip(req.store, repo) : resolveCommitish(req.store, repo, sha);
  if (tip === undefined) {
    if (sha === null) return { status: 200, body: [], headers: {} };
    throw notFound();
  }
  const all = logOrder(req.store.objects, tip, Number.MAX_SAFE_INTEGER);
  const { page, perPage } = pageParams(req.query);
  const login = req.store.login ?? '';
  const body = pageOf(all, page, perPage).map((oid) => commitJson(req.store.objects, oid, repo, req.origin, login));
  return { status: 200, body, headers: link(req, all.length, page, perPage) };
});

route('GET', '/repos/:owner/:repo/commits/:sha', (req) => {
  const repo = repoFor(req.store, req.params.owner, req.params.repo);
  const commit = resolveCommitish(req.store, repo, req.params.sha);
  if (commit === undefined) throw notFound();
  return { status: 200, body: commitJson(req.store.objects, commit, repo, req.origin, req.store.login ?? '') };
});

function refJson(store: Store, repo: RepoRecord, name: string, oid: string, origin: string): Record<string, unknown> {
  const full = repoFullName(store.login ?? '', repo.name);
  const object = store.objects.get(oid);
  return {
    ref: name,
    node_id: nodeId('Ref', stableRefId(name)),
    url: `${origin}${API_ROOT}/repos/${full}/git/${name}`,
    object: { type: object?.type ?? 'commit', sha: oid, url: `${origin}${API_ROOT}/repos/${full}/git/commits/${oid}` },
  };
}

function stableRefId(name: string): number {
  let hash = 7;
  for (let index = 0; index < name.length; index += 1) hash = (hash * 33 + name.charCodeAt(index)) % 2147483629;
  return hash;
}

route('POST', '/repos/:owner/:repo/git/refs', (req) => {
  const repo = repoFor(req.store, req.params.owner, req.params.repo);
  const body = asObject(req.body);
  const ref = requireString(body, 'ref');
  const sha = requireString(body, 'sha');
  if (!validRefName(ref)) throw validation('Reference name is invalid', [{ resource: 'Reference', code: 'invalid', field: 'ref' }]);
  if (!isOid(sha) || !req.store.objects.has(sha)) throw validation('Object does not exist', [{ resource: 'GitRef', code: 'invalid', field: 'sha' }]);
  if (req.store.getRef(repo.id, ref) !== undefined) throw validation('Reference already exists', [{ resource: 'Reference', code: 'already_exists', field: 'ref' }]);
  req.store.setRef(repo.id, ref, sha);
  req.store.touchRepo(repo, true);
  return { status: 201, body: refJson(req.store, repo, ref, sha, req.origin) };
});

route('GET', '/repos/:owner/:repo/git/refs/*ref', (req) => {
  const repo = repoFor(req.store, req.params.owner, req.params.repo);
  const prefix = `refs/${trimPath(req.params.ref)}`;
  const exact = req.store.getRef(repo.id, prefix);
  if (exact !== undefined) return { status: 200, body: refJson(req.store, repo, prefix, exact, req.origin) };
  const matching = [...req.store.refsOf(repo.id).entries()].filter(([name]) => name.startsWith(`${prefix}/`) || name === prefix);
  if (matching.length === 0) throw notFound();
  return { status: 200, body: matching.sort(([a], [b]) => (a < b ? -1 : 1)).map(([name, oid]) => refJson(req.store, repo, name, oid, req.origin)) };
});

route('PATCH', '/repos/:owner/:repo/git/refs/*ref', (req) => {
  const repo = repoFor(req.store, req.params.owner, req.params.repo);
  const ref = `refs/${trimPath(req.params.ref)}`;
  const body = asObject(req.body);
  const sha = requireString(body, 'sha');
  const current = req.store.getRef(repo.id, ref);
  if (current === undefined) throw notFound();
  if (!isOid(sha) || !req.store.objects.has(sha)) throw validation('Object does not exist', [{ resource: 'GitRef', code: 'invalid', field: 'sha' }]);
  const force = body.force === true;
  const currentCommit = peelToCommit(req.store.objects, current);
  const newCommit = peelToCommit(req.store.objects, sha);
  if (!force && (currentCommit === undefined || newCommit === undefined || !isAncestor(req.store.objects, currentCommit, newCommit))) {
    throw validation('Update is not a fast forward', [{ resource: 'GitRef', code: 'invalid', field: 'sha' }]);
  }
  req.store.setRef(repo.id, ref, sha);
  req.store.touchRepo(repo, true);
  return { status: 200, body: refJson(req.store, repo, ref, sha, req.origin) };
});

route('DELETE', '/repos/:owner/:repo/git/refs/*ref', (req) => {
  const repo = repoFor(req.store, req.params.owner, req.params.repo);
  const ref = `refs/${trimPath(req.params.ref)}`;
  if (req.store.getRef(repo.id, ref) === undefined) throw notFound();
  req.store.setRef(repo.id, ref, null);
  req.store.touchRepo(repo, true);
  return { status: 204 };
});

// ---------------------------------------------------------------- contents

route('GET', '/repos/:owner/:repo/contents/*path', (req) => {
  const repo = repoFor(req.store, req.params.owner, req.params.repo);
  const path = trimPath(req.params.path);
  const ref = req.query.get('ref');
  let tip: string | undefined;
  if (ref === null) tip = defaultTip(req.store, repo);
  else tip = resolveCommitish(req.store, repo, ref);
  if (tip === undefined) throw notFound();
  const root = commitOf(req.store.objects, tip).tree;
  const login = req.store.login ?? '';
  if (path === '') {
    return { status: 200, body: listDirectory(req, repo, root, '', login) };
  }
  const entry = lookupEntry(req.store.objects, root, path);
  if (entry === undefined) throw notFound();
  if (isTreeMode(entry.mode)) return { status: 200, body: listDirectory(req, repo, entry.oid, path, login) };
  const blob = requireObject(req.store.objects, entry.oid, 'blob');
  return { status: 200, body: fileJson(path, entry.mode, entry.oid, blob.data, req.origin, login, repo, ref ?? undefined) };
});

function listDirectory(req: RestRequest, repo: RepoRecord, treeOid: string, path: string, login: string): Record<string, unknown>[] {
  const entries = parseTree(requireObject(req.store.objects, treeOid, 'tree').data);
  return entries.map((entry) => {
    const size = isTreeMode(entry.mode) ? 0 : (req.store.objects.get(entry.oid)?.data.length ?? 0);
    return dirEntryJson(entry, path, req.origin, login, repo, size);
  });
}

route('PUT', '/repos/:owner/:repo/contents/*path', (req) => {
  const repo = repoFor(req.store, req.params.owner, req.params.repo);
  const body = asObject(req.body);
  const path = safeRepoPath(trimPath(req.params.path));
  const message = requireString(body, 'message');
  const content = decodeContent(body.content);
  const branch = optionalString(body, 'branch') ?? repo.default_branch;
  if (!validRefName(`refs/heads/${branch}`)) throw validation('branch is invalid', [{ resource: 'Reference', code: 'invalid', field: 'branch' }]);
  const branchExists = req.store.getRef(repo.id, `refs/heads/${branch}`) !== undefined;
  const emptyRepo = req.store.refsOf(repo.id).size === 0;
  if (!branchExists && !(emptyRepo && branch === repo.default_branch)) throw notFound();
  const sha = optionalString(body, 'sha');
  const result = commitFileChange(req.store, repo, {
    branch,
    path,
    content,
    message,
    expectSha: sha,
    author: asOptionalObject(body.author),
    committer: asOptionalObject(body.committer),
  });
  const login = req.store.login ?? '';
  const full = repoFullName(login, repo.name);
  const blob = result.blob ?? '';
  const commit = req.store.objects.get(result.commit);
  const view = commit ? commitOf(req.store.objects, result.commit) : null;
  return {
    status: result.created ? 201 : 200,
    body: {
      content: {
        name: path.split('/').pop(),
        path,
        sha: blob,
        size: content.length,
        encoding: 'base64',
        url: `${req.origin}${API_ROOT}/repos/${full}/contents/${path}`,
        html_url: `${req.origin}/${full}/blob/${branch}/${path}`,
        git_url: `${req.origin}${API_ROOT}/repos/${full}/git/blobs/${blob}`,
        download_url: `${req.origin}/${full}/raw/${branch}/${path}`,
        type: 'file',
        _links: { self: `${req.origin}${API_ROOT}/repos/${full}/contents/${path}` },
      },
      commit: {
        sha: result.commit,
        message,
        tree: { sha: view?.tree ?? '' },
        parents: (view?.parents ?? []).map((parent) => ({ sha: parent })),
        html_url: `${req.origin}/${full}/commit/${result.commit}`,
      },
    },
  };
});

route('DELETE', '/repos/:owner/:repo/contents/*path', (req) => {
  const repo = repoFor(req.store, req.params.owner, req.params.repo);
  const body = asObject(req.body);
  const path = safeRepoPath(trimPath(req.params.path));
  const message = requireString(body, 'message');
  const sha = requireString(body, 'sha');
  const branch = optionalString(body, 'branch') ?? repo.default_branch;
  const tipOid = req.store.getRef(repo.id, `refs/heads/${branch}`);
  if (tipOid === undefined) throw notFound();
  const tip = peelToCommit(req.store.objects, tipOid);
  const root = tip === undefined ? null : commitOf(req.store.objects, tip).tree;
  const entry = root === null ? undefined : lookupEntry(req.store.objects, root, path);
  if (entry === undefined || isTreeMode(entry.mode)) throw notFound();
  if (entry.oid !== sha) throw new HttpError(409, `${path} does not match ${sha}`);
  const result = commitFileChange(req.store, repo, { branch, path, content: null, message, expectSha: sha });
  const login = req.store.login ?? '';
  return {
    status: 200,
    body: {
      content: null,
      commit: { sha: result.commit, message, html_url: `${req.origin}/${repoFullName(login, repo.name)}/commit/${result.commit}` },
    },
  };
});

function asOptionalObject(value: unknown): Record<string, unknown> | undefined {
  if (value === undefined || value === null) return undefined;
  return asObject(value);
}

// ---------------------------------------------------------------- labels

route('GET', '/repos/:owner/:repo/labels', (req) => {
  const repo = repoFor(req.store, req.params.owner, req.params.repo);
  const labels = req.store.listLabels(repo.id);
  const { page, perPage } = pageParams(req.query);
  return { status: 200, body: pageOf(labels, page, perPage).map((label) => labelJsonFor(req.store, label, repo, req.origin)), headers: link(req, labels.length, page, perPage) };
});

route('POST', '/repos/:owner/:repo/labels', (req) => {
  const repo = repoFor(req.store, req.params.owner, req.params.repo);
  const body = asObject(req.body);
  const name = requireString(body, 'name');
  const colorRaw = optionalString(body, 'color') ?? 'ededed';
  if (!/^[0-9a-fA-F]{6}$/.test(colorRaw.replace(/^#/, ''))) throw validation('color is invalid', [{ resource: 'Label', code: 'invalid', field: 'color' }]);
  try {
    const label = req.store.createLabel(repo.id, { name, color: colorRaw.replace(/^#/, '').toLowerCase(), description: optionalString(body, 'description') ?? '' });
    return { status: 201, body: labelJsonFor(req.store, label, repo, req.origin) };
  } catch (err) {
    if (err instanceof StoreError) throw validation('already exists', [{ resource: 'Label', code: 'already_exists', field: 'name' }]);
    throw err;
  }
});

// ---------------------------------------------------------------- issues

function issueFilterList(repo: RepoRecord, store: Store, query: URLSearchParams, kind: 'issues' | 'pulls'): IssueRecord[] {
  const state = query.get('state') ?? 'open';
  const direction = query.get('direction') === 'asc' ? 'asc' : 'desc';
  const sort = query.get('sort') ?? 'created';
  let items = store.listIssueRecords(repo.id);
  if (kind === 'pulls') items = items.filter((item) => item.is_pull);
  if (state !== 'all') items = items.filter((item) => item.state === state);
  const keyOf = (item: IssueRecord): number => (sort === 'updated' ? Date.parse(item.updated_at) : item.number);
  items.sort((a, b) => {
    const diff = keyOf(a) - keyOf(b);
    if (diff !== 0) return direction === 'asc' ? diff : -diff;
    return direction === 'asc' ? a.number - b.number : b.number - a.number;
  });
  return items;
}

route('GET', '/repos/:owner/:repo/issues', (req) => {
  const repo = repoFor(req.store, req.params.owner, req.params.repo);
  const items = issueFilterList(repo, req.store, req.query, 'issues');
  const { page, perPage } = pageParams(req.query);
  return {
    status: 200,
    body: pageOf(items, page, perPage).map((issue) => issueJson(req.store, issue, repo, req.origin)),
    headers: link(req, items.length, page, perPage),
  };
});

route('POST', '/repos/:owner/:repo/issues', (req) => {
  const repo = repoFor(req.store, req.params.owner, req.params.repo);
  const body = asObject(req.body);
  const title = requireString(body, 'title');
  const issue = createIssueRecord(req.store, repo, { title, body: optionalString(body, 'body') ?? '', labels: labelNamesOf(body.labels) });
  return { status: 201, body: issueJson(req.store, issue, repo, req.origin) };
});

/** The label names a request carries (strings, or objects with a name). Existence is checked by the service. */
function labelNamesOf(value: unknown): string[] {
  if (value === undefined || value === null) return [];
  if (!Array.isArray(value)) throw validation('labels must be an array', [{ resource: 'Issue', code: 'invalid', field: 'labels' }]);
  return value.map((item) => {
    if (typeof item === 'string') return item;
    if (typeof item === 'object' && item !== null && typeof (item as { name?: unknown }).name === 'string') return (item as { name: string }).name;
    throw validation('labels are names', [{ resource: 'Issue', code: 'invalid', field: 'labels' }]);
  });
}

function issueOf(store: Store, repo: RepoRecord, numberText: string): IssueRecord {
  const number = Number(numberText);
  if (!Number.isInteger(number) || number < 1) throw notFound();
  const issue = store.issueByNumber(repo.id, number);
  if (issue === undefined) throw notFound();
  return issue;
}

route('GET', '/repos/:owner/:repo/issues/:number', (req) => {
  const repo = repoFor(req.store, req.params.owner, req.params.repo);
  return { status: 200, body: issueJson(req.store, issueOf(req.store, repo, req.params.number), repo, req.origin) };
});

route('PATCH', '/repos/:owner/:repo/issues/:number', (req) => {
  const repo = repoFor(req.store, req.params.owner, req.params.repo);
  const issue = issueOf(req.store, repo, req.params.number);
  const body = asObject(req.body);
  let next: IssueRecord = { ...issue };
  if (body.title !== undefined) next = { ...next, title: requireString(body, 'title') };
  if (body.body !== undefined) next = { ...next, body: optionalString(body, 'body') ?? '' };
  if (body.labels !== undefined) next = { ...next, labels: labelNamesFor(req.store, repo, labelNamesOf(body.labels)) };
  if (body.state !== undefined) {
    const state = body.state;
    if (state !== 'open' && state !== 'closed') throw validation('state must be open or closed', [{ resource: 'Issue', code: 'invalid', field: 'state' }]);
    if (state !== next.state) {
      next = {
        ...next,
        state,
        state_reason: state === 'closed' ? (typeof body.state_reason === 'string' ? body.state_reason : 'completed') : null,
        closed_at: state === 'closed' ? req.store.nowIso() : null,
      };
    }
  }
  next = { ...next, updated_at: req.store.nowIso() };
  const saved = req.store.saveIssue(next);
  return { status: 200, body: issueJson(req.store, saved, repo, req.origin) };
});

route('GET', '/repos/:owner/:repo/issues/:number/comments', (req) => {
  const repo = repoFor(req.store, req.params.owner, req.params.repo);
  const issue = issueOf(req.store, repo, req.params.number);
  const comments = req.store.listComments(issue.id);
  const { page, perPage } = pageParams(req.query);
  return {
    status: 200,
    body: pageOf(comments, page, perPage).map((comment) => commentJson(req.store, comment, issue, repo, req.origin)),
    headers: link(req, comments.length, page, perPage),
  };
});

route('POST', '/repos/:owner/:repo/issues/:number/comments', (req) => {
  const repo = repoFor(req.store, req.params.owner, req.params.repo);
  const issue = issueOf(req.store, repo, req.params.number);
  const body = asObject(req.body);
  const text = requireString(body, 'body');
  const comment = addCommentRecord(req.store, repo, issue, text);
  return { status: 201, body: commentJson(req.store, comment, issue, repo, req.origin) };
});

// ---------------------------------------------------------------- pull requests

function pullOf(store: Store, repo: RepoRecord, numberText: string): IssueRecord {
  const issue = issueOf(store, repo, numberText);
  if (!issue.is_pull || issue.pull === null) throw notFound();
  return issue;
}

route('GET', '/repos/:owner/:repo/pulls', (req) => {
  const repo = repoFor(req.store, req.params.owner, req.params.repo);
  const items = issueFilterList(repo, req.store, req.query, 'pulls');
  const { page, perPage } = pageParams(req.query);
  const login = req.store.login ?? '';
  void login;
  return {
    status: 200,
    body: pageOf(items, page, perPage).map((issue) => pullJson(req.store, issue, repo, req.origin, mergeableOf(req.store, repo, issue))),
    headers: link(req, items.length, page, perPage),
  };
});

route('POST', '/repos/:owner/:repo/pulls', (req) => {
  const repo = repoFor(req.store, req.params.owner, req.params.repo);
  const body = asObject(req.body);
  const title = requireString(body, 'title');
  const text = optionalString(body, 'body') ?? '';
  const headRaw = requireString(body, 'head');
  const head = headRaw.includes(':') ? headRaw.slice(headRaw.indexOf(':') + 1) : headRaw;
  const base = optionalString(body, 'base') ?? repo.default_branch;
  const issue = createPullRecord(req.store, repo, { title, body: text, head, base });
  return { status: 201, body: pullJson(req.store, issue, repo, req.origin, mergeableOf(req.store, repo, issue)) };
});

route('GET', '/repos/:owner/:repo/pulls/:number', (req) => {
  const repo = repoFor(req.store, req.params.owner, req.params.repo);
  const issue = pullOf(req.store, repo, req.params.number);
  return { status: 200, body: pullJson(req.store, issue, repo, req.origin, mergeableOf(req.store, repo, issue)) };
});

route('PATCH', '/repos/:owner/:repo/pulls/:number', (req) => {
  const repo = repoFor(req.store, req.params.owner, req.params.repo);
  const issue = pullOf(req.store, repo, req.params.number);
  const body = asObject(req.body);
  let next: IssueRecord = { ...issue, updated_at: req.store.nowIso() };
  if (body.title !== undefined) next = { ...next, title: requireString(body, 'title') };
  if (body.body !== undefined) next = { ...next, body: optionalString(body, 'body') ?? '' };
  if (body.state !== undefined && next.pull !== null && !next.pull.merged) {
    if (body.state !== 'open' && body.state !== 'closed') throw validation('state must be open or closed', [{ resource: 'PullRequest', code: 'invalid', field: 'state' }]);
    next = { ...next, state: body.state, closed_at: body.state === 'closed' ? req.store.nowIso() : null };
  }
  const saved = req.store.saveIssue(next);
  return { status: 200, body: pullJson(req.store, saved, repo, req.origin, mergeableOf(req.store, repo, saved)) };
});

route('GET', '/repos/:owner/:repo/pulls/:number/files', (req) => {
  const repo = repoFor(req.store, req.params.owner, req.params.repo);
  const issue = pullOf(req.store, repo, req.params.number);
  const changes = pullFileChanges(req.store, repo, issue);
  const { page, perPage } = pageParams(req.query, 30);
  const full = repoFullName(req.store.login ?? '', repo.name);
  const body = pageOf(changes, page, perPage).map((change) => ({
    sha: change.sha,
    filename: change.path,
    status: change.status,
    additions: change.additions,
    deletions: change.deletions,
    changes: change.additions + change.deletions,
    blob_url: `${req.origin}/${full}/blob/${change.sha}/${change.path}`,
    raw_url: `${req.origin}/${full}/raw/${change.sha}/${change.path}`,
    contents_url: `${req.origin}${API_ROOT}/repos/${full}/contents/${change.path}`,
  }));
  return { status: 200, body, headers: link(req, changes.length, page, perPage) };
});

/** The files a pull request changes: the diff from its merge-base to the head branch. */
function pullFileChanges(store: Store, repo: RepoRecord, issue: IssueRecord): ReturnType<typeof diffTrees> {
  const pull = issue.pull;
  if (pull === null) return [];
  const headTip = pull.merged ? pull.head_sha_at_merge : store.getRef(repo.id, `refs/heads/${pull.head_ref}`);
  const baseTip = pull.merged ? pull.base_sha_at_merge : store.getRef(repo.id, `refs/heads/${pull.base_ref}`);
  if (!headTip || !baseTip) return [];
  const head = peelToCommit(store.objects, headTip);
  const base = peelToCommit(store.objects, baseTip);
  if (head === undefined || base === undefined) return [];
  const ancestor = mergeBaseOne(store.objects, base, head);
  const fromTree = ancestor === undefined ? null : commitOf(store.objects, ancestor).tree;
  const from = fromTree === null ? new Map<string, { mode: string; oid: string }>() : flattenTree(store.objects, fromTree);
  const to = flattenTree(store.objects, commitOf(store.objects, head).tree);
  return diffTrees(store.objects, from, to);
}

route('GET', '/repos/:owner/:repo/pulls/:number/commits', (req) => {
  const repo = repoFor(req.store, req.params.owner, req.params.repo);
  const issue = pullOf(req.store, repo, req.params.number);
  const pull = issue.pull;
  const headTip = pull?.merged ? pull.head_sha_at_merge : req.store.getRef(repo.id, `refs/heads/${pull?.head_ref ?? ''}`);
  const baseTip = pull?.merged ? pull.base_sha_at_merge : req.store.getRef(repo.id, `refs/heads/${pull?.base_ref ?? ''}`);
  const head = headTip ? peelToCommit(req.store.objects, headTip) : undefined;
  const base = baseTip ? peelToCommit(req.store.objects, baseTip) : undefined;
  const excluded = base === undefined ? new Set<string>() : commitsReachable(req.store.objects, [base]);
  const list = head === undefined ? [] : logOrder(req.store.objects, head, Number.MAX_SAFE_INTEGER).filter((oid) => !excluded.has(oid)).reverse();
  const { page, perPage } = pageParams(req.query);
  const login = req.store.login ?? '';
  return {
    status: 200,
    body: pageOf(list, page, perPage).map((oid) => commitJson(req.store.objects, oid, repo, req.origin, login)),
    headers: link(req, list.length, page, perPage),
  };
});

route('PUT', '/repos/:owner/:repo/pulls/:number/merge', (req) => {
  const repo = repoFor(req.store, req.params.owner, req.params.repo);
  const issue = pullOf(req.store, repo, req.params.number);
  const body = req.body === null ? {} : asObject(req.body);
  const method = optionalString(body, 'merge_method') ?? 'merge';
  if (method !== 'merge' && method !== 'squash') throw validation('merge_method must be merge or squash', [{ resource: 'PullRequest', code: 'invalid', field: 'merge_method' }]);
  const sha = mergePullRecord(req.store, repo, issue, {
    method,
    title: optionalString(body, 'commit_title'),
    body: optionalString(body, 'commit_message'),
  });
  return { status: 200, body: { sha, merged: true, message: 'Pull Request successfully merged' } };
});

// ---------------------------------------------------------------- dispatch

/** Route one /api/v3 request. Throws HttpError for every reply that is not a success. */
export function handleRest(
  store: Store,
  token: string,
  req: IncomingMessage,
  res: ServerResponse,
  path: string,
  query: URLSearchParams,
  origin: string,
  rawBody: Buffer,
): void {
  const presented = bearerToken(req);
  if (presented === null || !tokenMatches(presented, token)) {
    sendJson(res, 401, { message: 'Requires authentication', documentation_url: 'https://docs.github.com/rest' });
    return;
  }
  const relative = path.slice(API_ROOT.length).replace(/\/+$/, '');
  const segments = relative === '' ? [] : relative.slice(1).split('/');
  const method = (req.method ?? 'GET').toUpperCase();

  let body: unknown = null;
  if (method !== 'GET' && method !== 'HEAD') body = parseJsonBody(rawBody);

  for (const candidate of routes) {
    const params = matchPattern(candidate.pattern, segments);
    if (params === null) continue;
    if (candidate.method !== method) continue;
    const reply = candidate.handler({ method, path, query, origin, body, params, store, rawHeaders: req.headers });
    if (reply.status === 204) {
      res.writeHead(204, { 'x-github-request-id': requestIdFor(), ...(reply.headers ?? {}) });
      res.end();
      return;
    }
    sendJson(res, reply.status, reply.body ?? null, reply.headers ?? {});
    return;
  }
  throw notFound();
}

