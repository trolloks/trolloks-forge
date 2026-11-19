// The forge's domain operations: issues, labels, pull requests, merges and comments. REST, GraphQL and MCP
// all call these, so one rule (a missing label is refused, a conflicted merge is refused, an unknown branch
// is refused) holds on every surface. Failures are HttpError values; each surface renders them its own way.

import { HttpError } from '../http/util.ts';
import { commitOf, editPath, isAncestor, mergeBaseOne, mergeTrees, peelToCommit, validRefName } from '../git/ops.ts';
import { buildCommit, type GitObject, type Signature } from '../git/objects.ts';
import { NAME_RE, StoreError, type IssueRecord, type PullInfo, type RepoRecord, type Store } from '../store/store.ts';
import { pullMergeable } from './shapes.ts';

export function validation(message: string, errors: Array<Record<string, unknown>> = []): HttpError {
  return new HttpError(422, 'Validation Failed', { errors: errors.length > 0 ? errors : [{ resource: 'Repository', code: 'custom', message }] });
}

export function now(): number {
  return Math.floor(Date.now() / 1000);
}

export function signatureFor(store: Store, input: Record<string, unknown> | undefined): Signature {
  const login = store.login ?? 'forge';
  const name = typeof input?.name === 'string' && input.name !== '' ? input.name : login;
  const email = typeof input?.email === 'string' && input.email !== '' ? input.email : `${login}@users.noreply.github.com`;
  let when = now();
  if (typeof input?.date === 'string') {
    const parsed = Date.parse(input.date);
    if (!Number.isNaN(parsed)) when = Math.floor(parsed / 1000);
  }
  return { name, email, when, tz: '+0000' };
}

export function putObject(store: Store, object: GitObject): string {
  return store.objects.put(object);
}

export function emptyTree(store: Store): string {
  return putObject(store, { type: 'tree', data: Buffer.alloc(0) });
}

/** Label names an issue carries. Every named label must already exist, or the request is refused. */
export function labelNamesFor(store: Store, repo: RepoRecord, names: readonly string[]): string[] {
  const out: string[] = [];
  for (const name of names) {
    if (store.findLabel(repo.id, name) === undefined) {
      throw validation('label does not exist', [{ resource: 'Issue', code: 'invalid', field: 'labels', value: name }]);
    }
    out.push(name);
  }
  return [...new Set(out)];
}

export function createIssueRecord(store: Store, repo: RepoRecord, input: { title: string; body: string; labels: readonly string[] }): IssueRecord {
  const labels = labelNamesFor(store, repo, input.labels);
  const at = store.nowIso();
  return store.newIssue({
    repo_id: repo.id,
    is_pull: false,
    title: input.title,
    body: input.body,
    state: 'open',
    state_reason: null,
    author: store.login ?? 'forge',
    labels,
    created_at: at,
    updated_at: at,
    closed_at: null,
    pull: null,
  });
}

export function setIssueState(store: Store, issue: IssueRecord, state: 'open' | 'closed'): IssueRecord {
  if (state === issue.state) return issue;
  const at = store.nowIso();
  return store.saveIssue({
    ...issue,
    state,
    state_reason: state === 'closed' ? 'completed' : null,
    closed_at: state === 'closed' ? at : null,
    updated_at: at,
  });
}

export function addCommentRecord(store: Store, repo: RepoRecord, issue: IssueRecord, body: string) {
  const at = store.nowIso();
  return store.addComment({ repo_id: repo.id, issue_id: issue.id, body, author: store.login ?? 'forge', created_at: at, updated_at: at });
}

/** Open a pull request from `head` into `base`, both branches of this repository. */
export function createPullRecord(store: Store, repo: RepoRecord, input: { title: string; body: string; head: string; base: string }): IssueRecord {
  const headOid = store.getRef(repo.id, `refs/heads/${input.head}`);
  const baseOid = store.getRef(repo.id, `refs/heads/${input.base}`);
  if (headOid === undefined) throw validation(`head ${input.head} does not exist`, [{ resource: 'PullRequest', code: 'invalid', field: 'head' }]);
  if (baseOid === undefined) throw validation(`base ${input.base} does not exist`, [{ resource: 'PullRequest', code: 'invalid', field: 'base' }]);
  const headCommit = peelToCommit(store.objects, headOid);
  const baseCommit = peelToCommit(store.objects, baseOid);
  if (headCommit === undefined || baseCommit === undefined) throw validation('head or base is not a commit', [{ resource: 'PullRequest', code: 'invalid', field: 'head' }]);
  if (headCommit === baseCommit || isAncestor(store.objects, headCommit, baseCommit)) {
    throw validation(`No commits between ${input.base} and ${input.head}`, [{ resource: 'PullRequest', code: 'invalid', field: 'head' }]);
  }
  const duplicate = store
    .listIssueRecords(repo.id)
    .some((item) => item.is_pull && item.state === 'open' && item.pull?.head_ref === input.head && item.pull?.base_ref === input.base);
  if (duplicate) throw validation(`A pull request already exists for ${input.head}`, [{ resource: 'PullRequest', code: 'custom', field: 'head' }]);
  const at = store.nowIso();
  return store.newIssue({
    repo_id: repo.id,
    is_pull: true,
    title: input.title,
    body: input.body,
    state: 'open',
    state_reason: null,
    author: store.login ?? 'forge',
    labels: [],
    created_at: at,
    updated_at: at,
    closed_at: null,
    pull: { head_ref: input.head, base_ref: input.base, merged: false, merged_at: null, merge_commit_sha: null, head_sha_at_merge: null, base_sha_at_merge: null },
  });
}

