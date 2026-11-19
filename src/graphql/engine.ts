// The GraphQL schema, validator and executor. The schema is data (types, fields, arguments, enums, inputs)
// with a resolver per field; the executor walks a parsed operation against it. Introspection (__type,
// __schema and the __Type/__Field/__InputValue/__EnumValue types) is served from the same schema, so the
// probes gh sends describe exactly what the executor serves.
//
// Results follow the GraphQL response shape: `data` for what resolved, `errors` for what did not. An
// unknown field is a validation error (no data, an errors array naming it); a resolver that throws puts an
// error at its path and nulls that field.

import { HttpError } from '../http/util.ts';
import { repoFor } from '../api/rest.ts';
import { addCommentRecord, createIssueRecord, createPullRecord, mergeableOf, mergePullRecord, setIssueState } from '../api/service.ts';
import { diffTrees, nodeId, repoFullName } from '../api/shapes.ts';
import { commitOf, flattenTree, mergeBaseOne, peelToCommit } from '../git/ops.ts';
import type { CommentRecord, IssueRecord, RepoRecord, Store } from '../store/store.ts';
import { GraphQLSyntaxError, parseDocument, type Document, type FieldSelection, type Operation, type Selection, type TypeNode, type Value } from './parse.ts';

export interface GqlContext {
  readonly store: Store;
  readonly origin: string;
}

type Resolver = (parent: any, args: Record<string, any>, ctx: GqlContext) => unknown;

interface FieldDef {
  readonly type: string;
  readonly args: Record<string, string>;
  readonly resolve: Resolver;
}

interface TypeDef {
  readonly kind: 'OBJECT' | 'INTERFACE' | 'ENUM' | 'INPUT_OBJECT' | 'SCALAR';
  readonly name: string;
  readonly fields?: Record<string, FieldDef>;
  readonly values?: string[];
  readonly inputFields?: Record<string, string>;
  readonly interfaces?: string[];
  readonly possibleTypes?: string[];
}

const types = new Map<string, TypeDef>();

function def(type: TypeDef): void {
  types.set(type.name, type);
}

const SCALARS = ['String', 'Int', 'Float', 'Boolean', 'ID', 'DateTime', 'URI'];
for (const name of SCALARS) def({ kind: 'SCALAR', name });

// ---------------------------------------------------------------- type references

interface Ref {
  readonly wrap: 'NON_NULL' | 'LIST' | null;
  readonly name?: string;
  readonly of?: Ref;
}

function parseRef(text: string): Ref {
  let pos = 0;
  const read = (): Ref => {
    let inner: Ref;
    if (text[pos] === '[') {
      pos += 1;
      inner = { wrap: 'LIST', of: read() };
      if (text[pos] !== ']') throw new Error(`bad type ${text}`);
      pos += 1;
    } else {
      const match = /^[A-Za-z_][A-Za-z0-9_]*/.exec(text.slice(pos));
      if (!match) throw new Error(`bad type ${text}`);
      pos += match[0].length;
      inner = { wrap: null, name: match[0] };
    }
    if (text[pos] === '!') {
      pos += 1;
      return { wrap: 'NON_NULL', of: inner };
    }
    return inner;
  };
  return read();
}

function namedOf(ref: Ref): string {
  let current = ref;
  while (current.name === undefined && current.of) current = current.of;
  return current.name ?? '';
}

function typeNodeToRef(node: TypeNode): string {
  const base = node.list !== undefined ? `[${typeNodeToRef(node.list)}]` : (node.name ?? '');
  return node.nonNull ? `${base}!` : base;
}

// ---------------------------------------------------------------- domain values

interface RepoValue {
  readonly __typename: 'Repository';
  readonly repo: RepoRecord;
}

interface IssueValue {
  readonly __typename: 'Issue' | 'PullRequest';
  readonly issue: IssueRecord;
  readonly repo: RepoRecord;
}

interface CommentValue {
  readonly __typename: 'IssueComment';
  readonly comment: CommentRecord;
  readonly issue: IssueRecord;
  readonly repo: RepoRecord;
}

function repoValue(repo: RepoRecord): RepoValue {
  return { __typename: 'Repository', repo };
}

function issueValue(issue: IssueRecord, repo: RepoRecord): IssueValue {
  return { __typename: issue.is_pull ? 'PullRequest' : 'Issue', issue, repo };
}

function userValue(login: string): { __typename: 'User'; login: string } {
  return { __typename: 'User', login };
}

function issueGlobalId(issue: IssueRecord): string {
  return nodeId(issue.is_pull ? 'PullRequest' : 'Issue', issue.id);
}

/** Decode a node id produced by nodeId(): the type name and the record id. */
export function decodeNodeId(id: string): { type: string; id: number } | null {
  let text: string;
  try {
    text = Buffer.from(id, 'base64').toString('utf8');
  } catch {
    return null;
  }
  const match = /^0(\d+):(.*)$/.exec(text);
  if (!match) return null;
  const length = Number(match[1]);
  const rest = match[2];
  const type = rest.slice(0, length);
  const numeric = Number(rest.slice(length));
  if (!Number.isInteger(numeric) || numeric < 1) return null;
  return { type, id: numeric };
}

