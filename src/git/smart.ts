// Git smart HTTP, server side: upload-pack (protocol v2, and v0 for clients that ask for it) and
// receive-pack (v0). The server never shells out: it reads and writes the forge's own object database and
// refs. Pack files it sends carry whole objects only (no deltas), which every client accepts.

import { DELIM, FLUSH, lineOf, parsePkts, pkt, sideband, type Pkt } from './pkt.ts';
import { GitOpError, collectTreeObjects, commitOf, commitsReachable, isAncestor, peelToCommit, requireObject, validRefName, type ObjectLookup } from './ops.ts';
import { ObjectError, ZERO_OID, isOid, parseTag, readPack, writePack, type GitObject } from './objects.ts';
import type { RepoRecord, Store } from '../store/store.ts';

export const AGENT = 'makefun-forge/1.0';

export class SmartError extends Error {
  readonly status: number;
  constructor(status: number, message: string) {
    super(message);
    this.status = status;
  }
}

/** The refs a repository advertises: HEAD (when resolvable), then every stored ref, sorted by name. */
interface RefView {
  readonly name: string;
  readonly oid: string;
  readonly peeled: string | null;
}

function refsOf(store: Store, repo: RepoRecord, odb: ObjectLookup): RefView[] {
  const out: RefView[] = [];
  const names = [...store.refsOf(repo.id).keys()].sort();
  for (const name of names) {
    const oid = store.getRef(repo.id, name);
    if (oid === undefined) continue;
    const object = odb.get(oid);
    if (object === undefined) continue;
    let peeled: string | null = null;
    if (object.type === 'tag') {
      peeled = peelToCommit(odb, oid) ?? null;
    }
    out.push({ name, oid, peeled });
  }
  return out;
}

function headOid(store: Store, repo: RepoRecord): string | undefined {
  return store.getRef(repo.id, `refs/heads/${repo.default_branch}`);
}

/** The line-level advertisement for protocol v0 upload-pack or receive-pack (after the service preamble). */
export function advertiseV0(store: Store, repo: RepoRecord, odb: ObjectLookup, service: 'upload-pack' | 'receive-pack'): Buffer {
  const parts: Buffer[] = [pkt(`# service=git-${service}\n`), FLUSH];
  const refs = refsOf(store, repo, odb);
  const head = headOid(store, repo);
  const caps =
    service === 'upload-pack'
      ? ['multi_ack', 'thin-pack', 'side-band', 'side-band-64k', 'ofs-delta', 'shallow', 'no-progress', 'include-tag', 'multi_ack_detailed']
      : ['report-status', 'delete-refs', 'side-band-64k', 'quiet', 'ofs-delta'];
  if (service === 'upload-pack' && head !== undefined) caps.push(`symref=HEAD:refs/heads/${repo.default_branch}`);
  caps.push(`agent=${AGENT}`);
  const capText = caps.join(' ');

  const lines: Array<{ oid: string; name: string }> = [];
  if (head !== undefined && service === 'upload-pack') lines.push({ oid: head, name: 'HEAD' });
  for (const ref of refs) lines.push({ oid: ref.oid, name: ref.name });
  if (lines.length === 0) {
    parts.push(pkt(`${ZERO_OID} capabilities^{}\0${capText}\n`));
  } else {
    lines.forEach((line, index) => {
      const text = index === 0 ? `${line.oid} ${line.name}\0${capText}\n` : `${line.oid} ${line.name}\n`;
      parts.push(pkt(text));
    });
    for (const ref of refs) {
      if (ref.peeled !== null) parts.push(pkt(`${ref.peeled} ${ref.name}^{}\n`));
    }
  }
  parts.push(FLUSH);
  return Buffer.concat(parts);
}

/** The protocol v2 capability advertisement (no service preamble: v2 begins with "version 2"). */
export function advertiseV2(): Buffer {
  return Buffer.concat([
    pkt('version 2\n'),
    pkt(`agent=${AGENT}\n`),
    pkt('ls-refs=unborn\n'),
    pkt('fetch=shallow\n'),
    pkt('server-option\n'),
    pkt('object-format=sha1\n'),
    FLUSH,
  ]);
}

// ---------------------------------------------------------------- upload-pack: request parsing

interface FetchArgs {
  wants: string[];
  haves: string[];
  shallow: string[];
  depth: number | null;
  done: boolean;
  noProgress: boolean;
}

