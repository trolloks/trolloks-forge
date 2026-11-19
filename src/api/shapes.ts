// The JSON the REST API (and the MCP tools, which speak the same objects) returns. Every object's id is
// stable: a repository, issue or pull request keeps its id and node id across reads, because both are
// assigned once when the record is created and persisted with it.

import { commitOf, mergeBases, mergeTrees, peelToCommit, type ObjectLookup } from '../git/ops.ts';
import { parseTree, type CommitView, type TreeEntry } from '../git/objects.ts';
import type { CommentRecord, IssueRecord, LabelRecord, RepoRecord, Store } from '../store/store.ts';

/** GitHub-style opaque node id for a record of a type. */
export function nodeId(type: string, id: number): string {
  return Buffer.from(`0${type.length}:${type}${id}`, 'utf8').toString('base64');
}

export function userJson(login: string, origin: string): Record<string, unknown> {
  return {
    login,
    id: stableNumber(login),
    node_id: nodeId('User', stableNumber(login)),
    avatar_url: `${origin}/avatars/${login}`,
    html_url: `${origin}/${login}`,
    url: `${origin}/api/v3/users/${login}`,
    type: 'User',
    site_admin: false,
  };
}

/** A small stable number for a login (only used where GitHub wants a numeric user id). */
export function stableNumber(text: string): number {
  let hash = 0;
  for (let index = 0; index < text.length; index += 1) hash = (hash * 31 + text.charCodeAt(index)) % 2147483647;
  return hash + 1;
}

export function repoFullName(login: string, name: string): string {
  return `${login}/${name}`;
}

export function repoJson(store: Store, repo: RepoRecord, origin: string): Record<string, unknown> {
  const login = store.login ?? '';
  const full = repoFullName(login, repo.name);
  const openIssues = store.listIssueRecords(repo.id).filter((issue) => issue.state === 'open').length;
  return {
    id: repo.id,
    node_id: nodeId('Repository', repo.id),
    name: repo.name,
    full_name: full,
    private: repo.private,
    owner: userJson(login, origin),
    html_url: `${origin}/${full}`,
    description: repo.description,
    fork: false,
    url: `${origin}/api/v3/repos/${full}`,
    git_url: `git://${origin.replace(/^https?:\/\//, '')}/${full}.git`,
    clone_url: `${origin}/${full}.git`,
    ssh_url: `git@${origin.replace(/^https?:\/\//, '')}:${full}.git`,
    homepage: null,
    size: 0,
    stargazers_count: 0,
    watchers_count: 0,
    language: null,
    has_issues: true,
    has_projects: false,
    has_wiki: false,
    has_pages: false,
    forks_count: 0,
    open_issues_count: openIssues,
    archived: false,
    disabled: false,
    visibility: repo.private ? 'private' : 'public',
    license: null,
    default_branch: repo.default_branch,
    permissions: { admin: true, maintain: true, push: true, triage: true, pull: true },
    allow_merge_commit: true,
    allow_squash_merge: true,
    allow_rebase_merge: true,
    created_at: repo.created_at,
    updated_at: repo.updated_at,
    pushed_at: repo.pushed_at,
  };
}

/** Label JSON (the owner is the store's bound login). */
export function labelJsonFor(store: Store, label: LabelRecord, repo: RepoRecord, origin: string): Record<string, unknown> {
  const full = repoFullName(store.login ?? '', repo.name);
  return {
    id: label.id,
    node_id: nodeId('Label', label.id),
    url: `${origin}/api/v3/repos/${full}/labels/${encodeURIComponent(label.name)}`,
    name: label.name,
    color: label.color,
    default: false,
    description: label.description,
  };
}

