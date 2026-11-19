// End-to-end tests over real HTTP against a live forge on an ephemeral port.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { startForge, authed, json, TOKEN, type Running } from './helpers.ts';
import { DELIM, FLUSH, parsePkts, pkt } from '../src/git/pkt.ts';
import { ZERO_OID, buildCommit, buildTree, hashObject, readPack, writePack, type GitObject } from '../src/git/objects.ts';

let forge: Running;
before(async () => {
  forge = await startForge();
  // The forge learns its login from the first owner-scoped request (this one names "ada" and is a 404).
  await fetch(`${forge.base}/api/v3/repos/ada/probe`, { headers: authed() });
});
after(async () => {
  await forge.close();
});

const b64 = (text: string) => Buffer.from(text, 'utf8').toString('base64');

async function api(path: string, init: RequestInit & { json?: unknown } = {}): Promise<Response> {
  const headers: Record<string, string> = { ...authed(), ...((init.headers as Record<string, string>) ?? {}) };
  let body = init.body;
  if (init.json !== undefined) {
    headers['content-type'] = 'application/json';
    body = JSON.stringify(init.json);
  }
  return fetch(`${forge.base}${path}`, { ...init, headers, body: body as BodyInit | undefined });
}

test('the public routes answer without a token and everything else requires one', async () => {
  assert.equal((await fetch(`${forge.base}/healthz`)).status, 200);
  const anon = await fetch(`${forge.base}/api/v3/`);
  assert.equal(anon.status, 401);
  assert.equal((await json(anon)).message, 'Requires authentication');
  const wrong = await fetch(`${forge.base}/api/v3/`, { headers: { authorization: 'Bearer nope' } });
  assert.equal(wrong.status, 401);
  const root = await api('/api/v3/');
  assert.equal(root.status, 200);
  assert.match(root.headers.get('content-type') ?? '', /^application\/json/);
  assert.match(root.headers.get('x-oauth-scopes') ?? '', /repo/);
  assert.ok((root.headers.get('x-github-request-id') ?? '').length > 0);
});

test('unknown routes, malformed bodies and missing repositories are JSON errors, never HTML', async () => {
  const unknown = await api('/api/v3/no/such/thing');
  assert.equal(unknown.status, 404);
  assert.equal((await json(unknown)).message, 'Not Found');
  const malformed = await api('/api/v3/user/repos', { method: 'POST', body: '{"name":', headers: { 'content-type': 'application/json' } });
  assert.equal(malformed.status, 400);
  assert.equal(typeof (await json(malformed)).message, 'string');
  const missing = await api('/api/v3/repos/ada/never-there');
  assert.equal(missing.status, 404);
  assert.equal((await json(missing)).message, 'Not Found');
});

test('repository lifecycle: create, read, patch, list with pagination, another owner is 404, delete', async () => {
  const created = await api('/api/v3/user/repos', { method: 'POST', json: { name: 'life', private: true, description: 'first' } });
  assert.equal(created.status, 201);
  const repo = await json(created);
  assert.equal(repo.name, 'life');
  assert.equal(repo.private, true);
  assert.equal(repo.default_branch, 'main');
  const owner = repo.owner.login as string;
  assert.ok(owner.length > 0);

  const dup = await api('/api/v3/user/repos', { method: 'POST', json: { name: 'life' } });
  assert.equal(dup.status, 422);
  assert.match((await json(dup)).errors[0].message, /already exists/);

  const read = await api(`/api/v3/repos/${owner}/life`);
  assert.equal(read.status, 200);
  assert.equal((await json(read)).id, repo.id);

  const patched = await api(`/api/v3/repos/${owner}/life`, { method: 'PATCH', json: { description: 'second' } });
  assert.equal((await json(patched)).description, 'second');

  const foreign = await api('/api/v3/repos/someone-else/life');
  assert.equal(foreign.status, 404);

  for (const name of ['p1', 'p2', 'p3']) await api('/api/v3/user/repos', { method: 'POST', json: { name } });
  const page1 = await api('/api/v3/user/repos?per_page=2');
  assert.equal(page1.status, 200);
  assert.equal((await json(page1)).length, 2);
  assert.match(page1.headers.get('link') ?? '', /rel="next"/);

  const deleted = await api(`/api/v3/repos/${owner}/life`, { method: 'DELETE' });
  assert.equal(deleted.status, 204);
  assert.equal((await api(`/api/v3/repos/${owner}/life`)).status, 404);
});

