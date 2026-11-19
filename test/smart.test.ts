import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Store } from '../src/store/store.ts';
import { createRepository } from '../src/api/service.ts';
import { DELIM, FLUSH, parsePkts, pkt, type Pkt } from '../src/git/pkt.ts';
import { ZERO_OID, buildCommit, buildTree, hashObject, readPack, writePack, type GitObject, parseCommit } from '../src/git/objects.ts';
import { advertiseV0, advertiseV2, receivePack, uploadPackV0, uploadPackV2 } from '../src/git/smart.ts';

interface Harness {
  readonly store: Store;
  readonly repo: ReturnType<typeof createRepository>;
  readonly dir: string;
}

function harness(): Harness {
  const dir = mkdtempSync(join(tmpdir(), 'forge-smart-'));
  const store = new Store(dir);
  store.bindLogin('ada');
  const repo = createRepository(store, { name: 'proto', description: '', private: true, defaultBranch: 'main', autoInit: false });
  return { store, repo, dir };
}

const who = { name: 'Ada', email: 'ada@example.invalid', when: 1_700_000_000, tz: '+0000' };

/** Build a commit (and its blob and tree) as plain objects, so tests can push exact bytes. */
function makeCommit(files: Record<string, string>, parents: string[], message: string, when: number): { oid: string; objects: GitObject[] } {
  const objects: GitObject[] = [];
  const entries = Object.entries(files).map(([name, text]) => {
    const data = Buffer.from(text);
    objects.push({ type: 'blob', data });
    return { mode: '100644', name, oid: hashObject('blob', data) };
  });
  const tree = buildTree(entries);
  objects.push({ type: 'tree', data: tree });
  const commit = buildCommit({ tree: hashObject('tree', tree), parents, author: { ...who, when }, committer: { ...who, when }, message });
  objects.push({ type: 'commit', data: commit });
  return { oid: hashObject('commit', commit), objects };
}

/** A receive-pack request body: commands (first one carries the capabilities), a flush, then the pack. */
function pushBody(commands: Array<[string, string, string]>, objects: GitObject[], capabilities = 'report-status side-band-64k'): Buffer {
  const lines: Buffer[] = commands.map(([oldOid, newOid, ref], index) =>
    pkt(index === 0 ? `${oldOid} ${newOid} ${ref}\0${capabilities}\n` : `${oldOid} ${newOid} ${ref}\n`),
  );
  lines.push(FLUSH);
  const hasWrites = commands.some(([, newOid]) => newOid !== ZERO_OID);
  const pack = hasWrites ? writePack(objects) : Buffer.alloc(0);
  return Buffer.concat([...lines, pack]);
}

/** The report lines a receive-pack answer carries, with side-band framing removed. */
function reportLines(answer: Buffer): string[] {
  const packets = parsePkts(answer);
  const inner = packets.filter((packet): packet is Extract<Pkt, { kind: 'data' }> => packet.kind === 'data').map((packet) => packet.data.subarray(1));
  return parsePkts(Buffer.concat(inner))
    .filter((packet): packet is Extract<Pkt, { kind: 'data' }> => packet.kind === 'data')
    .map((packet) => packet.data.toString('utf8').replace(/\n$/, ''));
}

test('the v0 advertisement carries the capabilities a client needs and the preamble', () => {
  const { store, repo, dir } = harness();
  try {
    const receive = advertiseV0(store, repo, store.objects, 'receive-pack').toString('latin1');
    assert.ok(receive.startsWith('001f# service=git-receive-pack\n0000'));
    assert.ok(receive.includes('capabilities^{}'));
    assert.ok(receive.includes('report-status'));
    assert.ok(receive.includes('side-band-64k'));
    assert.ok(receive.includes('delete-refs'));
    const v2 = advertiseV2().toString('latin1');
    assert.ok(v2.includes('version 2'));
    assert.ok(v2.includes('ls-refs=unborn'));
    assert.ok(v2.includes('fetch=shallow'));
  } finally {
    store.sync();
    rmSync(dir, { recursive: true, force: true });
  }
});