export function issueJson(store: Store, issue: IssueRecord, repo: RepoRecord, origin: string): Record<string, unknown> {
  const full = repoFullName(store.login ?? '', repo.name);
  const labels = issue.labels.map((name) => {
    const label = store.findLabel(repo.id, name);
    return labelJsonFor(store, label ?? { id: 0, repo_id: repo.id, name, color: 'ededed', description: '' }, repo, origin);
  });
  const base: Record<string, unknown> = {
    id: issue.id,
    node_id: nodeId('Issue', issue.id),
    number: issue.number,
    title: issue.title,
    body: issue.body,
    user: userJson(issue.author, origin),
    labels,
    state: issue.state,
    state_reason: issue.state_reason,
    locked: false,
    assignee: null,
    assignees: [],
    comments: store.countComments(issue.id),
    created_at: issue.created_at,
    updated_at: issue.updated_at,
    closed_at: issue.closed_at,
    author_association: 'OWNER',
    html_url: `${origin}/${full}/${issue.is_pull ? 'pull' : 'issues'}/${issue.number}`,
    url: `${origin}/api/v3/repos/${full}/issues/${issue.number}`,
    repository_url: `${origin}/api/v3/repos/${full}`,
    comments_url: `${origin}/api/v3/repos/${full}/issues/${issue.number}/comments`,
  };
  if (issue.is_pull && issue.pull !== null) {
    base.pull_request = {
      url: `${origin}/api/v3/repos/${full}/pulls/${issue.number}`,
      html_url: `${origin}/${full}/pull/${issue.number}`,
      merged_at: issue.pull.merged_at,
    };
  }
  return base;
}

/** The live tip of a branch in this repository, or the frozen merge-time value. */
function branchTip(store: Store, repo: RepoRecord, branch: string, frozen: string | null): string {
  return store.getRef(repo.id, `refs/heads/${branch}`) ?? frozen ?? '';
}

export function pullJson(store: Store, issue: IssueRecord, repo: RepoRecord, origin: string, mergeable: boolean | null): Record<string, unknown> {
  const pull = issue.pull;
  if (pull === null) throw new Error('not a pull request');
  const full = repoFullName(store.login ?? '', repo.name);
  const headSha = pull.merged ? pull.head_sha_at_merge ?? '' : branchTip(store, repo, pull.head_ref, pull.head_sha_at_merge);
  const baseSha = pull.merged ? pull.base_sha_at_merge ?? '' : branchTip(store, repo, pull.base_ref, pull.base_sha_at_merge);
  const user = userJson(issue.author, origin);
  const repoRef = repoJsonCompact(store, repo, origin);
  const mergeableState = mergeable === null ? 'unknown' : mergeable ? 'clean' : 'dirty';
  return {
    id: issue.id,
    node_id: nodeId('PullRequest', issue.id),
    number: issue.number,
    state: issue.state,
    locked: false,
    title: issue.title,
    body: issue.body,
    user,
    labels: issue.labels.map((name) => ({ name })),
    draft: false,
    merged: pull.merged,
    merged_at: pull.merged_at,
    merge_commit_sha: pull.merge_commit_sha,
    merged_by: pull.merged ? user : null,
    mergeable,
    mergeable_state: mergeableState,
    rebaseable: mergeable,
    comments: store.countComments(issue.id),
    review_comments: 0,
    commits: 0,
    additions: 0,
    deletions: 0,
    changed_files: 0,
    head: {
      label: `${store.login ?? ''}:${pull.head_ref}`,
      ref: pull.head_ref,
      sha: headSha,
      user,
      repo: repoRef,
    },
    base: {
      label: `${store.login ?? ''}:${pull.base_ref}`,
      ref: pull.base_ref,
      sha: baseSha,
      user,
      repo: repoRef,
    },
    created_at: issue.created_at,
    updated_at: issue.updated_at,
    closed_at: issue.closed_at,
    html_url: `${origin}/${full}/pull/${issue.number}`,
    url: `${origin}/api/v3/repos/${full}/pulls/${issue.number}`,
    issue_url: `${origin}/api/v3/repos/${full}/issues/${issue.number}`,
    diff_url: `${origin}/${full}/pull/${issue.number}.diff`,
    patch_url: `${origin}/${full}/pull/${issue.number}.patch`,
    commits_url: `${origin}/api/v3/repos/${full}/pulls/${issue.number}/commits`,
    review_comments_url: `${origin}/api/v3/repos/${full}/pulls/${issue.number}/comments`,
    statuses_url: `${origin}/api/v3/repos/${full}/statuses/${headSha}`,
    author_association: 'OWNER',
  };
}

