# trolloks-forge

[![github-core-clone-01](https://make.fun/badge/github-core-clone-01.svg)](https://make.fun/bounty/github-core-clone-01)
[![rank](https://make.fun/badge/github-core-clone-01/trolloks/trolloks-forge/rank.svg)](https://make.fun/bounty/github-core-clone-01)
[![reward](https://make.fun/badge/github-core-clone-01/trolloks/trolloks-forge/reward.svg)](https://make.fun/bounty/github-core-clone-01)

A GitHub-compatible forge in one Node 22 process with no dependencies and no git binary. It serves git smart
HTTP (upload-pack v2 and v0, receive-pack v0), the REST v3 API under `/api/v3`, GraphQL at `/api/graphql` and
MCP at `/mcp`, all over one store that survives restarts.

## Run

```sh
node main.ts                 # the trial's lifecycle: listen(0), register with MAKEFUN_ENV_URL, exit when done
npm test                     # 42 unit and HTTP tests (node:test)
```

Environment: `MAKEFUN_SHOP_TOKEN` (the bearer token every request must carry; unset means every request is 401),
`MAKEFUN_ENV_URL` (the suite's origin), `FORGE_DATA_DIR` (the store, default `/tmp/makefun-forge`).

## What is implemented

- **Git smart HTTP** at `/{owner}/{repo}.git`: v2 `ls-refs` (with `unborn`, `symrefs`, `peel`, `ref-prefix`)
  and `fetch` (`want`, `have`, `done`, `deepen`, `shallow`, sideband-64k); v0 upload-pack for clients that
  ask for it; receive-pack v0 with `report-status`, `side-band-64k` and `delete-refs`. Every update must
  fast-forward; a refused ref is reported `ng <ref> non-fast-forward` and does not move. Pushed packs are
  checked (trailer sha1, delta bases, connectivity to the refs the forge already holds).
- **REST v3**: repositories (create, read, patch, delete, paginated list), branches, commits, git refs
  (create, read, fast-forward patch, delete), contents (create, update with sha, 409 on a stale sha, delete),
  labels, issues (labels checked, filters, sort, close), comments, pull requests (create, files, squash or
  merge commit, 405 on conflict), 404 and 401 and 400 and 422 in GitHub's shapes.
- **GraphQL v4**: a real parser and executor (operations, variables with defaults, aliases, fragments, inline
  fragments, enums, input objects, batching). Introspection through `__type`, `__schema` and the `__Type`
  family. `viewer`, `repository`, `node`, `issues` and `pullRequests` with cursors, and the mutations
  `createIssue`, `closeIssue`, `createPullRequest`, `mergePullRequest` (squash) and `addComment`.
- **MCP** (streamable HTTP, JSON replies): `server/discover`, `initialize`, `notifications/initialized`,
  `tools/list` (byte-stable), `tools/call` for `create_repo`, `get_repo`, `create_issue`, `list_issues`,
  `get_issue`, `add_issue_comment`, `create_pull_request`, `list_pull_requests`, `get_pull_request` and
  `merge_pull_request`. Tools act on the same store as REST, so ids match across surfaces.

## Design

- `app.ts` routes; `main.ts` is the trial lifecycle, unchanged from the starter.
- `src/git/`: pkt-lines, object codecs, packs (read with ofs and ref deltas, write whole objects), graph and
  tree algorithms (three-way tree merge, merge bases, generation-pruned ancestry), smart protocol.
- `src/store/`: one object database (content-addressed, shared) and the metadata records. Each change is one
  appended journal record, written before the request is answered; boot replays the journal and cuts away a
  torn final record.
- `src/api/`: REST routes, the shared domain service (issues, pulls, merges, repository creation) that REST,
  GraphQL and MCP all call, and the JSON shapes.
- `src/graphql/`, `src/mcp/`: the GraphQL engine and the MCP endpoint.

Single tenant: the bearer token names no login, so the forge binds its login at the first owner-scoped
request (`/repos/{owner}/...` or `/{owner}/{repo}.git`) and answers every other owner with 404. Until that
first request, `GET /api/v3/user` answers 404 and a repository created earlier reports an empty owner login.

## Verification

- Public suite (`program/env`, run locally against this forge): 120 of 120 checks pass; a second run from an
  empty state produced a byte-identical `state.json`. Local timings (a laptop, not the grader's sandbox) gave
  about 175 to 183 of the 200 performance points.
- `npm test`: 42 tests over the pack and object codecs, the tree and graph algorithms, the store's replay and
  torn-tail recovery, the smart protocol driven with real packs, and every HTTP surface over a live port.

## Limits

- Packs the forge sends contain whole objects only (no deltas), which every client accepts.
- No push certificates, atomic pushes, LFS, forks, reviews, webhooks, OAuth or GitHub Apps. `rebase` merges
  are refused (422). GraphQL covers the documents gh and github-mcp-server send, not the whole schema.
- The store lives under `FORGE_DATA_DIR`. A run that starts on an old store finds its repositories already
  present, so each trial needs a fresh data directory.