test('a fast-forward push moves the branch; a non-fast-forward is refused and changes nothing', () => {
  const { store, repo, dir } = harness();
  try {
    const first = makeCommit({ 'a.txt': 'one' }, [], 'first', 1);
    const answer1 = receivePack(store, repo, pushBody([[ZERO_OID, first.oid, 'refs/heads/main']], first.objects));
    assert.deepEqual(reportLines(answer1), ['unpack ok', 'ok refs/heads/main']);
    assert.equal(store.getRef(repo.id, 'refs/heads/main'), first.oid);

    const second = makeCommit({ 'a.txt': 'two' }, [first.oid], 'second', 2);
    const ff = receivePack(store, repo, pushBody([[first.oid, second.oid, 'refs/heads/main']], second.objects));
    assert.deepEqual(reportLines(ff), ['unpack ok', 'ok refs/heads/main']);

    // A sibling of the current tip: its parent is the old tip's parent, so the update is not a fast-forward.
    const sibling = makeCommit({ 'a.txt': 'rewritten' }, [first.oid], 'rewrite', 3);
    const refused = receivePack(store, repo, pushBody([[second.oid, sibling.oid, 'refs/heads/main']], sibling.objects));
    assert.deepEqual(reportLines(refused), ['unpack ok', 'ng refs/heads/main non-fast-forward']);
    assert.equal(store.getRef(repo.id, 'refs/heads/main'), second.oid);
  } finally {
    store.sync();
    rmSync(dir, { recursive: true, force: true });
  }
});

test('one push with a fast-forward and a refused ref applies the first and reports both', () => {
  const { store, repo, dir } = harness();
  try {
    const base = makeCommit({ 'x': '1' }, [], 'base', 1);
    receivePack(store, repo, pushBody([[ZERO_OID, base.oid, 'refs/heads/main']], base.objects));
    receivePack(store, repo, pushBody([[ZERO_OID, base.oid, 'refs/heads/side']], []));
    const advance = makeCommit({ 'x': '2' }, [base.oid], 'advance', 2);
    const sideRewrite = makeCommit({ 'y': 'other' }, [], 'unrelated', 3);
    const answer = receivePack(
      store,
      repo,
      pushBody(
        [
          [base.oid, advance.oid, 'refs/heads/main'],
          [base.oid, sideRewrite.oid, 'refs/heads/side'],
        ],
        [...advance.objects, ...sideRewrite.objects],
      ),
    );
    assert.deepEqual(reportLines(answer), ['unpack ok', 'ok refs/heads/main', 'ng refs/heads/side non-fast-forward']);
    assert.equal(store.getRef(repo.id, 'refs/heads/main'), advance.oid);
    assert.equal(store.getRef(repo.id, 'refs/heads/side'), base.oid);
  } finally {
    store.sync();
    rmSync(dir, { recursive: true, force: true });
  }
});

test('a push naming a stale old value, an invalid ref or a missing parent is refused per ref', () => {
  const { store, repo, dir } = harness();
  try {
    const base = makeCommit({ f: 'a' }, [], 'base', 1);
    receivePack(store, repo, pushBody([[ZERO_OID, base.oid, 'refs/heads/main']], base.objects));
    const next = makeCommit({ f: 'b' }, [base.oid], 'next', 2);
    const stale = receivePack(store, repo, pushBody([[ZERO_OID, next.oid, 'refs/heads/main']], next.objects));
    assert.deepEqual(reportLines(stale), ['unpack ok', 'ng refs/heads/main stale info']);
    const bad = receivePack(store, repo, pushBody([[ZERO_OID, base.oid, 'refs/heads/bad..name']], []));
    assert.deepEqual(reportLines(bad), ['unpack ok', 'ng refs/heads/bad..name invalid ref name']);
    const orphan = makeCommit({ f: 'orphan' }, ['1'.repeat(40)], 'orphan', 5);
    const missing = receivePack(store, repo, pushBody([[base.oid, orphan.oid, 'refs/heads/main']], [orphan.objects[0], orphan.objects[1], orphan.objects[2]]));
    assert.deepEqual(reportLines(missing), ['unpack ok', 'ng refs/heads/main missing necessary objects']);
  } finally {
    store.sync();
    rmSync(dir, { recursive: true, force: true });
  }
});

test('a delete removes the ref and is reported', () => {
  const { store, repo, dir } = harness();
  try {
    const base = makeCommit({ f: 'a' }, [], 'base', 1);
    receivePack(store, repo, pushBody([[ZERO_OID, base.oid, 'refs/tags/v1']], base.objects));
    const deleted = receivePack(store, repo, pushBody([[base.oid, ZERO_OID, 'refs/tags/v1']], []));
    assert.deepEqual(reportLines(deleted), ['unpack ok', 'ok refs/tags/v1']);
    assert.equal(store.getRef(repo.id, 'refs/tags/v1'), undefined);
  } finally {
    store.sync();
    rmSync(dir, { recursive: true, force: true });
  }
});