function parseFetchArgs(lines: Pkt[]): FetchArgs {
  const args: FetchArgs = { wants: [], haves: [], shallow: [], depth: null, done: false, noProgress: false };
  for (const packet of lines) {
    const line = lineOf(packet);
    if (line === null) continue;
    if (line.startsWith('want ')) {
      const oid = line.slice(5, 45);
      if (!isOid(oid)) throw new SmartError(400, 'malformed want line');
      args.wants.push(oid);
    } else if (line.startsWith('have ')) {
      const oid = line.slice(5, 45);
      if (!isOid(oid)) throw new SmartError(400, 'malformed have line');
      args.haves.push(oid);
    } else if (line.startsWith('shallow ')) {
      const oid = line.slice(8, 48);
      if (!isOid(oid)) throw new SmartError(400, 'malformed shallow line');
      args.shallow.push(oid);
    } else if (line.startsWith('deepen ')) {
      const depth = Number(line.slice(7));
      if (!Number.isInteger(depth) || depth < 1 || depth > 100000) throw new SmartError(400, 'malformed deepen line');
      args.depth = depth;
    } else if (line === 'done') {
      args.done = true;
    } else if (line === 'no-progress') {
      args.noProgress = true;
    }
    // Other arguments (thin-pack, ofs-delta, include-tag, deepen-since, filter...) are accepted and ignored:
    // every pack we send is self-contained, so none of them changes the bytes.
  }
  return args;
}

interface Selection {
  /** Commits and objects to send, by id. */
  objects: Set<string>;
  /** Commits that are now shallow boundaries in the client's view. */
  shallow: string[];
  /** Client shallow commits that now have their parents. */
  unshallow: string[];
}

/**
 * Work out what to send. Without a depth: the commits reachable from the wants and not from the haves,
 * and every object of those commits that the haves' trees do not already hold. With a depth: only the
 * commits within `depth` generations of the wants, and boundary commits are reported as shallow.
 */
function selectObjects(odb: ObjectLookup, wants: readonly string[], haves: readonly string[], shallowIn: readonly string[], depth: number | null): Selection {
  // Wants may name annotated tags: the walk starts from the commits they peel to.
  const wantCommits = [...new Set(wants.map((oid) => peelToCommit(odb, oid)).filter((oid): oid is string => oid !== undefined))];
  const haveCommits = [...new Set(haves.filter((oid) => odb.get(oid)?.type === 'commit'))];

  let commits: Set<string>;
  let skip: Set<string>;
  const shallow: string[] = [];
  const unshallow: string[] = [];
  if (depth === null) {
    // The client holds every commit its haves reach, with their trees: send what those do not reach.
    const held = commitsReachable(odb, haveCommits);
    commits = commitsReachable(odb, wantCommits, held);
    skip = treeOfCommits(odb, held);
  } else {
    // A shallow client holds only the commits it names (its boundaries have no parents on its side), so the
    // depth is counted from the wants and nothing reached through the haves is subtracted.
    const level = new Map<string, number>();
    let frontier = [...new Set(wantCommits)];
    for (const oid of frontier) level.set(oid, 1);
    const boundary = new Set<string>();
    for (let generation = 1; frontier.length > 0; generation += 1) {
      const next: string[] = [];
      for (const oid of frontier) {
        const parents = commitOf(odb, oid).parents;
        if (generation >= depth) {
          if (parents.length > 0) boundary.add(oid);
          continue;
        }
        for (const parent of parents) {
          if (!level.has(parent)) {
            level.set(parent, generation + 1);
            next.push(parent);
          }
        }
      }
      frontier = next;
    }
    commits = new Set(level.keys());
    skip = treeOfCommits(odb, haveCommits);
    for (const oid of boundary) shallow.push(oid);
    for (const oid of new Set(shallowIn)) if (level.has(oid) && !boundary.has(oid)) unshallow.push(oid);
  }

  const objects = new Set<string>(commits);
  for (const commit of commits) {
    const tree = commitOf(odb, commit).tree;
    collectTreeObjects(odb, tree, skip, objects);
  }
  // Annotated tags requested directly travel with their chain of tag objects.
  for (const want of wants) {
    let current = want;
    for (let hop = 0; hop < 8; hop += 1) {
      const object = odb.get(current);
      if (object?.type !== 'tag') break;
      objects.add(current);
      current = parseTag(object.data).object;
    }
  }
  return { objects, shallow, unshallow };
}

