// The forge's state: one object database shared by every repository (objects are content-addressed, so
// sharing is safe), and the repository, ref, label, issue, pull request and comment records. Each mutation
// is journaled before the caller sees it succeed; boot replays the journal and rebuilds the same maps.
//
// The store is synchronous on purpose: every handler runs to completion inside one event-loop turn, so a
// read-modify-write (allocate an issue number, move a branch) cannot interleave with another request.

import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { inflateSync, deflateSync } from 'node:zlib';
import { AppendLog } from './log.ts';
import { hashObject, isOid, type GitObject, type ObjType } from '../git/objects.ts';

export class StoreError extends Error {
  readonly status: number;
  readonly code: string;
  constructor(status: number, code: string, message: string) {
    super(message);
    this.status = status;
    this.code = code;
  }
}

// ---------------------------------------------------------------- records

export interface RepoRecord {
  id: number;
  name: string;
  description: string;
  private: boolean;
  default_branch: string;
  created_at: string;
  updated_at: string;
  pushed_at: string | null;
}

export interface LabelRecord {
  id: number;
  repo_id: number;
  name: string;
  color: string;
  description: string;
}

export interface PullInfo {
  head_ref: string;
  base_ref: string;
  merged: boolean;
  merged_at: string | null;
  merge_commit_sha: string | null;
  /** Frozen at merge time; while open, head and base read the live branch tips. */
  head_sha_at_merge: string | null;
  base_sha_at_merge: string | null;
}

export interface IssueRecord {
  id: number;
  repo_id: number;
  number: number;
  is_pull: boolean;
  title: string;
  body: string;
  state: 'open' | 'closed';
  state_reason: string | null;
  author: string;
  labels: string[];
  created_at: string;
  updated_at: string;
  closed_at: string | null;
  pull: PullInfo | null;
}

export interface CommentRecord {
  id: number;
  repo_id: number;
  issue_id: number;
  body: string;
  author: string;
  created_at: string;
  updated_at: string;
}

// ---------------------------------------------------------------- object database

const TYPE_CODE: Record<ObjType, number> = { commit: 1, tree: 2, blob: 3, tag: 4 };
const CODE_TYPE: Record<number, ObjType> = { 1: 'commit', 2: 'tree', 3: 'blob', 4: 'tag' };

/** Every object the forge holds, by id. Backed by an append-only file of deflated records. */
export class ObjectDb {
  private readonly objects = new Map<string, GitObject>();
  private readonly log: AppendLog;

  constructor(log: AppendLog) {
    this.log = log;
    this.replay();
  }

  private replay(): void {
    const bytes = this.log.readAll();
    let pos = 0;
    while (pos < bytes.length) {
      if (pos + 25 > bytes.length) break;
      const code = bytes[pos];
      const oid = bytes.subarray(pos + 1, pos + 21).toString('hex');
      const length = bytes.readUInt32BE(pos + 21);
      if (pos + 25 + length > bytes.length || !CODE_TYPE[code]) break;
      const data = inflateSync(bytes.subarray(pos + 25, pos + 25 + length));
      this.objects.set(oid, { type: CODE_TYPE[code], data });
      pos += 25 + length;
    }
    if (pos < bytes.length) this.log.truncate(pos);
  }

  get(oid: string): GitObject | undefined {
    return this.objects.get(oid);
  }

  has(oid: string): boolean {
    return this.objects.has(oid);
  }

  /** Store an object and return its id. Idempotent: an object already held is not written again. */
  put(object: GitObject): string {
    const oid = hashObject(object.type, object.data);
    this.store(oid, object);
    return oid;
  }

  /** Store an object whose id is already known (it was verified by the caller). */
  store(oid: string, object: GitObject): void {
    if (this.objects.has(oid)) return;
    this.objects.set(oid, object);
    const deflated = deflateSync(object.data);
    const head = Buffer.alloc(25);
    head[0] = TYPE_CODE[object.type];
    Buffer.from(oid, 'hex').copy(head, 1);
    head.writeUInt32BE(deflated.length, 21);
    this.log.append(Buffer.concat([head, deflated]));
  }

  get size(): number {
    return this.objects.size;
  }

  sync(): void {
    this.log.sync();
  }
}

// ---------------------------------------------------------------- store

type Journal =
  | { k: 'login'; v: { login: string } }
  | { k: 'repo'; v: RepoRecord }
  | { k: 'repo.del'; v: { id: number } }
  | { k: 'ref'; v: { repo_id: number; name: string; oid: string | null } }
  | { k: 'label'; v: LabelRecord }
  | { k: 'issue'; v: IssueRecord }
  | { k: 'comment'; v: CommentRecord };

export const NAME_RE = /^[A-Za-z0-9._-]{1,100}$/;

export class Store {
  readonly objects: ObjectDb;
  private readonly meta: AppendLog;
  private seq = 0;
  private loginName: string | null = null;