/** Find the object bytes a fetch answer carries in its packfile section (sideband band 1). */
function packOf(answer: Buffer, v2: boolean): Buffer {
  const packets = parsePkts(answer);
  const chunks: Buffer[] = [];
  let inPack = !v2;
  for (const packet of packets) {
    if (packet.kind !== 'data') continue;
    const text = packet.data.toString('latin1');
    if (v2 && text === 'packfile\n') {
      inPack = true;
      continue;
    }
    if (inPack && packet.data[0] === 1) chunks.push(packet.data.subarray(1));
  }
  return Buffer.concat(chunks);
}

test('protocol v2 ls-refs lists HEAD and branches, and fetch sends whole history for a clone', () => {
  const { store, repo, dir } = harness();
  try {
    const one = makeCommit({ a: '1' }, [], 'one', 1);
    const two = makeCommit({ a: '2' }, [one.oid], 'two', 2);
    receivePack(store, repo, pushBody([[ZERO_OID, two.oid, 'refs/heads/main']], [...one.objects, ...two.objects]));

    const lsRequest = Buffer.concat([pkt('command=ls-refs\n'), pkt('agent=test\n'), DELIM, pkt('peel\n'), pkt('symrefs\n'), pkt('unborn\n'), FLUSH]);
    const ls = uploadPackV2(store, repo, lsRequest).toString('utf8');
    assert.ok(ls.includes(`${two.oid} HEAD symref-target:refs/heads/main`));
    assert.ok(ls.includes(`${two.oid} refs/heads/main`));

    const fetchRequest = Buffer.concat([pkt('command=fetch\n'), pkt('agent=test\n'), DELIM, pkt('ofs-delta\n'), pkt(`want ${two.oid}\n`), pkt('done\n'), FLUSH]);
    const answer = uploadPackV2(store, repo, fetchRequest);
    const objects = readPack(packOf(answer, true));
    assert.ok(objects.has(one.oid));
    assert.ok(objects.has(two.oid));
  } finally {
    store.sync();
    rmSync(dir, { recursive: true, force: true });
  }
});

test('a depth-1 shallow fetch sends the tip only and marks it as the boundary', () => {
  const { store, repo, dir } = harness();
  try {
    const one = makeCommit({ a: '1' }, [], 'one', 1);
    const two = makeCommit({ a: '2' }, [one.oid], 'two', 2);
    receivePack(store, repo, pushBody([[ZERO_OID, two.oid, 'refs/heads/main']], [...one.objects, ...two.objects]));
    const request = Buffer.concat([pkt('command=fetch\n'), DELIM, pkt(`want ${two.oid}\n`), pkt('deepen 1\n'), pkt('done\n'), FLUSH]);
    const answer = uploadPackV2(store, repo, request);
    const text = answer.toString('latin1');
    assert.ok(text.includes(`shallow ${two.oid}`));
    const objects = readPack(packOf(answer, true));
    assert.ok(objects.has(two.oid));
    assert.ok(!objects.has(one.oid));
    assert.equal(parseCommit(objects.get(two.oid)!.data).parents.length, 1);
  } finally {
    store.sync();
    rmSync(dir, { recursive: true, force: true });
  }
});

test('a v0 upload-pack answers an incremental fetch with only the new objects', () => {
  const { store, repo, dir } = harness();
  try {
    const one = makeCommit({ a: '1' }, [], 'one', 1);
    receivePack(store, repo, pushBody([[ZERO_OID, one.oid, 'refs/heads/main']], one.objects));
    const two = makeCommit({ a: '2', b: 'new' }, [one.oid], 'two', 2);
    receivePack(store, repo, pushBody([[one.oid, two.oid, 'refs/heads/main']], two.objects));
    const request = Buffer.concat([
      pkt(`want ${two.oid} side-band-64k ofs-delta\n`),
      FLUSH,
      pkt(`have ${one.oid}\n`),
      pkt('done\n'),
    ]);
    const answer = uploadPackV0(store, repo, request);
    const objects = readPack(packOf(answer, false));
    assert.ok(objects.has(two.oid));
    assert.ok(!objects.has(one.oid), 'the commit the client already has is not resent');
  } finally {
    store.sync();
    rmSync(dir, { recursive: true, force: true });
  }
});