/** The tree ids of a set of commits, as a skip set: subtrees the other side already holds. */
function treeOfCommits(odb: ObjectLookup, commits: Iterable<string>): Set<string> {
  const trees = new Set<string>();
  for (const commit of commits) {
    const object = odb.get(commit);
    if (object?.type !== 'commit') continue;
    const tree = commitOf(odb, commit).tree;
    collectTreeObjects(odb, tree, new Set(), trees);
  }
  return trees;
}

function packFor(odb: ObjectLookup, objects: Iterable<string>): Buffer {
  const list: GitObject[] = [];
  for (const oid of objects) list.push(requireObject(odb, oid));
  return writePack(list);
}

/** Protocol v2 `command=ls-refs`. */
function lsRefs(store: Store, repo: RepoRecord, odb: ObjectLookup, lines: Pkt[]): Buffer {
  let peel = false;
  let symrefs = false;
  let unborn = false;
  const prefixes: string[] = [];
  for (const packet of lines) {
    const line = lineOf(packet);
    if (line === null) continue;
    if (line === 'peel') peel = true;
    else if (line === 'symrefs') symrefs = true;
    else if (line === 'unborn') unborn = true;
    else if (line.startsWith('ref-prefix ')) prefixes.push(line.slice('ref-prefix '.length));
  }
  const keep = (name: string): boolean => prefixes.length === 0 || prefixes.some((prefix) => name.startsWith(prefix));
  const parts: Buffer[] = [];
  const head = headOid(store, repo);
  const headTarget = `refs/heads/${repo.default_branch}`;
  if (keep('HEAD')) {
    if (head !== undefined) {
      const suffix = symrefs ? ` symref-target:${headTarget}` : '';
      parts.push(pkt(`${head} HEAD${suffix}\n`));
    } else if (unborn) {
      parts.push(pkt(`unborn HEAD symref-target:${headTarget}\n`));
    }
  }
  for (const ref of refsOf(store, repo, odb)) {
    if (!keep(ref.name)) continue;
    const peeledText = peel && ref.peeled !== null ? ` peeled:${ref.peeled}` : '';
    parts.push(pkt(`${ref.oid} ${ref.name}${peeledText}\n`));
  }
  parts.push(FLUSH);
  return Buffer.concat(parts);
}

/** Protocol v2 `command=fetch`. */
function fetchV2(odb: ObjectLookup, body: Pkt[]): Buffer {
  // body: command line, capabilities, delim, arguments, flush.
  const delimAt = body.findIndex((packet) => packet.kind === 'delim');
  const args = parseFetchArgs(delimAt < 0 ? [] : body.slice(delimAt + 1));
  const parts: Buffer[] = [];
  for (const want of args.wants) {
    if (odb.get(want) === undefined) return pkt(`ERR upload-pack: not our ref ${want}\n`);
  }
  if (args.wants.length === 0) return FLUSH;

  const wantsSet = [...new Set(args.wants)];
  const haveCommits = args.haves.filter((oid) => odb.get(oid)?.type === 'commit');
  if (!args.done) {
    parts.push(pkt('acknowledgments\n'));
    if (haveCommits.length === 0) {
      parts.push(pkt('NAK\n'), FLUSH);
      return Buffer.concat(parts);
    }
    for (const oid of haveCommits) parts.push(pkt(`ACK ${oid}\n`));
    parts.push(pkt('ready\n'), DELIM);
  }

  const selection = selectObjects(odb, wantsSet, args.haves, args.shallow, args.depth);
  if (args.depth !== null || args.shallow.length > 0) {
    parts.push(pkt('shallow-info\n'));
    for (const oid of selection.shallow) parts.push(pkt(`shallow ${oid}\n`));
    for (const oid of selection.unshallow) parts.push(pkt(`unshallow ${oid}\n`));
    parts.push(DELIM);
  }
  parts.push(pkt('packfile\n'));
  parts.push(...sideband(1, packFor(odb, selection.objects)));
  parts.push(FLUSH);
  return Buffer.concat(parts);
}

/** Protocol v2 entry point: one command per request. */
export function uploadPackV2(store: Store, repo: RepoRecord, body: Buffer): Buffer {
  const odb = store.objects;
  const packets = parsePkts(body);
  const first = lineOf(packets[0] ?? { kind: 'flush' });
  if (first === null || !first.startsWith('command=')) throw new SmartError(400, 'expected a command=');
  const command = first.slice('command='.length);
  if (command === 'ls-refs') {
    const delimAt = packets.findIndex((packet) => packet.kind === 'delim');
    return lsRefs(store, repo, odb, delimAt < 0 ? [] : packets.slice(delimAt + 1));
  }
  if (command === 'fetch') return fetchV2(odb, packets);
  throw new SmartError(400, `unknown command ${JSON.stringify(command)}`);
}