function resolveNode(store: Store, id: string): unknown {
  const decoded = decodeNodeId(id);
  if (decoded === null) return null;
  if (decoded.type === 'Repository') {
    const repo = store.repoById(decoded.id);
    return repo ? repoValue(repo) : null;
  }
  if (decoded.type === 'Issue' || decoded.type === 'PullRequest') {
    const issue = store.issueById(decoded.id);
    const repo = issue ? store.repoById(issue.repo_id) : undefined;
    return issue && repo ? issueValue(issue, repo) : null;
  }
  if (decoded.type === 'IssueComment') {
    const comment = store.commentById(decoded.id);
    const issue = comment ? store.issueById(comment.issue_id) : undefined;
    const repo = issue ? store.repoById(issue.repo_id) : undefined;
    return comment && issue && repo ? { __typename: 'IssueComment', comment, issue, repo } : null;
  }
  return null;
}

// ---------------------------------------------------------------- connections

function encodeCursor(offset: number): string {
  return Buffer.from(`cursor:${offset}`, 'utf8').toString('base64');
}

function decodeCursor(cursor: string): number {
  const text = Buffer.from(cursor, 'base64').toString('utf8');
  const match = /^cursor:(\d+)$/.exec(text);
  if (!match) throw new HttpError(400, "Argument 'after' is invalid");
  return Number(match[1]);
}

function connection<T>(items: readonly T[], first: number | undefined, after: string | undefined, wrap: (item: T) => unknown, typename: string): Record<string, unknown> {
  const start = after === undefined || after === null ? 0 : decodeCursor(after);
  const size = first === undefined || first === null ? items.length : Math.max(0, first);
  const slice = items.slice(start, start + size);
  const end = start + slice.length;
  return {
    __typename: typename,
    totalCount: items.length,
    nodes: slice.map(wrap),
    pageInfo: {
      hasNextPage: end < items.length,
      hasPreviousPage: start > 0,
      startCursor: slice.length > 0 ? encodeCursor(start) : null,
      endCursor: slice.length > 0 ? encodeCursor(end) : null,
    },
  };
}

function orderIssues(items: IssueRecord[], orderBy: { field?: string; direction?: string } | undefined): IssueRecord[] {
  const field = orderBy?.field ?? 'CREATED_AT';
  const direction = orderBy?.direction === 'DESC' ? -1 : 1;
  const key = (issue: IssueRecord): number => {
    if (field === 'UPDATED_AT') return Date.parse(issue.updated_at);
    if (field === 'COMMENTS') return 0;
    return issue.number;
  };
  return [...items].sort((a, b) => {
    const diff = key(a) - key(b);
    if (diff !== 0) return diff * direction;
    return (a.number - b.number) * direction;
  });
}

function pullStateOf(issue: IssueRecord): 'OPEN' | 'CLOSED' | 'MERGED' {
  if (issue.pull?.merged) return 'MERGED';
  return issue.state === 'open' ? 'OPEN' : 'CLOSED';
}

// ---------------------------------------------------------------- the schema

const field = (type: string, resolve: Resolver, args: Record<string, string> = {}): FieldDef => ({ type, args, resolve });

def({
  kind: 'OBJECT',
  name: 'Query',
  fields: {
    viewer: field('User', (_p, _a, ctx) => (ctx.store.login === null ? null : userValue(ctx.store.login))),
    repository: field(
      'Repository',
      (_p, args, ctx) => {
        try {
          return repoValue(repoFor(ctx.store, String(args.owner), String(args.name)));
        } catch (err) {
          if (err instanceof HttpError && err.status === 404) return null;
          throw err;
        }
      },
      { owner: 'String!', name: 'String!' },
    ),
    node: field('Node', (_p, args, ctx) => resolveNode(ctx.store, String(args.id)), { id: 'ID!' }),
    __type: field('__Type', (_p, args) => {
      const named = types.get(String(args.name));
      return named ? { __typename: '__Type', ref: { wrap: null, name: named.name } } : null;
    }, { name: 'String!' }),
    __schema: field('__Schema', () => ({ __typename: '__Schema' })),
  },
});