function repoJsonCompact(store: Store, repo: RepoRecord, origin: string): Record<string, unknown> {
  const login = store.login ?? '';
  const full = repoFullName(login, repo.name);
  return {
    id: repo.id,
    node_id: nodeId('Repository', repo.id),
    name: repo.name,
    full_name: full,
    private: repo.private,
    owner: userJson(login, origin),
    html_url: `${origin}/${full}`,
    default_branch: repo.default_branch,
  };
}

export function commitJson(odb: ObjectLookup, sha: string, repo: RepoRecord, origin: string, login: string): Record<string, unknown> {
  const view: CommitView = commitOf(odb, sha);
  const full = repoFullName(login, repo.name);
  return {
    sha,
    node_id: nodeId('Commit', stableNumber(sha)),
    commit: {
      author: signatureOf(view.author),
      committer: signatureOf(view.committer),
      message: view.message,
      comment_count: 0,
      tree: { sha: view.tree, url: `${origin}/api/v3/repos/${full}/git/trees/${view.tree}` },
      url: `${origin}/api/v3/repos/${full}/git/commits/${sha}`,
      verification: { verified: false, reason: 'unsigned', signature: null, payload: null },
    },
    url: `${origin}/api/v3/repos/${full}/commits/${sha}`,
    html_url: `${origin}/${full}/commit/${sha}`,
    parents: view.parents.map((parent) => ({ sha: parent, url: `${origin}/api/v3/repos/${full}/commits/${parent}` })),
  };
}

/** `Name <email> 1700000000 +0000` as an author object. */
export function signatureOf(line: string): { name: string; email: string; date: string } {
  const match = /^(.*) <([^>]*)> (\d+) ([+-]\d{4})$/.exec(line);
  if (!match) return { name: line, email: '', date: new Date(0).toISOString() };
  return { name: match[1], email: match[2], date: new Date(Number(match[3]) * 1000).toISOString() };
}

export function commentJson(store: Store, comment: CommentRecord, issue: IssueRecord, repo: RepoRecord, origin: string): Record<string, unknown> {
  const full = repoFullName(store.login ?? '', repo.name);
  return {
    id: comment.id,
    node_id: nodeId('IssueComment', comment.id),
    body: comment.body,
    user: userJson(comment.author, origin),
    created_at: comment.created_at,
    updated_at: comment.updated_at,
    issue_url: `${origin}/api/v3/repos/${full}/issues/${issue.number}`,
    html_url: `${origin}/${full}/issues/${issue.number}#issuecomment-${comment.id}`,
    author_association: 'OWNER',
  };
}

export interface FileChange {
  readonly path: string;
  readonly status: 'added' | 'modified' | 'removed';
  readonly additions: number;
  readonly deletions: number;
  readonly sha: string;
}

function lineCount(bytes: Buffer): number {
  if (bytes.length === 0) return 0;
  let count = 0;
  for (const byte of bytes) if (byte === 0x0a) count += 1;
  return bytes[bytes.length - 1] === 0x0a ? count : count + 1;
}

/** Changed paths between two trees, with line counts for their contents (a rough but honest count). */
export function diffTrees(odb: ObjectLookup, from: Map<string, { mode: string; oid: string }>, to: Map<string, { mode: string; oid: string }>): FileChange[] {
  const paths = new Set<string>([...from.keys(), ...to.keys()]);
  const out: FileChange[] = [];
  for (const path of [...paths].sort()) {
    const before = from.get(path);
    const after = to.get(path);
    if (before && after && before.oid === after.oid && before.mode === after.mode) continue;
    const beforeLines = before ? lineCount(odb.get(before.oid)?.data ?? Buffer.alloc(0)) : 0;
    const afterLines = after ? lineCount(odb.get(after.oid)?.data ?? Buffer.alloc(0)) : 0;
    const status: FileChange['status'] = !before ? 'added' : !after ? 'removed' : 'modified';
    const additions = status === 'removed' ? 0 : status === 'added' ? afterLines : Math.max(0, afterLines - beforeLines) || 1;
    const deletions = status === 'added' ? 0 : status === 'removed' ? beforeLines : Math.max(0, beforeLines - afterLines);
    out.push({ path, status, additions, deletions, sha: (after ?? before)?.oid ?? '' });
  }
  return out;
}