/** Protocol v0 upload-pack (stateless POST): wants and shallow lines, a flush, then haves and done. */
export function uploadPackV0(store: Store, repo: RepoRecord, body: Buffer): Buffer {
  const odb = store.objects;
  const packets = parsePkts(body);
  const flushAt = packets.findIndex((packet) => packet.kind === 'flush');
  const wantPart = flushAt < 0 ? packets : packets.slice(0, flushAt);
  const negotiation = flushAt < 0 ? [] : packets.slice(flushAt + 1);
  const args = parseFetchArgs([...wantPart, ...negotiation]);
  const parts: Buffer[] = [];
  for (const want of args.wants) {
    if (odb.get(want) === undefined) return pkt(`ERR upload-pack: not our ref ${want}\n`);
  }
  if (args.wants.length === 0) return Buffer.alloc(0);
  const selection = selectObjects(odb, [...new Set(args.wants)], args.haves, args.shallow, args.depth);
  for (const oid of selection.shallow) parts.push(pkt(`shallow ${oid}\n`));
  for (const oid of selection.unshallow) parts.push(pkt(`unshallow ${oid}\n`));
  const common = args.haves.filter((oid) => odb.get(oid)?.type === 'commit');
  if (args.done) {
    parts.push(pkt(common.length > 0 ? `ACK ${common[common.length - 1]}\n` : 'NAK\n'));
  } else {
    for (const oid of common) parts.push(pkt(`ACK ${oid} common\n`));
    parts.push(pkt('NAK\n'));
  }
  parts.push(...sideband(1, packFor(odb, selection.objects)));
  parts.push(FLUSH);
  return Buffer.concat(parts);
}

// ---------------------------------------------------------------- receive-pack

interface Command {
  oldOid: string;
  newOid: string;
  ref: string;
}

/** A receive-pack v0 request: commands with capabilities on the first, a flush, then the pack. */
export function receivePack(store: Store, repo: RepoRecord, body: Buffer): Buffer {
  const odb = store.objects;
  let pos = 0;
  const commands: Command[] = [];
  let sideBand = false;
  let reportStatus = false;
  // Parse the command list one pkt-line at a time: the pack that follows the flush is raw bytes.
  for (;;) {
    if (pos + 4 > body.length) throw new SmartError(400, 'receive-pack body ends inside its command list');
    const length = parseInt(body.toString('latin1', pos, pos + 4), 16);
    if (!Number.isFinite(length) || length < 0) throw new SmartError(400, 'malformed pkt-line in receive-pack');
    if (length === 0) {
      pos += 4;
      break;
    }
    if (length < 4 || pos + length > body.length) throw new SmartError(400, 'malformed command pkt-line');
    let line = body.toString('utf8', pos + 4, pos + length).replace(/\n$/, '');
    pos += length;
    const nul = line.indexOf('\0');
    if (nul >= 0) {
      const caps = line.slice(nul + 1).split(' ');
      sideBand = caps.includes('side-band-64k');
      reportStatus = caps.includes('report-status') || caps.includes('report-status-v2');
      line = line.slice(0, nul);
    }
    const parts = line.split(' ');
    if (parts.length !== 3 || !isOid(parts[0]) || !isOid(parts[1])) throw new SmartError(400, 'malformed command');
    commands.push({ oldOid: parts[0], newOid: parts[1], ref: parts[2] });
  }
  const packBytes = body.subarray(pos);
  const reasons = new Map<string, string>();
  let unpackError: string | null = null;

  if (commands.some((command) => command.newOid !== ZERO_OID) && packBytes.length > 0) {
    try {
      const objects = readPack(packBytes, (oid) => odb.get(oid));
      for (const [oid, object] of objects) odb.store(oid, object);
    } catch (err) {
      unpackError = err instanceof Error ? err.message : 'unpack failed';
    }
  } else if (commands.some((command) => command.newOid !== ZERO_OID)) {
    unpackError = 'pack missing';
  }

  const refs: Array<{ ref: string; ok: boolean; reason: string }> = [];
  const applied: Array<{ ref: string; oid: string | null }> = [];
  if (unpackError !== null) {
    for (const command of commands) refs.push({ ref: command.ref, ok: false, reason: 'unpacker error' });
  } else {
    // Commits the forge already holds whole need no connectivity walk.
    const known = knownCommits(store, repo);
    for (const command of commands) {
      const verdict = checkCommand(store, repo, odb, command, known);
      if (verdict !== 'ok') {
        refs.push({ ref: command.ref, ok: false, reason: verdict });
        continue;
      }
      refs.push({ ref: command.ref, ok: true, reason: '' });
      applied.push({ ref: command.ref, oid: command.newOid === ZERO_OID ? null : command.newOid });
    }
  }
  for (const [ref, reason] of reasons) refs.push({ ref, ok: false, reason });

  for (const change of applied) {
    store.setRef(repo.id, change.ref, change.oid);
    if (change.oid !== null) {
      const tip = peelToCommit(odb, change.oid);
      if (tip !== undefined) for (const oid of commitsReachable(odb, [tip], knownCommits(store, repo))) knownCommits(store, repo).add(oid);
    }
  }
  if (applied.length > 0) store.touchRepo(repo, true);

  if (!reportStatus) return Buffer.alloc(0);
  const report: Buffer[] = [pkt(`unpack ${unpackError === null ? 'ok' : unpackError}\n`)];
  for (const item of refs) report.push(pkt(item.ok ? `ok ${item.ref}\n` : `ng ${item.ref} ${item.reason}\n`));
  report.push(FLUSH);
  const inner = Buffer.concat(report);
  if (!sideBand) return inner;
  return Buffer.concat([...sideband(1, inner), FLUSH]);
}