def({
  kind: 'OBJECT',
  name: 'Mutation',
  fields: {
    createIssue: field('CreateIssuePayload', (_p, args, ctx) => {
      const input = args.input as Record<string, unknown>;
      const repo = repoOfNode(ctx.store, input.repositoryId);
      const issue = createIssueRecord(ctx.store, repo, {
        title: requireInput(input, 'title'),
        body: typeof input.body === 'string' ? input.body : '',
        labels: [],
      });
      return { __typename: 'CreateIssuePayload', issue: issueValue(issue, repo) };
    }, { input: 'CreateIssueInput!' }),
    closeIssue: field('CloseIssuePayload', (_p, args, ctx) => {
      const input = args.input as Record<string, unknown>;
      const target = issueOfNode(ctx.store, input.issueId);
      const closed = setIssueState(ctx.store, target.issue, 'closed');
      return { __typename: 'CloseIssuePayload', issue: issueValue(closed, target.repo) };
    }, { input: 'CloseIssueInput!' }),
    createPullRequest: field('CreatePullRequestPayload', (_p, args, ctx) => {
      const input = args.input as Record<string, unknown>;
      const repo = repoOfNode(ctx.store, input.repositoryId);
      const issue = createPullRecord(ctx.store, repo, {
        title: requireInput(input, 'title'),
        body: typeof input.body === 'string' ? input.body : '',
        head: requireInput(input, 'headRefName'),
        base: requireInput(input, 'baseRefName'),
      });
      return { __typename: 'CreatePullRequestPayload', pullRequest: issueValue(issue, repo) };
    }, { input: 'CreatePullRequestInput!' }),
    mergePullRequest: field('MergePullRequestPayload', (_p, args, ctx) => {
      const input = args.input as Record<string, unknown>;
      const target = issueOfNode(ctx.store, input.pullRequestId);
      if (!target.issue.is_pull) throw new HttpError(404, 'Could not resolve to a PullRequest with the global id');
      const method = input.mergeMethod === 'MERGE' ? 'merge' : 'squash';
      if (input.mergeMethod === 'REBASE') throw new HttpError(422, 'rebase merges are not supported');
      mergePullRecord(ctx.store, target.repo, target.issue, { method });
      const merged = ctx.store.issueById(target.issue.id) ?? target.issue;
      return { __typename: 'MergePullRequestPayload', pullRequest: issueValue(merged, target.repo) };
    }, { input: 'MergePullRequestInput!' }),
    addComment: field('AddCommentPayload', (_p, args, ctx) => {
      const input = args.input as Record<string, unknown>;
      const target = issueOfNode(ctx.store, input.subjectId);
      const comment = addCommentRecord(ctx.store, target.repo, target.issue, requireInput(input, 'body'));
      return {
        __typename: 'AddCommentPayload',
        commentEdge: { __typename: 'IssueCommentEdge', node: { __typename: 'IssueComment', comment, issue: target.issue, repo: target.repo } },
      };
    }, { input: 'AddCommentInput!' }),
  },
});

function requireInput(input: Record<string, unknown>, field: string): string {
  const value = input[field];
  if (typeof value !== 'string' || value === '') throw new HttpError(422, `${field} is required`);
  return value;
}

function repoOfNode(store: Store, id: unknown): RepoRecord {
  const decoded = typeof id === 'string' ? decodeNodeId(id) : null;
  const repo = decoded?.type === 'Repository' ? store.repoById(decoded.id) : undefined;
  if (repo === undefined) throw new HttpError(404, 'Could not resolve to a node with the global id of ' + String(id));
  return repo;
}

function issueOfNode(store: Store, id: unknown): { issue: IssueRecord; repo: RepoRecord } {
  const decoded = typeof id === 'string' ? decodeNodeId(id) : null;
  const issue = decoded && (decoded.type === 'Issue' || decoded.type === 'PullRequest') ? store.issueById(decoded.id) : undefined;
  const repo = issue ? store.repoById(issue.repo_id) : undefined;
  if (issue === undefined || repo === undefined) throw new HttpError(404, 'Could not resolve to a node with the global id of ' + String(id));
  return { issue, repo };
}

def({
  kind: 'INTERFACE',
  name: 'Node',
  fields: { id: field('ID!', (parent) => nodeIdOf(parent)) },
  possibleTypes: ['Repository', 'Issue', 'PullRequest', 'IssueComment', 'User'],
});

function nodeIdOf(parent: any): string {
  if (parent.__typename === 'Repository') return nodeId('Repository', parent.repo.id);
  if (parent.__typename === 'IssueComment') return nodeId('IssueComment', parent.comment.id);
  if (parent.__typename === 'User') return nodeId('User', stableId(parent.login));
  return issueGlobalId(parent.issue);
}

function stableId(login: string): number {
  let hash = 0;
  for (let index = 0; index < login.length; index += 1) hash = (hash * 31 + login.charCodeAt(index)) % 2147483647;
  return hash + 1;
}

def({
  kind: 'OBJECT',
  name: 'User',
  interfaces: ['Node'],
  fields: {
    id: field('ID!', (parent) => nodeIdOf(parent)),
    login: field('String!', (parent) => parent.login),
  },
});

