// Graph and tree algorithms over an object lookup: ancestry, merge bases, path edits, three-way tree
// merges and the object closure a pack must carry. Pure functions of object ids, so a result never depends
// on request order or timing.

import { buildTree, isTreeMode, parseCommit, parseTree, type CommitView, type GitObject, type TreeEntry } from './objects.ts';

export interface ObjectLookup {
  get(oid: string): GitObject | undefined;
  put(object: GitObject): string;
}

export class GitOpError extends Error {
  readonly code: string;
  constructor(code: string, message: string) {
    super(message);
    this.code = code;
  }
}

export function requireObject(odb: ObjectLookup, oid: string, type?: string): GitObject {
  const object = odb.get(oid);
  if (object === undefined) throw new GitOpError('missing', `object ${oid} is not in this forge`);
  if (type !== undefined && object.type !== type) throw new GitOpError('type', `object ${oid} is a ${object.type}, not a ${type}`);
  return object;
}

// Commits are immutable and named by their id, so parsed commits and generation numbers are cached by id.
// The caches are bounded: past the bound they are dropped and rebuilt on demand.
const COMMIT_CACHE_LIMIT = 200_000;
const commitCache = new Map<string, CommitView>();
const generationCache = new Map<string, number>();

export function commitOf(odb: ObjectLookup, oid: string): CommitView {
  const cached = commitCache.get(oid);
  if (cached !== undefined) return cached;
  const view = parseCommit(requireObject(odb, oid, 'commit').data);
  if (commitCache.size >= COMMIT_CACHE_LIMIT) commitCache.clear();
  commitCache.set(oid, view);
  return view;
}

/** A commit's generation: 1 for a root, else one more than its highest parent. Strictly grows along history. */
export function generationOf(odb: ObjectLookup, oid: string): number {
  const known = generationCache.get(oid);
  if (known !== undefined) return known;
  // Iterative post-order walk, so a long history cannot exhaust the call stack.
  const stack: string[] = [oid];
  while (stack.length > 0) {
    const current = stack[stack.length - 1];
    if (generationCache.has(current)) {
      stack.pop();
      continue;
    }
    const parents = commitOf(odb, current).parents;
    const missing = parents.filter((parent) => !generationCache.has(parent));
    if (missing.length > 0) {
      for (const parent of missing) stack.push(parent);
      continue;
    }
    let highest = 0;
    for (const parent of parents) highest = Math.max(highest, generationCache.get(parent) ?? 0);
    if (generationCache.size >= COMMIT_CACHE_LIMIT) generationCache.clear();
    generationCache.set(current, highest + 1);
    stack.pop();
  }
  return generationCache.get(oid) ?? 1;
}

/** The commit a ref or object peels to (annotated tags are followed), or undefined if it is not a commit. */
export function peelToCommit(odb: ObjectLookup, oid: string): string | undefined {
  let current = oid;
  for (let depth = 0; depth < 8; depth += 1) {
    const object = odb.get(current);
    if (object === undefined) return undefined;
    if (object.type === 'commit') return current;
    if (object.type !== 'tag') return undefined;
    const target = /^object ([0-9a-f]{40})$/m.exec(object.data.toString('latin1'));
    if (!target) return undefined;
    current = target[1];
  }
  return undefined;
}

/** Every commit reachable from `tips`, stopping at (and excluding) anything in `stop`. */
export function commitsReachable(odb: ObjectLookup, tips: readonly string[], stop: ReadonlySet<string> = new Set()): Set<string> {
  const seen = new Set<string>();
  const queue = [...tips];
  while (queue.length > 0) {
    const oid = queue.pop() as string;
    if (seen.has(oid) || stop.has(oid)) continue;
    seen.add(oid);
    const commit = commitOf(odb, oid);
    for (const parent of commit.parents) queue.push(parent);
  }
  return seen;
}

/**
 * Whether `ancestor` is reachable from `descendant`. The walk prunes every commit whose generation is not
 * above the ancestor's: a commit cannot reach a commit of equal or higher generation, so history beyond the
 * ancestor is never read.
 */
export function isAncestor(odb: ObjectLookup, ancestor: string, descendant: string): boolean {
  if (ancestor === descendant) return true;
  const floor = generationOf(odb, ancestor);
  if (generationOf(odb, descendant) <= floor) return false;
  const seen = new Set<string>();
  const stack = [descendant];
  while (stack.length > 0) {
    const oid = stack.pop() as string;
    if (oid === ancestor) return true;
    if (seen.has(oid)) continue;
    seen.add(oid);
    if (generationOf(odb, oid) <= floor) continue;
    for (const parent of commitOf(odb, oid).parents) stack.push(parent);
  }
  return false;
}