/**
 * Per store and repository: the commits known to be whole (reachable from its refs when first asked, then
 * every accepted tip). Keyed by store so two stores in one process never share a set.
 */
const knownByStore = new WeakMap<Store, Map<number, Set<string>>>();

function knownCommits(store: Store, repo: RepoRecord): Set<string> {
  let byRepo = knownByStore.get(store);
  if (byRepo === undefined) {
    byRepo = new Map<number, Set<string>>();
    knownByStore.set(store, byRepo);
  }
  let known = byRepo.get(repo.id);
  if (known === undefined) {
    const tips: string[] = [];
    for (const oid of store.refsOf(repo.id).values()) {
      const commit = peelToCommit(store.objects, oid);
      if (commit !== undefined) tips.push(commit);
    }
    known = commitsReachable(store.objects, tips);
    byRepo.set(repo.id, known);
  }
  return known;
}

function checkCommand(store: Store, repo: RepoRecord, odb: ObjectLookup, command: Command, known: Set<string>): string {
  if (!validRefName(command.ref)) return 'invalid ref name';
  const current = store.getRef(repo.id, command.ref);
  const currentOid = current ?? ZERO_OID;
  if (command.oldOid !== currentOid) return 'stale info';
  if (command.newOid === ZERO_OID) return 'ok';
  if (command.ref.startsWith('refs/heads/') && odb.get(command.newOid)?.type !== 'commit') return 'not a commit';

  // Connectivity: every commit the new tip reaches must be present, and so must its trees.
  const missing = connectivityMissing(odb, command.newOid, known);
  if (missing) return 'missing necessary objects';

  if (command.oldOid !== ZERO_OID) {
    const newCommit = peelToCommit(odb, command.newOid);
    const oldCommit = peelToCommit(odb, command.oldOid);
    if (newCommit === undefined || oldCommit === undefined) return 'non-fast-forward';
    if (!isAncestor(odb, oldCommit, newCommit)) return 'non-fast-forward';
  }
  return 'ok';
}

/** True when a commit reached from `tip` (and not already known) is missing or its tree is absent. */
function connectivityMissing(odb: ObjectLookup, tip: string, known: Set<string>): boolean {
  const object = odb.get(tip);
  if (object === undefined) return true;
  if (object.type === 'tag') return false;
  if (object.type !== 'commit') return false;
  const seen = new Set<string>();
  const queue = [tip];
  while (queue.length > 0) {
    const oid = queue.pop() as string;
    if (seen.has(oid) || known.has(oid)) continue;
    seen.add(oid);
    const commit = odb.get(oid);
    if (commit === undefined || commit.type !== 'commit') return true;
    let view;
    try {
      view = commitOf(odb, oid);
    } catch (err) {
      if (err instanceof ObjectError || err instanceof GitOpError) return true;
      throw err;
    }
    if (odb.get(view.tree)?.type !== 'tree') return true;
    for (const parent of view.parents) queue.push(parent);
  }
  return false;
}