  private readonly repos = new Map<number, RepoRecord>();
  private readonly repoIdByName = new Map<string, number>();
  private readonly refs = new Map<number, Map<string, string>>();
  private readonly labels = new Map<number, Map<string, LabelRecord>>();
  private readonly issues = new Map<number, Map<number, IssueRecord>>();
  private readonly issuesById = new Map<number, IssueRecord>();
  private readonly comments = new Map<number, CommentRecord[]>();
  private readonly commentsById = new Map<number, CommentRecord>();
  private readonly counters = new Map<number, number>();

  constructor(dir: string) {
    mkdirSync(dir, { recursive: true });
    this.objects = new ObjectDb(new AppendLog(join(dir, 'objects.log')));
    this.meta = new AppendLog(join(dir, 'meta.log'));
    this.replayMeta();
  }

  // -------------------------------------------------------------- journal

  private replayMeta(): void {
    const bytes = this.meta.readAll();
    let pos = 0;
    while (pos < bytes.length) {
      const newline = bytes.indexOf(0x0a, pos);
      if (newline < 0) break;
      const line = bytes.toString('utf8', pos, newline);
      pos = newline + 1;
      let entry: Journal;
      try {
        entry = JSON.parse(line) as Journal;
      } catch {
        throw new Error(`meta.log holds an unreadable record at byte ${pos}`);
      }
      this.apply(entry);
    }
    if (pos < bytes.length) this.meta.truncate(pos);
    for (const repo of this.repos.values()) this.bumpSeq(repo.id);
  }

  private bumpSeq(id: number): void {
    if (id > this.seq) this.seq = id;
  }

  private apply(entry: Journal): void {
    switch (entry.k) {
      case 'login':
        this.loginName = entry.v.login;
        return;
      case 'repo': {
        const repo = entry.v;
        const previous = this.repos.get(repo.id);
        if (previous) this.repoIdByName.delete(previous.name.toLowerCase());
        this.repos.set(repo.id, repo);
        this.repoIdByName.set(repo.name.toLowerCase(), repo.id);
        this.bumpSeq(repo.id);
        return;
      }
      case 'repo.del': {
        const id = entry.v.id;
        const repo = this.repos.get(id);
        if (repo) this.repoIdByName.delete(repo.name.toLowerCase());
        this.repos.delete(id);
        this.refs.delete(id);
        this.labels.delete(id);
        this.counters.delete(id);
        for (const issue of this.issues.get(id)?.values() ?? []) {
          this.issuesById.delete(issue.id);
          for (const comment of this.comments.get(issue.id) ?? []) this.commentsById.delete(comment.id);
          this.comments.delete(issue.id);
        }
        this.issues.delete(id);
        return;
      }
      case 'ref': {
        const { repo_id, name, oid } = entry.v;
        let map = this.refs.get(repo_id);
        if (!map) {
          map = new Map();
          this.refs.set(repo_id, map);
        }
        if (oid === null) map.delete(name);
        else map.set(name, oid);
        return;
      }
      case 'label': {
        const label = entry.v;
        let map = this.labels.get(label.repo_id);
        if (!map) {
          map = new Map();
          this.labels.set(label.repo_id, map);
        }
        map.set(label.name, label);
        this.bumpSeq(label.id);
        return;
      }
      case 'issue': {
        const issue = entry.v;
        let map = this.issues.get(issue.repo_id);
        if (!map) {
          map = new Map();
          this.issues.set(issue.repo_id, map);
        }
        map.set(issue.number, issue);
        this.issuesById.set(issue.id, issue);
        this.bumpSeq(issue.id);
        const counter = this.counters.get(issue.repo_id) ?? 0;
        if (issue.number > counter) this.counters.set(issue.repo_id, issue.number);
        return;
      }
      case 'comment': {
        const comment = entry.v;
        const existing = this.commentsById.get(comment.id);
        if (existing) {
          const list = this.comments.get(comment.issue_id) ?? [];
          const index = list.findIndex((item) => item.id === comment.id);
          if (index >= 0) list[index] = comment;
        } else {
          const list = this.comments.get(comment.issue_id) ?? [];
          list.push(comment);
          this.comments.set(comment.issue_id, list);
        }
        this.commentsById.set(comment.id, comment);
        this.bumpSeq(comment.id);
        return;
      }
    }
  }

  private persist(entry: Journal): void {
    this.meta.append(Buffer.from(`${JSON.stringify(entry)}\n`, 'utf8'));
    this.apply(entry);
  }

  /** Flush both logs to the device. */
  sync(): void {
    this.meta.sync();
    this.objects.sync();
  }

  nextId(): number {
    this.seq += 1;
    return this.seq;
  }

  nowIso(): string {
    return new Date().toISOString();
  }

  // -------------------------------------------------------------- login

  /** The login this single-tenant forge answers for, or null until the first owner-scoped request binds it. */
  get login(): string | null {
    return this.loginName;
  }