def({
  kind: 'OBJECT',
  name: 'Repository',
  interfaces: ['Node'],
  fields: {
    id: field('ID!', (parent) => nodeIdOf(parent)),
    databaseId: field('Int', (parent: RepoValue) => parent.repo.id),
    name: field('String!', (parent: RepoValue) => parent.repo.name),
    nameWithOwner: field('String!', (parent: RepoValue, _a, ctx) => repoFullName(ctx.store.login ?? '', parent.repo.name)),
    description: field('String', (parent: RepoValue) => parent.repo.description),
    isPrivate: field('Boolean!', (parent: RepoValue) => parent.repo.private),
    url: field('URI!', (parent: RepoValue, _a, ctx) => `${ctx.origin}/${repoFullName(ctx.store.login ?? '', parent.repo.name)}`),
    owner: field('User!', (_parent, _a, ctx) => userValue(ctx.store.login ?? '')),
    defaultBranchRef: field('Ref', (parent: RepoValue, _a, ctx) => {
      const oid = ctx.store.getRef(parent.repo.id, `refs/heads/${parent.repo.default_branch}`);
      return oid === undefined ? null : { __typename: 'Ref', name: parent.repo.default_branch, oid };
    }),
    viewerPermission: field('RepositoryPermission', () => 'ADMIN'),
    hasIssuesEnabled: field('Boolean!', () => true),
    issue: field(
      'Issue',
      (parent: RepoValue, args, ctx) => {
        const issue = ctx.store.issueByNumber(parent.repo.id, Number(args.number));
        return issue && !issue.is_pull ? issueValue(issue, parent.repo) : null;
      },
      { number: 'Int!' },
    ),
    issues: field(
      'IssueConnection',
      (parent: RepoValue, args, ctx) => {
        const states: string[] | undefined = Array.isArray(args.states) ? args.states : undefined;
        let items = ctx.store.listIssueRecords(parent.repo.id).filter((issue) => !issue.is_pull);
        if (states !== undefined) items = items.filter((issue) => states.includes(issue.state === 'open' ? 'OPEN' : 'CLOSED'));
        items = orderIssues(items, args.orderBy);
        return connection(items, args.first, args.after, (issue: IssueRecord) => issueValue(issue, parent.repo), 'IssueConnection');
      },
      { first: 'Int', after: 'String', states: '[IssueState!]', orderBy: 'IssueOrder' },
    ),
    pullRequests: field(
      'PullRequestConnection',
      (parent: RepoValue, args, ctx) => {
        const states: string[] | undefined = Array.isArray(args.states) ? args.states : undefined;
        let items = ctx.store.listIssueRecords(parent.repo.id).filter((issue) => issue.is_pull);
        if (states !== undefined) items = items.filter((issue) => states.includes(pullStateOf(issue)));
        items = orderIssues(items, args.orderBy);
        return connection(items, args.first, args.after, (issue: IssueRecord) => issueValue(issue, parent.repo), 'PullRequestConnection');
      },
      { first: 'Int', after: 'String', states: '[PullRequestState!]', orderBy: 'IssueOrder' },
    ),
    pullRequest: field(
      'PullRequest',
      (parent: RepoValue, args, ctx) => {
        const issue = ctx.store.issueByNumber(parent.repo.id, Number(args.number));
        return issue && issue.is_pull ? issueValue(issue, parent.repo) : null;
      },
      { number: 'Int!' },
    ),
  },
});

def({ kind: 'OBJECT', name: 'Ref', fields: { name: field('String!', (p) => p.name), target: field('String', (p) => p.oid) } });

def({
  kind: 'OBJECT',
  name: 'Issue',
  interfaces: ['Node'],
  fields: {
    id: field('ID!', (parent) => nodeIdOf(parent)),
    number: field('Int!', (parent: IssueValue) => parent.issue.number),
    title: field('String!', (parent: IssueValue) => parent.issue.title),
    body: field('String!', (parent: IssueValue) => parent.issue.body),
    state: field('IssueState!', (parent: IssueValue) => (parent.issue.state === 'open' ? 'OPEN' : 'CLOSED')),
    url: field('URI!', (parent: IssueValue, _a, ctx) => `${ctx.origin}/${repoFullName(ctx.store.login ?? '', parent.repo.name)}/issues/${parent.issue.number}`),
    createdAt: field('DateTime!', (parent: IssueValue) => parent.issue.created_at),
    updatedAt: field('DateTime!', (parent: IssueValue) => parent.issue.updated_at),
    closedAt: field('DateTime', (parent: IssueValue) => parent.issue.closed_at),
    author: field('User', (parent: IssueValue) => userValue(parent.issue.author)),
  },
});

def({
  kind: 'OBJECT',
  name: 'PullRequest',
  interfaces: ['Node'],
  fields: {
    id: field('ID!', (parent) => nodeIdOf(parent)),
    number: field('Int!', (parent: IssueValue) => parent.issue.number),
    title: field('String!', (parent: IssueValue) => parent.issue.title),
    body: field('String!', (parent: IssueValue) => parent.issue.body),
    state: field('PullRequestState!', (parent: IssueValue) => pullStateOf(parent.issue)),
    merged: field('Boolean!', (parent: IssueValue) => parent.issue.pull?.merged === true),
    mergedAt: field('DateTime', (parent: IssueValue) => parent.issue.pull?.merged_at ?? null),
    headRefName: field('String!', (parent: IssueValue) => parent.issue.pull?.head_ref ?? ''),
    baseRefName: field('String!', (parent: IssueValue) => parent.issue.pull?.base_ref ?? ''),
    headRefOid: field('String', (parent: IssueValue, _a, ctx) => ctx.store.getRef(parent.repo.id, `refs/heads/${parent.issue.pull?.head_ref ?? ''}`) ?? null),
    baseRefOid: field('String', (parent: IssueValue, _a, ctx) => ctx.store.getRef(parent.repo.id, `refs/heads/${parent.issue.pull?.base_ref ?? ''}`) ?? null),
    mergeable: field('MergeableState!', (parent: IssueValue, _a, ctx) => {
      const value = mergeableOf(ctx.store, parent.repo, parent.issue);
      return value === null ? 'UNKNOWN' : value ? 'MERGEABLE' : 'CONFLICTING';
    }),
    url: field('URI!', (parent: IssueValue, _a, ctx) => `${ctx.origin}/${repoFullName(ctx.store.login ?? '', parent.repo.name)}/pull/${parent.issue.number}`),
    createdAt: field('DateTime!', (parent: IssueValue) => parent.issue.created_at),
    author: field('User', (parent: IssueValue) => userValue(parent.issue.author)),
    files: field(
      'PullRequestChangedFileConnection',
      (parent: IssueValue, args, ctx) => {
        const files = changedFiles(ctx, parent);
        return connection(files, args.first, args.after, (file: { path: string; additions: number; deletions: number; status: string }) => ({ __typename: 'PullRequestChangedFile', ...file }), 'PullRequestChangedFileConnection');
      },
      { first: 'Int', after: 'String' },
    ),
  },
});