/** The merge bases of two commits: the best common ancestors, none of which is an ancestor of another. */
export function mergeBases(odb: ObjectLookup, a: string, b: string): string[] {
  const fromA = commitsReachable(odb, [a]);
  const fromB = commitsReachable(odb, [b]);
  const common = [...fromA].filter((oid) => fromB.has(oid));
  const best: string[] = [];
  for (const candidate of common) {
    const dominated = common.some((other) => other !== candidate && isAncestorInSet(odb, candidate, other));
    if (!dominated) best.push(candidate);
  }
  return best;
}

function isAncestorInSet(odb: ObjectLookup, ancestor: string, descendant: string): boolean {
  return commitsReachable(odb, [descendant]).has(ancestor);
}

export function mergeBaseOne(odb: ObjectLookup, a: string, b: string): string | undefined {
  return mergeBases(odb, a, b)[0];
}

/** The entry at `path` in a tree, or undefined. */
export function lookupEntry(odb: ObjectLookup, treeOid: string, path: string): TreeEntry | undefined {
  const segments = path.split('/');
  let current = treeOid;
  for (let index = 0; index < segments.length; index += 1) {
    const entries = parseTree(requireObject(odb, current, 'tree').data);
    const found = entries.find((entry) => entry.name === segments[index]);
    if (found === undefined) return undefined;
    if (index === segments.length - 1) return found;
    if (!isTreeMode(found.mode)) return undefined;
    current = found.oid;
  }
  return undefined;
}

/** Every blob-like entry of a tree, keyed by full path. Trees themselves are not included. */
export function flattenTree(odb: ObjectLookup, treeOid: string, prefix = '', into = new Map<string, { mode: string; oid: string }>()): Map<string, { mode: string; oid: string }> {
  for (const entry of parseTree(requireObject(odb, treeOid, 'tree').data)) {
    const path = prefix + entry.name;
    if (isTreeMode(entry.mode)) flattenTree(odb, entry.oid, `${path}/`, into);
    else into.set(path, { mode: entry.mode, oid: entry.oid });
  }
  return into;
}

/**
 * Set one path in a tree (or remove it when `entry` is null) and return the new root tree id, or null when
 * the result is empty. Intermediate directories are created and emptied ones pruned. Throws on a path that
 * runs through a file or names a directory.
 */
export function editPath(odb: ObjectLookup, rootTree: string | null, path: string, entry: { mode: string; oid: string } | null): string | null {
  const segments = path.split('/');
  return editLevel(odb, rootTree, segments, 0, entry);
}

function editLevel(odb: ObjectLookup, treeOid: string | null, segments: string[], index: number, entry: { mode: string; oid: string } | null): string | null {
  const entries = treeOid === null ? [] : parseTree(requireObject(odb, treeOid, 'tree').data);
  const name = segments[index];
  const at = entries.findIndex((item) => item.name === name);
  if (index === segments.length - 1) {
    if (entry === null) {
      if (at < 0) return treeOid;
      entries.splice(at, 1);
    } else if (at >= 0) {
      if (isTreeMode(entries[at].mode)) throw new GitOpError('is-directory', `${segments.join('/')} is a directory`);
      entries[at] = { mode: entry.mode, name, oid: entry.oid };
    } else {
      entries.push({ mode: entry.mode, name, oid: entry.oid });
    }
  } else {
    const child = at >= 0 ? entries[at] : undefined;
    if (child !== undefined && !isTreeMode(child.mode)) {
      if (entry === null) return treeOid;
      throw new GitOpError('file-in-path', `${segments.slice(0, index + 1).join('/')} is a file`);
    }
    if (child === undefined && entry === null) return treeOid;
    const next = editLevel(odb, child?.oid ?? null, segments, index + 1, entry);
    if (next === null) {
      if (at >= 0) entries.splice(at, 1);
    } else if (at >= 0) {
      entries[at] = { mode: '40000', name, oid: next };
    } else {
      entries.push({ mode: '40000', name, oid: next });
    }
  }
  if (entries.length === 0) return null;
  return odb.put({ type: 'tree', data: buildTree(entries) });
}

export type MergeResult = { tree: string | null } | { conflicts: string[] };

/**
 * Three-way merge of trees at entry granularity: an entry changed on one side only takes that side's
 * version; an entry changed the same way on both sides agrees; a directory changed on both sides merges
 * recursively; anything else is a conflict and is named by path.
 */