test('contents: create is 201, update needs the current sha, a stale sha is 409, delete is 200 then 404', async () => {
  const repo = await (await api('/api/v3/user/repos', { method: 'POST', json: { name: 'files', auto_init: true } })).json();
  const owner = repo.owner.login;
  const path = `/api/v3/repos/${owner}/files/contents/docs/readme.txt`;
  const created = await api(path, { method: 'PUT', json: { message: 'add', content: b64('v1') } });
  assert.equal(created.status, 201);
  const first = await json(created);
  assert.equal(first.content.encoding, 'base64');

  const fetched = await json(await api(path));
  assert.equal(Buffer.from(fetched.content, 'base64').toString(), 'v1');
  assert.equal(fetched.sha, first.content.sha);

  const missingSha = await api(path, { method: 'PUT', json: { message: 'again', content: b64('v2') } });
  assert.equal(missingSha.status, 422);

  const updated = await api(path, { method: 'PUT', json: { message: 'update', content: b64('v2'), sha: fetched.sha } });
  assert.equal(updated.status, 200);
  const stale = await api(path, { method: 'PUT', json: { message: 'stale', content: b64('v3'), sha: fetched.sha } });
  assert.equal(stale.status, 409);
  assert.equal(typeof (await json(stale)).message, 'string');

  const dir = await json(await api(`/api/v3/repos/${owner}/files/contents/docs`));
  assert.ok(Array.isArray(dir));
  assert.ok(dir.some((entry: { name: string }) => entry.name === 'readme.txt'));

  const current = await json(await api(path));
  const removed = await api(path, { method: 'DELETE', json: { message: 'rm', sha: current.sha } });
  assert.equal(removed.status, 200);
  assert.match((await json(removed)).commit.sha, /^[0-9a-f]{40}$/);
  assert.equal((await api(path)).status, 404);

  const traversal = await api(`/api/v3/repos/${owner}/files/contents/a/../../etc`, { method: 'PUT', json: { message: 'x', content: b64('x') } });
  assert.ok(traversal.status === 404 || traversal.status === 422);
});

test('issues: labels must exist (422), numbers increase, list filters and sorts, comments round-trip', async () => {
  const repo = await (await api('/api/v3/user/repos', { method: 'POST', json: { name: 'tracker' } })).json();
  const owner = repo.owner.login;
  const base = `/api/v3/repos/${owner}/tracker`;
  assert.equal((await api(`${base}/labels`, { method: 'POST', json: { name: 'bug', color: 'ff0000' } })).status, 201);
  const unknown = await api(`${base}/issues`, { method: 'POST', json: { title: 'x', labels: ['nope'] } });
  assert.equal(unknown.status, 422);
  const first = await json(await api(`${base}/issues`, { method: 'POST', json: { title: 'one', body: 'b', labels: ['bug'] } }));
  const second = await json(await api(`${base}/issues`, { method: 'POST', json: { title: 'two' } }));
  assert.equal(second.number, first.number + 1);
  assert.equal(first.labels[0].name, 'bug');
  const closed = await json(await api(`${base}/issues/${second.number}`, { method: 'PATCH', json: { state: 'closed' } }));
  assert.equal(closed.state, 'closed');
  const open = await json(await api(`${base}/issues?state=open`));
  assert.ok(open.some((issue: { number: number }) => issue.number === first.number));
  assert.ok(!open.some((issue: { number: number }) => issue.number === second.number));
  const desc = await json(await api(`${base}/issues?sort=created&direction=desc&state=all`));
  assert.ok(desc[0].number > desc[desc.length - 1].number);
  const comment = await json(await api(`${base}/issues/${first.number}/comments`, { method: 'POST', json: { body: 'hello' } }));
  assert.equal(comment.body, 'hello');
  const comments = await json(await api(`${base}/issues/${first.number}/comments`));
  assert.equal(comments[0].id, comment.id);
  assert.equal((await api(`${base}/issues/99999`)).status, 404);
});

