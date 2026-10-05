# Verification record

Development environment: Windows, Node.js 24.11.1, npm 11.6.2. npm registry requests were denied by the execution environment, so locally available packages from an existing project were reused for the checks that could run. This does not verify a clean install or exact reproduction of all pinned dependencies. PostgreSQL 16.13 binaries were available; SQL checks ran on an isolated local process on port 55432.

| Check                               | Result                                | What it establishes                                                                                                                                                              |
| ----------------------------------- | ------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Unit tests                          | 10 passed                             | Password verification, token hashes, bigint cursors, roles, throttle, writable-drain behavior, client dedup/bounds                                                               |
| HTTP/SSE tests                      | 12 passed                             | Real HTTP behavior with test-only stores; workspace/role/session handling, read isolation, reconnect cursor precedence, missed-hint recovery, connection caps, stream revocation |
| PostgreSQL CLI tests                | 3 passed                              | Actual schema constraints/cascades, receipt idempotency, 12 concurrent transaction ordering, failed insert rollback                                                              |
| Frontend production build           | Passed locally                        | Vite transformed/bundled React/TypeScript; not a TypeScript type check or browser visual check                                                                                   |
| Formatting                          | Full repository Prettier check passed | Formatting only                                                                                                                                                                  |
| Full PostgreSQL/Redis adapter suite | Not run successfully                  | `pg` and `redis` packages unavailable locally                                                                                                                                    |
| ESLint                              | Blocked                               | `typescript-eslint` unavailable                                                                                                                                                  |
| TypeScript check                    | Blocked                               | TypeScript compiler unavailable                                                                                                                                                  |
| Docker/Compose execution            | Blocked                               | No accessible Docker command                                                                                                                                                     |
| Clean install / lockfile            | Blocked                               | npm registry denied; lockfile not fabricated                                                                                                                                     |
| Browser visual/interactive review   | Pending                               | No connected browser available                                                                                                                                                   |
| GitHub Actions                      | Defined, not observed                 | No green-run claim                                                                                                                                                               |

## Required completion checks outside the restricted session

1. Run `npm install` with registry access. Review/commit its generated lockfile and use `npm ci` in Docker/CI afterward.
2. Run `npm run check`; fix any newly observable lint/type issues before presenting those checks as complete.
3. Run `npm run test:integration` against disposable local PostgreSQL/Redis, as documented in README.
4. Run `docker compose config --quiet` and `docker compose up --build`, verify readiness and the real two-browser workflow.
5. Follow the demo/manual checklist and capture actual screenshots.
6. Inspect the first GitHub Actions run, confirm a clean working tree, and update this record with real results.

The repository contains the full scoped implementation and validation definitions. It is not release-verified until these gaps are closed. No performance benchmark, deployment, production users, or exact-once guarantee is claimed.