export function mergeTrees(odb: ObjectLookup, base: string | null, ours: string | null, theirs: string | null): MergeResult {
  const conflicts: string[] = [];
  const tree = mergeLevel(odb, base, ours, theirs, '', conflicts);
  if (conflicts.length > 0) return { conflicts };
  return { tree };
}

function entryMap(odb: ObjectLookup, treeOid: string | null): Map<string, TreeEntry> {
  const map = new Map<string, TreeEntry>();
  if (treeOid === null) return map;
  for (const entry of parseTree(requireObject(odb, treeOid, 'tree').data)) map.set(entry.name, entry);
  return map;
}

function same(a: TreeEntry | undefined, b: TreeEntry | undefined): boolean {
  if (a === undefined || b === undefined) return a === b;
  return a.oid === b.oid && a.mode === b.mode;
}

function mergeLevel(odb: ObjectLookup, base: string | null, ours: string | null, theirs: string | null, prefix: string, conflicts: string[]): string | null {
  if (ours === theirs) return ours;
  if (base === ours) return theirs;
  if (base === theirs) return ours;
  const b = entryMap(odb, base);
  const o = entryMap(odb, ours);
  const t = entryMap(odb, theirs);
  const names = new Set<string>([...b.keys(), ...o.keys(), ...t.keys()]);
  const out: TreeEntry[] = [];
  for (const name of [...names].sort()) {
    const be = b.get(name);
    const oe = o.get(name);
    const te = t.get(name);
    let chosen: TreeEntry | undefined;
    if (same(oe, te)) chosen = oe;
    else if (same(be, oe)) chosen = te;
    else if (same(be, te)) chosen = oe;
    else if (oe !== undefined && te !== undefined && isTreeMode(oe.mode) && isTreeMode(te.mode) && (be === undefined || isTreeMode(be.mode))) {
      const merged = mergeLevel(odb, be?.oid ?? null, oe.oid, te.oid, `${prefix}${name}/`, conflicts);
      if (merged !== null) chosen = { mode: '40000', name, oid: merged };
    } else {
      conflicts.push(`${prefix}${name}`);
    }
    if (chosen !== undefined) out.push(chosen);
  }
  if (conflicts.length > 0) return null;
  if (out.length === 0) return null;
  return odb.put({ type: 'tree', data: buildTree(out) });
}

/**
 * Add every object reachable from a tree to `into`, leaving out whole subtrees whose id is in `skip`
 * (a tree id names its contents, so a skipped id is already held on the other side).
 */
export function collectTreeObjects(odb: ObjectLookup, treeOid: string, skip: ReadonlySet<string>, into: Set<string>): void {
  if (skip.has(treeOid) || into.has(treeOid)) return;
  into.add(treeOid);
  for (const entry of parseTree(requireObject(odb, treeOid, 'tree').data)) {
    if (isTreeMode(entry.mode)) {
      collectTreeObjects(odb, entry.oid, skip, into);
    } else if (!skip.has(entry.oid)) {
      into.add(entry.oid);
    }
  }
}

/** Every object id reachable from the given commits' trees (commits and trees, not blobs' contents). */
export function treeClosureOfCommits(odb: ObjectLookup, commits: Iterable<string>): Set<string> {
  const out = new Set<string>();
  for (const commit of commits) {
    const view = commitOf(odb, commit);
    collectTreeObjects(odb, view.tree, new Set(), out);
  }
  return out;
}

/** Walk the first-parent-agnostic history newest first (by committer time, then id). */
export function logOrder(odb: ObjectLookup, tip: string, limit: number): string[] {
  const reachable = [...commitsReachable(odb, [tip])];
  reachable.sort((a, b) => {
    const ta = commitOf(odb, a).committerTime;
    const tb = commitOf(odb, b).committerTime;
    if (ta !== tb) return tb - ta;
    return a < b ? -1 : a > b ? 1 : 0;
  });
  return reachable.slice(0, limit);
}

export function validRefName(name: string): boolean {
  if (name.length === 0 || name.length > 255) return false;
  if (!name.startsWith('refs/')) return false;
  if (/[\u0000- \u007f~^:?*[\\]/.test(name)) return false;
  if (name.includes('..') || name.includes('@{') || name === '@') return false;
  if (name.endsWith('/') || name.endsWith('.') || name.endsWith('.lock')) return false;
  for (const part of name.split('/')) {
    if (part === '' || part.startsWith('.')) return false;
  }
  return true;
}

