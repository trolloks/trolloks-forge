import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, appendFileSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Store, StoreError } from '../src/store/store.ts';

function freshDir(): string {
  return mkdtempSync(join(tmpdir(), 'forge-store-'));
}

test('the store reopens with the same repositories, refs, labels, issues and comments', () => {
  const dir = freshDir();
  try {
    const first = new Store(dir);
    assert.equal(first.bindLogin('ada'), true);
    const repo = first.createRepo({ name: 'alpha', description: 'd', private: true });
    const blob = first.objects.put({ type: 'blob', data: Buffer.from('persist me') });
    first.setRef(repo.id, 'refs/heads/main', blob);
    first.createLabel(repo.id, { name: 'bug', color: 'ff0000', description: '' });
    const issue = first.newIssue({
      repo_id: repo.id, is_pull: false, title: 'first', body: 'body', state: 'open', state_reason: null, author: 'ada',
      labels: ['bug'], created_at: 'x', updated_at: 'x', closed_at: null, pull: null,
    });
    first.addComment({ repo_id: repo.id, issue_id: issue.id, body: 'hi', author: 'ada', created_at: 'x', updated_at: 'x' });
    first.sync();

    const second = new Store(dir);
    assert.equal(second.login, 'ada');
    assert.equal(second.repoByName('ALPHA')?.description, 'd');
    assert.equal(second.getRef(repo.id, 'refs/heads/main'), blob);
    assert.equal(second.objects.get(blob)?.data.toString(), 'persist me');
    assert.equal(second.findLabel(repo.id, 'bug')?.color, 'ff0000');
    assert.equal(second.issueByNumber(repo.id, 1)?.labels[0], 'bug');
    assert.equal(second.listComments(issue.id)[0].body, 'hi');
    // Numbers continue after the stored ones and ids never repeat.
    const next = second.newIssue({
      repo_id: repo.id, is_pull: false, title: 'second', body: '', state: 'open', state_reason: null, author: 'ada',
      labels: [], created_at: 'x', updated_at: 'x', closed_at: null, pull: null,
    });
    assert.equal(next.number, 2);
    assert.ok(next.id > issue.id);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('a torn final record is cut away on reopen and everything before it survives', () => {
  const dir = freshDir();
  try {
    const first = new Store(dir);
    first.createRepo({ name: 'keep', description: '', private: false });
    first.sync();
    const before = statSync(join(dir, 'meta.log')).size;
    appendFileSync(join(dir, 'meta.log'), '{"k":"repo","v":{"id":99,"na');
    const reopened = new Store(dir);
    assert.ok(reopened.repoByName('keep'));
    assert.equal(statSync(join(dir, 'meta.log')).size, before);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('names are unique without regard to case, and deleting a repository removes its contents', () => {
  const dir = freshDir();
  try {
    const store = new Store(dir);
    const repo = store.createRepo({ name: 'Mixed', description: '', private: true });
    assert.throws(
      () => store.createRepo({ name: 'mixed', description: '', private: true }),
      (err: unknown) => err instanceof StoreError && err.status === 422,
    );
    store.setRef(repo.id, 'refs/heads/main', 'a'.repeat(40));
    store.deleteRepo(repo);
    assert.equal(store.repoByName('mixed'), undefined);
    assert.equal(store.refsOf(repo.id).size, 0);
    const reopened = new Store(dir);
    assert.equal(reopened.repoByName('mixed'), undefined);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