export function fileJson(path: string, mode: string, oid: string, data: Buffer, origin: string, login: string, repo: RepoRecord, ref?: string): Record<string, unknown> {
  const full = repoFullName(login, repo.name);
  const name = path.split('/').pop() ?? path;
  const suffix = ref === undefined ? '' : `?ref=${encodeURIComponent(ref)}`;
  return {
    type: mode === '120000' ? 'symlink' : 'file',
    encoding: 'base64',
    size: data.length,
    name,
    path,
    content: data.toString('base64'),
    sha: oid,
    url: `${origin}/api/v3/repos/${full}/contents/${path}${suffix}`,
    git_url: `${origin}/api/v3/repos/${full}/git/blobs/${oid}`,
    html_url: `${origin}/${full}/blob/${repo.default_branch}/${path}`,
    download_url: `${origin}/${full}/raw/${repo.default_branch}/${path}`,
    _links: { self: `${origin}/api/v3/repos/${full}/contents/${path}${suffix}`, git: `${origin}/api/v3/repos/${full}/git/blobs/${oid}` },
  };
}

export function dirEntryJson(entry: TreeEntry, parentPath: string, origin: string, login: string, repo: RepoRecord, size: number): Record<string, unknown> {
  const path = parentPath === '' ? entry.name : `${parentPath}/${entry.name}`;
  const full = repoFullName(login, repo.name);
  const isDir = entry.mode === '40000';
  return {
    type: isDir ? 'dir' : entry.mode === '120000' ? 'symlink' : 'file',
    size,
    name: entry.name,
    path,
    sha: entry.oid,
    url: `${origin}/api/v3/repos/${full}/contents/${path}`,
    html_url: `${origin}/${full}/tree/${repo.default_branch}/${path}`,
    git_url: `${origin}/api/v3/repos/${full}/git/${isDir ? 'trees' : 'blobs'}/${entry.oid}`,
    download_url: isDir ? null : `${origin}/${full}/raw/${repo.default_branch}/${path}`,
    _links: { self: `${origin}/api/v3/repos/${full}/contents/${path}`, git: `${origin}/api/v3/repos/${full}/git/${isDir ? 'trees' : 'blobs'}/${entry.oid}`, html: `${origin}/${full}/tree/${repo.default_branch}/${path}` },
  };
}

/** The tree entries of a tree object (for directory listings). */
export function treeEntriesOf(odb: ObjectLookup, oid: string): TreeEntry[] {
  const object = odb.get(oid);
  if (object === undefined || object.type !== 'tree') return [];
  return parseTree(object.data);
}

/**
 * Whether a pull request's head can be merged into its base without conflicts. Null when either branch is
 * missing. The merge-base is computed fresh so this always reflects the current branch tips.
 */
export function pullMergeable(odb: ObjectLookup, baseTip: string | undefined, headTip: string | undefined): boolean | null {
  if (baseTip === undefined || headTip === undefined) return null;
  const base = peelToCommit(odb, baseTip);
  const head = peelToCommit(odb, headTip);
  if (base === undefined || head === undefined) return null;
  const bases = mergeBases(odb, base, head);
  const ancestor = bases[0];
  const ancestorTree = ancestor === undefined ? null : commitOf(odb, ancestor).tree;
  const result = mergeTrees(odb, ancestorTree, commitOf(odb, base).tree, commitOf(odb, head).tree);
  return !('conflicts' in result);
}