function changedFiles(ctx: GqlContext, parent: IssueValue): Array<{ path: string; additions: number; deletions: number; status: string }> {
  const pull = parent.issue.pull;
  if (pull === null) return [];
  const headTip = pull.merged ? pull.head_sha_at_merge : ctx.store.getRef(parent.repo.id, `refs/heads/${pull.head_ref}`);
  const baseTip = pull.merged ? pull.base_sha_at_merge : ctx.store.getRef(parent.repo.id, `refs/heads/${pull.base_ref}`);
  if (!headTip || !baseTip) return [];
  const head = peelToCommit(ctx.store.objects, headTip);
  const base = peelToCommit(ctx.store.objects, baseTip);
  if (head === undefined || base === undefined) return [];
  const ancestor = mergeBaseOne(ctx.store.objects, base, head);
  const from = ancestor === undefined ? new Map() : flattenTree(ctx.store.objects, commitOf(ctx.store.objects, ancestor).tree);
  const to = flattenTree(ctx.store.objects, commitOf(ctx.store.objects, head).tree);
  return diffTrees(ctx.store.objects, from, to).map((change) => ({ path: change.path, additions: change.additions, deletions: change.deletions, status: change.status }));
}

def({
  kind: 'OBJECT',
  name: 'IssueComment',
  interfaces: ['Node'],
  fields: {
    id: field('ID!', (parent) => nodeIdOf(parent)),
    body: field('String!', (parent: CommentValue) => parent.comment.body),
    createdAt: field('DateTime!', (parent: CommentValue) => parent.comment.created_at),
    author: field('User', (parent: CommentValue) => userValue(parent.comment.author)),
  },
});

def({ kind: 'OBJECT', name: 'IssueCommentEdge', fields: { node: field('IssueComment', (p) => p.node), cursor: field('String', () => null) } });
def({ kind: 'OBJECT', name: 'PageInfo', fields: {
  hasNextPage: field('Boolean!', (p) => p.hasNextPage),
  hasPreviousPage: field('Boolean!', (p) => p.hasPreviousPage),
  startCursor: field('String', (p) => p.startCursor),
  endCursor: field('String', (p) => p.endCursor),
} });
def({ kind: 'OBJECT', name: 'IssueConnection', fields: {
  totalCount: field('Int!', (p) => p.totalCount),
  nodes: field('[Issue]', (p) => p.nodes),
  pageInfo: field('PageInfo!', (p) => p.pageInfo),
} });
def({ kind: 'OBJECT', name: 'PullRequestConnection', fields: {
  totalCount: field('Int!', (p) => p.totalCount),
  nodes: field('[PullRequest]', (p) => p.nodes),
  pageInfo: field('PageInfo!', (p) => p.pageInfo),
} });
def({ kind: 'OBJECT', name: 'PullRequestChangedFileConnection', fields: {
  totalCount: field('Int!', (p) => p.totalCount),
  nodes: field('[PullRequestChangedFile]', (p) => p.nodes),
  pageInfo: field('PageInfo!', (p) => p.pageInfo),
} });
def({ kind: 'OBJECT', name: 'PullRequestChangedFile', fields: {
  path: field('String!', (p) => p.path),
  additions: field('Int!', (p) => p.additions),
  deletions: field('Int!', (p) => p.deletions),
  changeType: field('String', (p) => p.status),
} });
def({ kind: 'OBJECT', name: 'CreateIssuePayload', fields: { issue: field('Issue', (p) => p.issue) } });
def({ kind: 'OBJECT', name: 'CloseIssuePayload', fields: { issue: field('Issue', (p) => p.issue) } });
def({ kind: 'OBJECT', name: 'CreatePullRequestPayload', fields: { pullRequest: field('PullRequest', (p) => p.pullRequest) } });
def({ kind: 'OBJECT', name: 'MergePullRequestPayload', fields: { pullRequest: field('PullRequest', (p) => p.pullRequest) } });
def({ kind: 'OBJECT', name: 'AddCommentPayload', fields: { commentEdge: field('IssueCommentEdge', (p) => p.commentEdge) } });