/** Whether an open pull request's head merges cleanly into its base right now. */
export function mergeableOf(store: Store, repo: RepoRecord, issue: IssueRecord): boolean | null {
  if (issue.pull === null || issue.pull.merged) return null;
  const base = store.getRef(repo.id, `refs/heads/${issue.pull.base_ref}`);
  const head = store.getRef(repo.id, `refs/heads/${issue.pull.head_ref}`);
  return pullMergeable(store.objects, base, head);
}

export type MergeMethod = 'merge' | 'squash';

export class MergeRefused extends HttpError {
  constructor(message: string) {
    super(405, message);
  }
}

/**
 * Merge an open pull request. A squash merge makes one commit on the base with the head's combined changes;
 * a merge commit keeps the head as its second parent. Refused (405) when the pull is closed, its branches are
 * gone, or the changes conflict. The base branch moves to the new commit and the pull records the merge.
 */
export function mergePullRecord(
  store: Store,
  repo: RepoRecord,
  issue: IssueRecord,
  options: { method: MergeMethod; title?: string; body?: string },
): string {
  const pull = issue.pull as PullInfo;
  if (pull.merged || issue.state === 'closed') throw new MergeRefused('Pull Request is not mergeable');
  const baseTip = store.getRef(repo.id, `refs/heads/${pull.base_ref}`);
  const headTip = store.getRef(repo.id, `refs/heads/${pull.head_ref}`);
  if (baseTip === undefined || headTip === undefined) throw new MergeRefused('Pull Request is not mergeable');
  const base = peelToCommit(store.objects, baseTip);
  const head = peelToCommit(store.objects, headTip);
  if (base === undefined || head === undefined) throw new MergeRefused('Pull Request is not mergeable');
  const ancestor = mergeBaseOne(store.objects, base, head);
  const merged = mergeTrees(
    store.objects,
    ancestor === undefined ? null : commitOf(store.objects, ancestor).tree,
    commitOf(store.objects, base).tree,
    commitOf(store.objects, head).tree,
  );
  if ('conflicts' in merged) throw new MergeRefused('Pull Request is not mergeable');

  const title = options.title ?? issue.title;
  const text = options.body ?? issue.body;
  const author = signatureFor(store, undefined);
  let message: string;
  let parents: string[];
  if (options.method === 'squash') {
    message = text === '' ? `${title} (#${issue.number})\n` : `${title} (#${issue.number})\n\n${text}\n`;
    parents = [base];
  } else {
    message = `Merge pull request #${issue.number} from ${repo.name}/${pull.head_ref}\n\n${title}\n${text === '' ? '' : `\n${text}\n`}`;
    parents = [base, head];
  }
  const tree = merged.tree ?? emptyTree(store);
  const sha = putObject(store, { type: 'commit', data: buildCommit({ tree, parents, author, committer: author, message }) });
  store.setRef(repo.id, `refs/heads/${pull.base_ref}`, sha);
  const at = store.nowIso();
  store.saveIssue({
    ...issue,
    state: 'closed',
    closed_at: at,
    updated_at: at,
    pull: { ...pull, merged: true, merged_at: at, merge_commit_sha: sha, head_sha_at_merge: head, base_sha_at_merge: base },
  });
  store.touchRepo(repo, true);
  return sha;
}

/**
 * Create a repository. With `autoInit`, its default branch starts with a README commit (as GitHub does), so
 * the repository is never empty when the caller asks for one.
 */
export function createRepository(
  store: Store,
  input: { name: string; description: string; private: boolean; defaultBranch: string; autoInit: boolean },
): RepoRecord {
  if (!NAME_RE.test(input.name) || input.name === '.' || input.name === '..') {
    throw new HttpError(422, 'Repository creation failed.', { errors: [{ resource: 'Repository', code: 'invalid', field: 'name', message: 'name is invalid' }] });
  }
  if (!validRefName(`refs/heads/${input.defaultBranch}`)) throw validation('default_branch is invalid', [{ resource: 'Repository', code: 'invalid', field: 'default_branch' }]);
  let repo: RepoRecord;
  try {
    repo = store.createRepo({ name: input.name, description: input.description, private: input.private, default_branch: input.defaultBranch });
  } catch (err) {
    if (err instanceof StoreError) {
      throw new HttpError(422, 'Repository creation failed.', { errors: [{ resource: 'Repository', code: 'custom', field: 'name', message: err.message }] });
    }
    throw err;
  }
  if (input.autoInit) {
    const blob = putObject(store, { type: 'blob', data: Buffer.from(`# ${input.name}\n`, 'utf8') });
    const tree = editPath(store.objects, null, 'README.md', { mode: '100644', oid: blob }) ?? emptyTree(store);
    const commit = putObject(store, {
      type: 'commit',
      data: buildCommit({ tree, parents: [], author: signatureFor(store, undefined), committer: signatureFor(store, undefined), message: 'Initial commit' }),
    });
    store.setRef(repo.id, `refs/heads/${input.defaultBranch}`, commit);
    repo = store.touchRepo(repo, true);
  }
  return repo;
}

/** Validate a branch or ref name for a repository write. */
export function requireBranchName(branch: string): void {
  if (!validRefName(`refs/heads/${branch}`)) throw validation('branch is invalid', [{ resource: 'Reference', code: 'invalid', field: 'branch' }]);
}

export { StoreError };
