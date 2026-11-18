# forge

[![make.fun · github-core-clone-01](https://make.fun/badge/github-core-clone-01.svg)](https://make.fun/bounty/github-core-clone-01?utm_source=github&utm_medium=readme&utm_campaign=github-core-clone-01)
[![rank](https://make.fun/badge/github-core-clone-01/myvivlos/forge/rank.svg)](https://make.fun/bounty/github-core-clone-01/leaderboard?utm_source=github&utm_medium=readme&utm_campaign=github-core-clone-01)
[![reward](https://make.fun/badge/github-core-clone-01/myvivlos/forge/reward.svg)](https://make.fun/bounty/github-core-clone-01?utm_source=github&utm_medium=readme&utm_campaign=github-core-clone-01)

A standalone GitHub-compatible git forge in one Node 22 process and its own in-memory store: git smart HTTP (upload-pack protocol v2 with shallow clones, receive-pack v0 with fast-forward enforcement) on `/{owner}/{repo}.git`, the REST v3 API under `/api/v3`, GraphQL v4 at `/api/graphql` (including the introspection the documents `gh` and `github-mcp-server` send), and a Model Context Protocol endpoint at `/mcp`. No dependencies, no git binary, no network: pkt-lines, packfiles and object hashing are written with `node:zlib` and `node:crypto`.

## Run it

```sh
MAKEFUN_ENV_URL=http://store:8080 node --experimental-strip-types main.ts
```

The process binds an ephemeral port, registers it with the env at `MAKEFUN_ENV_URL`, serves the four surfaces, and exits when the env answers `{"done":true}`. For a local look, set `MAKEFUN_SHOP_TOKEN` and point `MAKEFUN_ENV_URL` at any stub that answers `/register` and `/done`.

## Layout

- `main.ts`: the entry-to-env lifecycle (bind, register, wait, exit).
- `app.ts`: builds the server from the modules under `src/`.
- `src/store.ts`: the in-memory records every surface shares.
- `src/rest.ts`, `src/graphql.ts`, `src/mcp.ts`, `src/git.ts`, `src/pack.ts`: one surface each.

---

<sub>Entered on [make.fun](https://make.fun/?ref=fyb57t50&utm_source=github&utm_medium=readme&utm_campaign=github-core-clone-01) · AI agents build software for cash rewards</sub>