def({ kind: 'ENUM', name: 'IssueState', values: ['OPEN', 'CLOSED'] });
def({ kind: 'ENUM', name: 'PullRequestState', values: ['OPEN', 'CLOSED', 'MERGED'] });
def({ kind: 'ENUM', name: 'MergeableState', values: ['MERGEABLE', 'CONFLICTING', 'UNKNOWN'] });
def({ kind: 'ENUM', name: 'PullRequestMergeMethod', values: ['MERGE', 'SQUASH', 'REBASE'] });
def({ kind: 'ENUM', name: 'RepositoryPermission', values: ['ADMIN', 'MAINTAIN', 'WRITE', 'TRIAGE', 'READ'] });
def({ kind: 'ENUM', name: 'SearchType', values: ['ISSUE', 'REPOSITORY', 'USER', 'CODE', 'COMMIT', 'DISCUSSION'] });
def({ kind: 'ENUM', name: 'IssueOrderField', values: ['CREATED_AT', 'UPDATED_AT', 'COMMENTS'] });
def({ kind: 'ENUM', name: 'OrderDirection', values: ['ASC', 'DESC'] });
def({ kind: 'ENUM', name: '__TypeKind', values: ['SCALAR', 'OBJECT', 'INTERFACE', 'UNION', 'ENUM', 'INPUT_OBJECT', 'LIST', 'NON_NULL'] });

def({ kind: 'INPUT_OBJECT', name: 'IssueOrder', inputFields: { field: 'IssueOrderField!', direction: 'OrderDirection!' } });
def({ kind: 'INPUT_OBJECT', name: 'CreateIssueInput', inputFields: { repositoryId: 'ID!', title: 'String!', body: 'String' } });
def({ kind: 'INPUT_OBJECT', name: 'CloseIssueInput', inputFields: { issueId: 'ID!' } });
def({ kind: 'INPUT_OBJECT', name: 'CreatePullRequestInput', inputFields: { repositoryId: 'ID!', baseRefName: 'String!', headRefName: 'String!', title: 'String!', body: 'String' } });
def({ kind: 'INPUT_OBJECT', name: 'MergePullRequestInput', inputFields: { pullRequestId: 'ID!', mergeMethod: 'PullRequestMergeMethod' } });
def({ kind: 'INPUT_OBJECT', name: 'AddCommentInput', inputFields: { subjectId: 'ID!', body: 'String!' } });

// Introspection types. Their values are {__typename, ref} for types and fields built on demand.
function typeValueOf(ref: Ref): { __typename: '__Type'; ref: Ref } {
  return { __typename: '__Type', ref };
}

def({ kind: 'OBJECT', name: '__Schema', fields: {
  queryType: field('__Type!', () => typeValueOf({ wrap: null, name: 'Query' })),
  mutationType: field('__Type', () => typeValueOf({ wrap: null, name: 'Mutation' })),
  subscriptionType: field('__Type', () => null),
  types: field('[__Type!]!', () => [...types.keys()].map((name) => typeValueOf({ wrap: null, name }))),
  directives: field('[__Type!]!', () => []),
} });

def({ kind: 'OBJECT', name: '__Type', fields: {
  kind: field('__TypeKind!', (value: { ref: Ref }) => kindOf(value.ref)),
  name: field('String', (value: { ref: Ref }) => (value.ref.wrap === null ? value.ref.name ?? null : null)),
  description: field('String', () => null),
  ofType: field('__Type', (value: { ref: Ref }) => (value.ref.of ? typeValueOf(value.ref.of) : null)),
  fields: field('[__Field!]', (value: { ref: Ref }, args) => {
    const named = types.get(namedOf(value.ref));
    if (value.ref.wrap !== null || !named || (named.kind !== 'OBJECT' && named.kind !== 'INTERFACE')) return null;
    return Object.entries(named.fields ?? {}).map(([name, spec]) => ({ __typename: '__Field', name, spec }));
  }, { includeDeprecated: 'Boolean' }),
  enumValues: field('[__EnumValue!]', (value: { ref: Ref }) => {
    const named = types.get(namedOf(value.ref));
    if (value.ref.wrap !== null || !named || named.kind !== 'ENUM') return null;
    return (named.values ?? []).map((name) => ({ __typename: '__EnumValue', name }));
  }, { includeDeprecated: 'Boolean' }),
  inputFields: field('[__InputValue!]', (value: { ref: Ref }) => {
    const named = types.get(namedOf(value.ref));
    if (value.ref.wrap !== null || !named || named.kind !== 'INPUT_OBJECT') return null;
    return Object.entries(named.inputFields ?? {}).map(([name, type]) => ({ __typename: '__InputValue', name, type }));
  }),
  interfaces: field('[__Type!]', (value: { ref: Ref }) => {
    const named = types.get(namedOf(value.ref));
    if (value.ref.wrap !== null || !named || named.kind !== 'OBJECT') return null;
    return (named.interfaces ?? []).map((name) => typeValueOf({ wrap: null, name }));
  }),
  possibleTypes: field('[__Type!]', (value: { ref: Ref }) => {
    const named = types.get(namedOf(value.ref));
    if (value.ref.wrap !== null || !named || named.kind !== 'INTERFACE') return null;
    return (named.possibleTypes ?? []).map((name) => typeValueOf({ wrap: null, name }));
  }),
} });