  /** Bind the login (once). Returns true when this call bound it. */
  bindLogin(login: string): boolean {
    if (this.loginName !== null) return false;
    this.persist({ k: 'login', v: { login } });
    return true;
  }

  // -------------------------------------------------------------- repositories

  listRepos(): RepoRecord[] {
    return [...this.repos.values()].sort((a, b) => a.id - b.id);
  }

  repoById(id: number): RepoRecord | undefined {
    return this.repos.get(id);
  }

  repoByName(name: string): RepoRecord | undefined {
    const id = this.repoIdByName.get(name.toLowerCase());
    return id === undefined ? undefined : this.repos.get(id);
  }

  createRepo(input: { name: string; description: string; private: boolean; default_branch?: string }): RepoRecord {
    if (this.repoByName(input.name) !== undefined) throw new StoreError(422, 'already_exists', `name already exists on this account`);
    const now = this.nowIso();
    const repo: RepoRecord = {
      id: this.nextId(),
      name: input.name,
      description: input.description,
      private: input.private,
      default_branch: input.default_branch ?? 'main',
      created_at: now,
      updated_at: now,
      pushed_at: null,
    };
    this.persist({ k: 'repo', v: repo });
    return repo;
  }

  updateRepo(repo: RepoRecord, patch: Partial<Pick<RepoRecord, 'name' | 'description' | 'private' | 'default_branch'>>): RepoRecord {
    const next: RepoRecord = { ...repo, ...patch, updated_at: this.nowIso() };
    this.persist({ k: 'repo', v: next });
    return next;
  }

  touchRepo(repo: RepoRecord, pushed: boolean): RepoRecord {
    const next: RepoRecord = { ...repo, updated_at: this.nowIso(), pushed_at: pushed ? this.nowIso() : repo.pushed_at };
    this.persist({ k: 'repo', v: next });
    return next;
  }

  deleteRepo(repo: RepoRecord): void {
    this.persist({ k: 'repo.del', v: { id: repo.id } });
  }

  // -------------------------------------------------------------- refs

  refsOf(repoId: number): Map<string, string> {
    return this.refs.get(repoId) ?? new Map<string, string>();
  }

  getRef(repoId: number, name: string): string | undefined {
    return this.refs.get(repoId)?.get(name);
  }

  setRef(repoId: number, name: string, oid: string | null): void {
    if (oid !== null && !isOid(oid)) throw new StoreError(500, 'bad_oid', 'refusing to record a malformed object id');
    if (this.refs.get(repoId)?.get(name) === oid) return;
    if (oid === null && !this.refs.get(repoId)?.has(name)) return;
    this.persist({ k: 'ref', v: { repo_id: repoId, name, oid } });
  }

  // -------------------------------------------------------------- labels

  listLabels(repoId: number): LabelRecord[] {
    return [...(this.labels.get(repoId)?.values() ?? [])].sort((a, b) => a.id - b.id);
  }

  findLabel(repoId: number, name: string): LabelRecord | undefined {
    return this.labels.get(repoId)?.get(name);
  }

  createLabel(repoId: number, input: { name: string; color: string; description: string }): LabelRecord {
    if (this.findLabel(repoId, input.name)) throw new StoreError(422, 'already_exists', 'label already exists');
    const label: LabelRecord = { id: this.nextId(), repo_id: repoId, ...input };
    this.persist({ k: 'label', v: label });
    return label;
  }

  // -------------------------------------------------------------- issues and pulls

  allocateNumber(repoId: number): number {
    const next = (this.counters.get(repoId) ?? 0) + 1;
    this.counters.set(repoId, next);
    return next;
  }

  listIssueRecords(repoId: number): IssueRecord[] {
    return [...(this.issues.get(repoId)?.values() ?? [])].sort((a, b) => a.number - b.number);
  }

  issueByNumber(repoId: number, number: number): IssueRecord | undefined {
    return this.issues.get(repoId)?.get(number);
  }

  issueById(id: number): IssueRecord | undefined {
    return this.issuesById.get(id);
  }

  saveIssue(issue: IssueRecord): IssueRecord {
    this.persist({ k: 'issue', v: issue });
    return issue;
  }

  newIssue(input: Omit<IssueRecord, 'id' | 'number'>): IssueRecord {
    const issue: IssueRecord = { ...input, id: this.nextId(), number: this.allocateNumber(input.repo_id) };
    this.persist({ k: 'issue', v: issue });
    return issue;
  }

  // -------------------------------------------------------------- comments

  listComments(issueId: number): CommentRecord[] {
    return [...(this.comments.get(issueId) ?? [])];
  }

  commentById(id: number): CommentRecord | undefined {
    return this.commentsById.get(id);
  }

  countComments(issueId: number): number {
    return this.comments.get(issueId)?.length ?? 0;
  }

  addComment(input: Omit<CommentRecord, 'id'>): CommentRecord {
    const comment: CommentRecord = { id: this.nextId(), ...input };
    this.persist({ k: 'comment', v: comment });
    return comment;
  }
}