test('pull requests: create, files, conflict-free squash merge lands on the base, a conflicting merge is 405', async () => {
  const repo = await (await api('/api/v3/user/repos', { method: 'POST', json: { name: 'reviews', auto_init: true } })).json();
  const owner = repo.owner.login;
  const base = `/api/v3/repos/${owner}/reviews`;
  const mainRef = await json(await api(`${base}/git/refs/heads/main`));
  const mainSha = mainRef.object.sha;
  assert.equal((await api(`${base}/git/refs`, { method: 'POST', json: { ref: 'refs/heads/feature', sha: mainSha } })).status, 201);
  await api(`${base}/contents/feature.txt`, { method: 'PUT', json: { message: 'feat', content: b64('feature'), branch: 'feature' } });
  const pr = await api(`${base}/pulls`, { method: 'POST', json: { title: 'Add feature', body: 'details', head: 'feature', base: 'main' } });
  assert.equal(pr.status, 201);
  const pull = await json(pr);
  assert.equal(pull.state, 'open');
  assert.equal(pull.head.ref, 'feature');
  assert.equal(pull.base.ref, 'main');
  const files = await json(await api(`${base}/pulls/${pull.number}/files`));
  assert.deepEqual(files.map((file: { filename: string }) => file.filename), ['feature.txt']);
  assert.equal((await api(`${base}/pulls/99999`)).status, 404);

  const merged = await api(`${base}/pulls/${pull.number}/merge`, { method: 'PUT', json: { merge_method: 'squash' } });
  assert.equal(merged.status, 200);
  const mergeBody = await json(merged);
  assert.equal(mergeBody.merged, true);
  assert.match(mergeBody.sha, /^[0-9a-f]{40}$/);
  const after = await json(await api(`${base}/pulls/${pull.number}`));
  assert.equal(after.merged, true);
  assert.equal(after.state, 'closed');
  assert.equal(after.merge_commit_sha, mergeBody.sha);
  const onMain = await json(await api(`${base}/contents/feature.txt?ref=main`));
  assert.equal(Buffer.from(onMain.content, 'base64').toString(), 'feature');

  // Two branches editing the same file: the second merge conflicts once the first has landed.
  await api(`${base}/git/refs`, { method: 'POST', json: { ref: 'refs/heads/left', sha: mergeBody.sha } });
  await api(`${base}/git/refs`, { method: 'POST', json: { ref: 'refs/heads/right', sha: mergeBody.sha } });
  const feat = await json(await api(`${base}/contents/feature.txt?ref=left`));
  await api(`${base}/contents/feature.txt`, { method: 'PUT', json: { message: 'l', content: b64('left change'), sha: feat.sha, branch: 'left' } });
  await api(`${base}/contents/feature.txt`, { method: 'PUT', json: { message: 'r', content: b64('right change'), sha: feat.sha, branch: 'right' } });
  const leftPr = await json(await api(`${base}/pulls`, { method: 'POST', json: { title: 'left', head: 'left', base: 'main' } }));
  const rightPr = await json(await api(`${base}/pulls`, { method: 'POST', json: { title: 'right', head: 'right', base: 'main' } }));
  assert.equal((await api(`${base}/pulls/${leftPr.number}/merge`, { method: 'PUT', json: {} })).status, 200);
  const conflicted = await api(`${base}/pulls/${rightPr.number}/merge`, { method: 'PUT', json: {} });
  assert.equal(conflicted.status, 405);
  assert.equal(typeof (await json(conflicted)).message, 'string');
});