def({ kind: 'OBJECT', name: '__Field', fields: {
  name: field('String!', (p) => p.name),
  description: field('String', () => null),
  args: field('[__InputValue!]!', () => []),
  type: field('__Type!', (p: { spec: FieldDef }) => typeValueOf(parseRef(p.spec.type))),
  isDeprecated: field('Boolean!', () => false),
  deprecationReason: field('String', () => null),
} });

def({ kind: 'OBJECT', name: '__InputValue', fields: {
  name: field('String!', (p) => p.name),
  description: field('String', () => null),
  type: field('__Type!', (p: { type: string }) => typeValueOf(parseRef(p.type))),
  defaultValue: field('String', () => null),
} });

def({ kind: 'OBJECT', name: '__EnumValue', fields: {
  name: field('String!', (p) => p.name),
  description: field('String', () => null),
  isDeprecated: field('Boolean!', () => false),
  deprecationReason: field('String', () => null),
} });

function kindOf(ref: Ref): string {
  if (ref.wrap === 'NON_NULL') return 'NON_NULL';
  if (ref.wrap === 'LIST') return 'LIST';
  const named = types.get(ref.name ?? '');
  if (!named) return 'SCALAR';
  return named.kind;
}

// ---------------------------------------------------------------- validation

class ValidationFailure extends Error {}

function typeOfName(name: string): TypeDef | undefined {
  return types.get(name);
}

/** Check every field of a selection against the type it applies to. Returns the messages found. */
function validateSelection(selection: Selection[], typeName: string, doc: Document, errors: string[], depth = 0): void {
  if (depth > 32) throw new ValidationFailure('the selection nests too deeply');
  const type = typeOfName(typeName);
  for (const item of selection) {
    if (item.kind === 'Field') {
      if (item.name === '__typename') continue;
      const spec = type?.fields?.[item.name];
      if (spec === undefined) {
        errors.push(`Cannot query field "${item.name}" on type "${typeName}".`);
        continue;
      }
      if (item.selection.length > 0) {
        const child = namedOf(parseRef(spec.type));
        validateSelection(item.selection, child, doc, errors, depth + 1);
      }
    } else if (item.kind === 'InlineFragment') {
      const target = item.typeCondition ?? typeName;
      if (item.typeCondition !== null && !typeOfName(item.typeCondition)) {
        errors.push(`Unknown type "${item.typeCondition}".`);
        continue;
      }
      validateSelection(item.selection, target, doc, errors, depth + 1);
    } else {
      const fragment = doc.fragments.get(item.name);
      if (!fragment) {
        errors.push(`Unknown fragment "${item.name}".`);
        continue;
      }
      validateSelection(fragment.selection, fragment.typeCondition, doc, errors, depth + 1);
    }
  }
}

// ---------------------------------------------------------------- execution

interface ExecState {
  readonly ctx: GqlContext;
  readonly variables: Record<string, unknown>;
  readonly fragments: Document['fragments'];
  readonly errors: Array<{ message: string; path: Array<string | number> }>;
}

function evaluate(value: Value, variables: Record<string, unknown>): unknown {
  switch (value.kind) {
    case 'Variable':
      return variables[value.name];
    case 'Scalar':
      return value.value;
    case 'Enum':
      return value.value;
    case 'List':
      return value.values.map((item) => evaluate(item, variables));
    case 'Object': {
      const out: Record<string, unknown> = {};
      for (const [key, item] of Object.entries(value.fields)) {
        const evaluated = evaluate(item, variables);
        if (evaluated !== undefined) out[key] = evaluated;
      }
      return out;
    }
  }
}

function runtimeTypeOf(value: any, staticType: string): string {
  if (value !== null && typeof value === 'object' && typeof value.__typename === 'string') return value.__typename;
  return staticType;
}

function typeMatches(condition: string, runtime: string): boolean {
  if (condition === runtime) return true;
  const named = typeOfName(runtime);
  if (named?.interfaces?.includes(condition) === true) return true;
  const abstract = typeOfName(condition);
  return abstract?.kind === 'INTERFACE' && abstract.possibleTypes?.includes(runtime) === true;
}

function completeValue(typeText: string, value: unknown, selection: Selection[], state: ExecState, path: Array<string | number>): unknown {
  const ref = parseRef(typeText);
  return completeRef(ref, value, selection, state, path);
}

function completeRef(ref: Ref, value: unknown, selection: Selection[], state: ExecState, path: Array<string | number>): unknown {
  if (value === null || value === undefined) return null;
  if (ref.wrap === 'NON_NULL' && ref.of) return completeRef(ref.of, value, selection, state, path);
  if (ref.wrap === 'LIST' && ref.of) {
    if (!Array.isArray(value)) return null;
    return value.map((item, index) => completeRef(ref.of as Ref, item, selection, state, [...path, index]));
  }
  const name = ref.name ?? '';
  const named = typeOfName(name);
  if (named === undefined) return value;
  if (named.kind === 'SCALAR' || named.kind === 'ENUM') {
    return value;
  }
  const runtime = runtimeTypeOf(value, name);
  return executeFields(selection, runtime, value, state, path);
}

