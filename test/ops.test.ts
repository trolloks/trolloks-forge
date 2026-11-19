import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildCommit, buildTree, hashObject, type GitObject } from '../src/git/objects.ts';
import { commitOf, commitsReachable, editPath, flattenTree, generationOf, isAncestor, lookupEntry, mergeBases, mergeTrees, type ObjectLookup } from '../src/git/ops.ts';

/** A plain in-memory object lookup for the algorithms under test. */
function memoryOdb(): ObjectLookup & { map: Map<string, GitObject> } {
  const map = new Map<string, GitObject>();
  return {
    map,
    get: (oid) => map.get(oid),
    put: (object) => {
      const oid = hashObject(object.type, object.data);
      map.set(oid, object);
      return oid;
    },
  };
}

const sig = { name: 'T', email: 't@example.invalid', when: 1, tz: '+0000' };

function commit(odb: ReturnType<typeof memoryOdb>, tree: string | null, parents: string[], message: string, when = 1): string {
  const data = buildCommit({ tree: tree ?? odb.put({ type: 'tree', data: Buffer.alloc(0) }), parents, author: { ...sig, when }, committer: { ...sig, when }, message });
  return odb.put({ type: 'commit', data });
}

test('editPath creates nested files, updates them and prunes emptied directories', () => {
  const odb = memoryOdb();
  const blob1 = odb.put({ type: 'blob', data: Buffer.from('one') });
  const blob2 = odb.put({ type: 'blob', data: Buffer.from('two') });
  let root = editPath(odb, null, 'src/lib/a.ts', { mode: '100644', oid: blob1 });
  assert.ok(root);
  assert.equal(lookupEntry(odb, root, 'src/lib/a.ts')?.oid, blob1);
  root = editPath(odb, root, 'src/lib/a.ts', { mode: '100644', oid: blob2 });
  assert.equal(lookupEntry(odb, root as string, 'src/lib/a.ts')?.oid, blob2);
  root = editPath(odb, root, 'src/lib/a.ts', null);
  assert.equal(root, null, 'removing the only file empties the whole tree');
});

test('editPath refuses to put a file where a directory is, and a directory through a file', () => {
  const odb = memoryOdb();
  const blob = odb.put({ type: 'blob', data: Buffer.from('x') });
  const root = editPath(odb, null, 'dir/file', { mode: '100644', oid: blob }) as string;
  assert.throws(() => editPath(odb, root, 'dir', { mode: '100644', oid: blob }), /directory/);
  assert.throws(() => editPath(odb, root, 'dir/file/inner', { mode: '100644', oid: blob }), /file/);
});

test('mergeTrees takes the side that changed, merges disjoint directory edits and names conflicts', () => {
  const odb = memoryOdb();
  const b = (text: string) => odb.put({ type: 'blob', data: Buffer.from(text) });
  const base = buildTree([{ mode: '100644', name: 'shared.txt', oid: b('base') }, { mode: '100644', name: 'keep.txt', oid: b('keep') }]);
  const baseTree = odb.put({ type: 'tree', data: base });
  const ours = odb.put({ type: 'tree', data: buildTree([{ mode: '100644', name: 'shared.txt', oid: b('base') }, { mode: '100644', name: 'keep.txt', oid: b('keep') }, { mode: '100644', name: 'ours.txt', oid: b('o') }]) });
  const theirs = odb.put({ type: 'tree', data: buildTree([{ mode: '100644', name: 'shared.txt', oid: b('theirs') }, { mode: '100644', name: 'keep.txt', oid: b('keep') }]) });

  const clean = mergeTrees(odb, baseTree, ours, theirs);
  assert.ok(!('conflicts' in clean));
  const merged = (clean as { tree: string }).tree;
  assert.equal(lookupEntry(odb, merged, 'shared.txt')?.oid, b('theirs'));
  assert.ok(lookupEntry(odb, merged, 'ours.txt'));

  const conflictOurs = editPath(odb, baseTree, 'shared.txt', { mode: '100644', oid: b('ours-change') }) as string;
  const conflictTheirs = editPath(odb, baseTree, 'shared.txt', { mode: '100644', oid: b('theirs-change') }) as string;
  const conflict = mergeTrees(odb, baseTree, conflictOurs, conflictTheirs);
  assert.ok('conflicts' in conflict);
  assert.deepEqual((conflict as { conflicts: string[] }).conflicts, ['shared.txt']);
});

test('mergeTrees merges changes made inside the same directory on both sides', () => {
  const odb = memoryOdb();
  const b = (text: string) => odb.put({ type: 'blob', data: Buffer.from(text) });
  const base = editPath(odb, null, 'docs/a.md', { mode: '100644', oid: b('a') }) as string;
  const base2 = editPath(odb, base, 'docs/z.md', { mode: '100644', oid: b('z') }) as string;
  const ours = editPath(odb, base2, 'docs/b.md', { mode: '100644', oid: b('b') }) as string;
  const theirs = editPath(odb, base2, 'docs/c.md', { mode: '100644', oid: b('c') }) as string;
  const result = mergeTrees(odb, base2, ours, theirs);
  assert.ok(!('conflicts' in result));
  const files = flattenTree(odb, (result as { tree: string }).tree);
  assert.deepEqual([...files.keys()].sort(), ['docs/a.md', 'docs/b.md', 'docs/c.md', 'docs/z.md']);
});

test('merge bases and ancestry follow the commit graph', () => {
  const odb = memoryOdb();
  const root = commit(odb, null, [], 'root', 1);
  const left = commit(odb, null, [root], 'left', 2);
  const right = commit(odb, null, [root], 'right', 3);
  const merge = commit(odb, null, [left, right], 'merge', 4);
  assert.deepEqual(mergeBases(odb, left, right), [root]);
  assert.equal(isAncestor(odb, root, merge), true);
  assert.equal(isAncestor(odb, left, right), false);
  assert.equal(isAncestor(odb, merge, root), false);
  assert.equal(generationOf(odb, root), 1);
  assert.equal(generationOf(odb, merge), 3);
  assert.equal(commitOf(odb, merge).parents.length, 2);
  assert.equal(commitsReachable(odb, [merge]).size, 4);
});

test('isAncestor agrees with a full walk on a random DAG', () => {
  // Deterministic pseudo-random generator, so the test is repeatable.
  let seed = 12345;
  const rand = (n: number) => {
    seed = (seed * 1103515245 + 12345) & 0x7fffffff;
    return seed % n;
  };
  const odb = memoryOdb();
  const commits: string[] = [];
  for (let index = 0; index < 60; index += 1) {
    const parents: string[] = [];
    if (commits.length > 0) {
      const count = 1 + rand(2);
      for (let p = 0; p < count; p += 1) {
        const pick = commits[rand(commits.length)];
        if (!parents.includes(pick)) parents.push(pick);
      }
    }
    commits.push(commit(odb, null, parents, `c${index}`, index + 1));
  }
  for (let trial = 0; trial < 300; trial += 1) {
    const a = commits[rand(commits.length)];
    const b = commits[rand(commits.length)];
    const expected = a === b || commitsReachable(odb, [b]).has(a);
    assert.equal(isAncestor(odb, a, b), expected, `isAncestor(${a.slice(0, 7)}, ${b.slice(0, 7)})`);
  }
});