test('GraphQL: introspection, a typed read, batching, an unknown field, an unknown repository and auth', async () => {
  const repo = await (await api('/api/v3/user/repos', { method: 'POST', json: { name: 'gql', auto_init: true } })).json();
  const owner = repo.owner.login;
  await api(`/api/v3/repos/${owner}/gql/issues`, { method: 'POST', json: { title: 'gql issue' } });

  const gql = (body: unknown) => api('/api/graphql', { method: 'POST', json: body });
  const anon = await fetch(`${forge.base}/api/graphql`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{"query":"{ viewer { login } }"}' });
  assert.equal(anon.status, 401);

  const probe = await json(await gql({ query: '{ __type(name: "Issue") { fields(includeDeprecated: true) { name } } }' }));
  const names = probe.data.__type.fields.map((field: { name: string }) => field.name);
  for (const expected of ['id', 'number', 'title', 'state', 'body']) assert.ok(names.includes(expected), expected);
  const pr = await json(await gql({ query: '{ __type(name: "PullRequest") { fields { name } } }' }));
  assert.ok(pr.data.__type.fields.some((field: { name: string }) => field.name === 'files'));
  const search = await json(await gql({ query: '{ __type(name: "SearchType") { enumValues(includeDeprecated: true) { name } } }' }));
  assert.ok(search.data.__type.enumValues.some((value: { name: string }) => value.name === 'ISSUE'));

  const read = await json(
    await gql({
      query: 'query R($owner: String!, $name: String!) { repository(owner: $owner, name: $name) { id databaseId name nameWithOwner issues(first: 10, states: [OPEN], orderBy: {field: CREATED_AT, direction: DESC}) { nodes { number title state } } } }',
      variables: { owner, name: 'gql' },
    }),
  );
  assert.equal(read.data.repository.name, 'gql');
  assert.equal(read.data.repository.nameWithOwner, `${owner}/gql`);
  assert.equal(read.data.repository.issues.nodes[0].state, 'OPEN');

  const batch = await json(await gql([{ query: '{ viewer { login } }' }, { query: '{ __type(name: "Issue") { name } }' }]));
  assert.equal(batch.length, 2);
  assert.equal(batch[0].data.viewer.login, owner);
  assert.equal(batch[1].data.__type.name, 'Issue');

  const invalid = await json(await gql({ query: '{ viewer { login noSuchFieldOnViewer } }' }));
  assert.equal(invalid.errors[0].message.includes('noSuchFieldOnViewer'), true);

  const missing = await json(await gql({ query: '{ repository(owner: "nobody", name: "x") { id } }' }));
  assert.equal(missing.data.repository, null);
  assert.equal(missing.errors, undefined);

  const mutation = await json(
    await gql({
      query: 'mutation C($input: CreateIssueInput!) { createIssue(input: $input) { issue { number id state } } }',
      variables: { input: { repositoryId: repo.node_id, title: 'made by graphql' } },
    }),
  );
  assert.equal(mutation.data.createIssue.issue.state, 'OPEN');
  const viaRest = await json(await api(`/api/v3/repos/${owner}/gql/issues/${mutation.data.createIssue.issue.number}`));
  assert.equal(viaRest.title, 'made by graphql');

  const syntax = await json(await gql({ query: '{ viewer { login ' }));
  assert.ok(Array.isArray(syntax.errors));
});

test('MCP: discover and initialize, tools/list with the required six, a create/read round trip, and JSON-RPC errors', async () => {
  const mcp = (body: unknown, extra: Record<string, string> = {}) =>
    fetch(`${forge.base}/mcp`, { method: 'POST', headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream', ...authed(), ...extra }, body: typeof body === 'string' ? body : JSON.stringify(body) });

  const discover = await json(await mcp({ jsonrpc: '2.0', id: 1, method: 'server/discover', params: {} }));
  assert.ok(discover.result.supportedVersions.length > 0);
  assert.match(discover.result.supportedVersions[0], /^\d{4}-\d{2}-\d{2}$/);

  const init = await json(await mcp({ jsonrpc: '2.0', id: 2, method: 'initialize', params: { protocolVersion: '2025-11-25', capabilities: {}, clientInfo: { name: 't', version: '1' } } }));
  assert.equal(init.result.protocolVersion, '2025-11-25');
  assert.ok(init.result.capabilities.tools);
  assert.equal((await mcp({ jsonrpc: '2.0', method: 'notifications/initialized' })).status, 202);

  const listed = await json(await mcp({ jsonrpc: '2.0', id: 3, method: 'tools/list' }));
  const toolNames = listed.result.tools.map((tool: { name: string }) => tool.name);
  for (const required of ['create_repo', 'get_repo', 'create_issue', 'list_issues', 'create_pull_request', 'merge_pull_request']) assert.ok(toolNames.includes(required), required);
  for (const tool of listed.result.tools) {
    assert.ok(tool.description.length > 0);
    assert.equal(tool.inputSchema.type, 'object');
  }
  const again = await json(await mcp({ jsonrpc: '2.0', id: 4, method: 'tools/list' }));
  assert.equal(JSON.stringify(again.result.tools), JSON.stringify(listed.result.tools));

  const created = await json(await mcp({ jsonrpc: '2.0', id: 5, method: 'tools/call', params: { name: 'create_repo', arguments: { name: 'from-mcp' } } }));
  const repoView = created.result.structuredContent;
  assert.equal(repoView.name, 'from-mcp');
  const restView = await json(await api(`/api/v3/repos/${repoView.owner.login}/from-mcp`));
  assert.equal(restView.id, repoView.id);

  const issue = await json(await mcp({ jsonrpc: '2.0', id: 6, method: 'tools/call', params: { name: 'create_issue', arguments: { owner: repoView.owner.login, repo: 'from-mcp', title: 'mcp issue' } } }));
  const number = issue.result.structuredContent.number;
  const listedIssues = await json(await api(`/api/v3/repos/${repoView.owner.login}/from-mcp/issues/${number}`));
  assert.equal(listedIssues.title, 'mcp issue');

  const unknownTool = await json(await mcp({ jsonrpc: '2.0', id: 7, method: 'tools/call', params: { name: 'no_such', arguments: {} } }));
  assert.ok([-32602, -32601].includes(unknownTool.error.code));
  const missingArgs = await json(await mcp({ jsonrpc: '2.0', id: 8, method: 'tools/call', params: { name: 'create_issue', arguments: {} } }));
  assert.equal(missingArgs.error.code, -32602);
  const parseError = await mcp('{"jsonrpc": "2.0", "id": 9, "method"');
  assert.equal(parseError.status, 400);
  assert.equal((await json(parseError)).error.code, -32700);
  const unauthenticated = await fetch(`${forge.base}/mcp`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{"jsonrpc":"2.0","id":1,"method":"tools/list"}' });
  assert.equal(unauthenticated.status, 401);
});

test('git smart HTTP over real requests: advertisement, a push of one commit, a v2 clone that reads it back', async () => {
  const repo = await (await api('/api/v3/user/repos', { method: 'POST', json: { name: 'wire' } })).json();
  const owner = repo.owner.login;
  const gitPath = `/${owner}/wire.git`;

  const missing = await fetch(`${forge.base}/${owner}/nothing-here.git/info/refs?service=git-upload-pack`, { headers: authed() });
  assert.equal(missing.status, 404);

  const advert = await fetch(`${forge.base}${gitPath}/info/refs?service=git-receive-pack`, { headers: authed() });
  assert.equal(advert.status, 200);
  assert.equal(advert.headers.get('content-type'), 'application/x-git-receive-pack-advertisement');
  assert.ok((await advert.text()).startsWith('001f# service=git-receive-pack'));

  const blob: GitObject = { type: 'blob', data: Buffer.from('hello over http\n') };
  const blobOid = hashObject('blob', blob.data);
  const tree = buildTree([{ mode: '100644', name: 'hello.txt', oid: blobOid }]);
  const treeObj: GitObject = { type: 'tree', data: tree };
  const who = { name: 'Ada', email: 'ada@example.invalid', when: 1_700_000_000, tz: '+0000' };
  const commitObj: GitObject = { type: 'commit', data: buildCommit({ tree: hashObject('tree', tree), parents: [], author: who, committer: who, message: 'wire\n' }) };
  const commitOid = hashObject('commit', commitObj.data);

  const push = Buffer.concat([
    pkt(`${ZERO_OID} ${commitOid} refs/heads/main\0report-status side-band-64k\n`),
    FLUSH,
    writePack([blob, treeObj, commitObj]),
  ]);
  const pushed = await fetch(`${forge.base}${gitPath}/git-receive-pack`, { method: 'POST', headers: { ...authed(), 'content-type': 'application/x-git-receive-pack-request' }, body: push });
  assert.equal(pushed.status, 200);
  const report = parsePkts(Buffer.from(await pushed.arrayBuffer()));
  const reportText = report.filter((packet) => packet.kind === 'data').map((packet) => (packet.kind === 'data' ? packet.data.subarray(1).toString() : '')).join('');
  assert.match(reportText, /ok refs\/heads\/main/);

  const v2Advert = await fetch(`${forge.base}${gitPath}/info/refs?service=git-upload-pack`, { headers: { ...authed(), 'git-protocol': 'version=2' } });
  assert.match(await v2Advert.text(), /version 2/);

  const ls = await fetch(`${forge.base}${gitPath}/git-upload-pack`, {
    method: 'POST',
    headers: { ...authed(), 'git-protocol': 'version=2', 'content-type': 'application/x-git-upload-pack-request' },
    body: Buffer.concat([pkt('command=ls-refs\n'), DELIM, pkt('peel\n'), pkt('symrefs\n'), FLUSH]),
  });
  assert.match(await ls.text(), new RegExp(`${commitOid} refs/heads/main`));

  const clone = await fetch(`${forge.base}${gitPath}/git-upload-pack`, {
    method: 'POST',
    headers: { ...authed(), 'git-protocol': 'version=2', 'content-type': 'application/x-git-upload-pack-request' },
    body: Buffer.concat([pkt('command=fetch\n'), DELIM, pkt('no-progress\n'), pkt(`want ${commitOid}\n`), pkt('done\n'), FLUSH]),
  });
  assert.equal(clone.status, 200);
  const bytes = Buffer.from(await clone.arrayBuffer());
  const packets = parsePkts(bytes);
  const chunks: Buffer[] = [];
  let inPack = false;
  for (const packet of packets) {
    if (packet.kind !== 'data') continue;
    if (packet.data.toString() === 'packfile\n') inPack = true;
    else if (inPack && packet.data[0] === 1) chunks.push(packet.data.subarray(1));
  }
  const objects = readPack(Buffer.concat(chunks));
  assert.equal(objects.get(blobOid)?.data.toString(), 'hello over http\n');
  assert.equal(objects.get(commitOid)?.type, 'commit');
  assert.ok(TOKEN.length > 0);
});

test('an unauthenticated POST is refused before its body is read, so an oversized body costs nothing', async () => {
  const big = Buffer.alloc(20 * 1024 * 1024, 0x61);
  const response = await fetch(`${forge.base}/api/v3/user/repos`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: big });
  assert.equal(response.status, 401);
});

test('an authorized request over the body limit is refused with 413 JSON', async () => {
  const big = Buffer.alloc(17 * 1024 * 1024, 0x61);
  const response = await fetch(`${forge.base}/api/v3/user/repos`, { method: 'POST', headers: { ...authed(), 'content-type': 'application/json' }, body: big });
  assert.equal(response.status, 413);
  assert.equal(typeof (await json(response)).message, 'string');
});