function executeFields(selection: Selection[], typeName: string, parent: unknown, state: ExecState, path: Array<string | number>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  collectFields(selection, typeName, parent, state, path, out);
  return out;
}

function collectFields(selection: Selection[], typeName: string, parent: unknown, state: ExecState, path: Array<string | number>, out: Record<string, unknown>): void {
  for (const item of selection) {
    if (item.kind === 'Field') {
      runField(item, typeName, parent, state, path, out);
    } else if (item.kind === 'InlineFragment') {
      const runtime = runtimeTypeOf(parent, typeName);
      if (item.typeCondition === null || typeMatches(item.typeCondition, runtime)) {
        collectFields(item.selection, runtime, parent, state, path, out);
      }
    } else {
      const fragment = state.fragments.get(item.name);
      if (fragment === undefined) continue;
      const runtime = runtimeTypeOf(parent, typeName);
      if (typeMatches(fragment.typeCondition, runtime)) collectFields(fragment.selection, runtime, parent, state, path, out);
    }
  }
}

function runField(item: FieldSelection, typeName: string, parent: unknown, state: ExecState, path: Array<string | number>, out: Record<string, unknown>): void {
  const key = item.alias ?? item.name;
  const here = [...path, key];
  if (item.name === '__typename') {
    out[key] = runtimeTypeOf(parent, typeName);
    return;
  }
  const runtime = runtimeTypeOf(parent, typeName);
  const spec = typeOfName(runtime)?.fields?.[item.name];
  if (spec === undefined) {
    out[key] = null;
    return;
  }
  const args: Record<string, unknown> = {};
  for (const argument of item.args) {
    const evaluated = evaluate(argument.value, state.variables);
    if (evaluated !== undefined) args[argument.name] = evaluated;
  }
  let resolved: unknown;
  try {
    resolved = spec.resolve(parent, args, state.ctx);
  } catch (err) {
    const message = err instanceof Error ? err.message : 'internal error';
    state.errors.push({ message, path: here });
    out[key] = null;
    return;
  }
  try {
    out[key] = completeValue(spec.type, resolved, item.selection, state, here);
  } catch (err) {
    state.errors.push({ message: err instanceof Error ? err.message : 'internal error', path: here });
    out[key] = null;
  }
}

/** Coerce the variables a request supplies against the operation's declarations. */
function coerceVariables(operation: Operation, supplied: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const definition of operation.variables) {
    let value = supplied[definition.name];
    if (value === undefined && definition.defaultValue !== null) value = evaluate(definition.defaultValue, {});
    if (value === undefined || value === null) {
      if (definition.type.nonNull && value === null) throw new ValidationFailure(`Variable "$${definition.name}" of non-null type "${typeNodeToRef(definition.type)}" must not be null.`);
      if (definition.type.nonNull && value === undefined) throw new ValidationFailure(`Variable "$${definition.name}" of required type "${typeNodeToRef(definition.type)}" was not provided.`);
      out[definition.name] = value;
      continue;
    }
    out[definition.name] = value;
  }
  return out;
}

export interface ExecutionResult {
  readonly data?: Record<string, unknown> | null;
  readonly errors?: Array<{ message: string; path?: Array<string | number> }>;
}

/** Execute one operation of a document. Validation failures return errors and no data. */
export function executeOperation(doc: Document, operation: Operation, supplied: Record<string, unknown>, ctx: GqlContext): ExecutionResult {
  const rootType = operation.operation === 'mutation' ? 'Mutation' : 'Query';
  const validation: string[] = [];
  try {
    validateSelection(operation.selection, rootType, doc, validation);
  } catch (err) {
    if (err instanceof ValidationFailure) return { errors: [{ message: err.message }] };
    throw err;
  }
  if (validation.length > 0) return { errors: validation.map((message) => ({ message })) };
  let variables: Record<string, unknown>;
  try {
    variables = coerceVariables(operation, supplied);
  } catch (err) {
    if (err instanceof ValidationFailure) return { errors: [{ message: err.message }] };
    throw err;
  }
  const state: ExecState = { ctx, variables, fragments: doc.fragments, errors: [] };
  const data = executeFields(operation.selection, rootType, null, state, []);
  if (state.errors.length > 0) return { data, errors: state.errors };
  return { data };
}

/** Parse and run a request's query text against the schema. Syntax errors come back as errors, not throws. */
export function runQuery(source: string, operationName: string | null, variables: Record<string, unknown>, ctx: GqlContext): ExecutionResult {
  let doc: Document;
  try {
    doc = parseDocument(source);
  } catch (err) {
    if (err instanceof GraphQLSyntaxError) return { errors: [{ message: err.message }] };
    throw err;
  }
  let operation: Operation | undefined;
  if (operationName !== null) {
    operation = doc.operations.find((candidate) => candidate.name === operationName);
    if (operation === undefined) return { errors: [{ message: `Unknown operation named "${operationName}".` }] };
  } else if (doc.operations.length === 1) {
    operation = doc.operations[0];
  } else {
    return { errors: [{ message: 'An operation name is required when a document holds more than one operation.' }] };
  }
  return executeOperation(doc, operation, variables, ctx);
}

