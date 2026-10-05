# SignalDesk

A durable team activity inbox built with TypeScript, Node.js, PostgreSQL, Redis, and React, with live updates and reconnect recovery.

## Why it exists

Small teams scatter deployment updates, incident notices, and announcements across chat messages. SignalDesk gives a workspace a shared history, immediate updates, and a personal read state. It demonstrates Node.js backend engineering beyond CRUD: long-lived HTTP connections, asynchronous I/O, stream backpressure, cross-instance event fan-out, and recovery after missed messages.

**Verification status:** 10 unit tests, 12 HTTP/SSE tests using test adapters, and 3 CLI-level PostgreSQL tests passed in the development session. The frontend production build and formatting checks ran locally. Full PostgreSQL/Redis adapter integration, ESLint, TypeScript checking, Docker execution, clean dependency installation, and browser visual verification remain pending because required tools/packages could not be downloaded in that session. See [verification details](docs/VERIFICATION.md). No deployment, real users, benchmark throughput, or successful GitHub Actions run is claimed.

## Features

- Workspace registration, member provisioning, and admin/member access rules.
- HttpOnly, SameSite session cookies; random session tokens hashed at rest; logout revocation.
- Deployment, incident, and announcement updates stored transactionally.
- Personal, idempotent read/unread receipts and cursor-based history pagination.
- SSE delivery across API instances using Redis hints and PostgreSQL catch-up.
- Reconnect cursors, bounded replay batches, stream caps, and slow-client deadlines.
- React inbox with type filters, unread filter, team screen, update composer, and connection status.
- Validated inputs/configuration, parameterized SQL, JSON logs, request IDs, health checks, and graceful shutdown.

## Architecture

```mermaid
flowchart LR
  Browser[React inbox] -->|REST + session cookie| API[Node.js / Express]
  API -->|transactions / history / sessions| PG[(PostgreSQL)]
  API -->|committed workspace hint| Redis[(Redis pub/sub)]
  Redis --> API2[Second API instance]
  API2 -->|read events after cursor| PG
  API -->|SSE activity frames| Browser
  API2 -->|SSE activity frames| Browser2[Another inbox]
```

One application, one relational database, one ephemeral fan-out service. A second API instance is a scaling scenario tested by the integration suite, not a required microservice. The frontend and API share an origin; Vite proxies API requests during development, and the Node server serves built assets in the container.

| Component                      | Reason                                                                                                                                 |
| ------------------------------ | -------------------------------------------------------------------------------------------------------------------------------------- |
| Node.js 24 + TypeScript        | Async socket/database I/O, HTTP writable streams, strong application contracts; Node 24 runs erasable TypeScript server files directly |
| Express 5                      | Routing, JSON limits, centralized error middleware                                                                                     |
| PostgreSQL + `pg`              | Transactions, durable history/sessions, parameterized queries, relational constraints                                                  |
| Redis + `redis`                | Fan-out hints between API instances; no durable event storage or fabricated delivery guarantee                                         |
| React + Vite                   | Interactive inbox and a compact development/build toolchain                                                                            |
| Zod                            | Untrusted HTTP/configuration input validation                                                                                          |
| Node crypto                    | Async scrypt and random session tokens; no extra password/JWT package                                                                  |
| Node test runner               | Unit, real HTTP/SSE, and integration suites without an additional test framework                                                       |
| ESLint / Prettier / TypeScript | Lint, formatting, and strict static-check configurations                                                                               |

## How an update reaches an inbox

1. An admin submits a validated event using `POST /api/events`.
2. A PostgreSQL transaction increments that workspace's event counter and inserts the event. Competing publishers serialize on the workspace row, so the sequence reflects commit ordering.
3. After commit, the API publishes the workspace ID to Redis. A failed hint is logged; the HTTP request still reports the committed event.
4. Subscribed instances wake their local SSE connections. Each queries PostgreSQL after its own cursor and writes activity frames in ascending order, in batches of 50.
5. `Last-Event-ID` takes precedence over the original `after` query on automatic reconnect. The UI deduplicates by event ID.
6. Every 5 seconds by default, the stream checks for stored events even if no Redis hint arrived. This covers pub/sub outages and a publisher crash after commit.

Redis pub/sub is [at-most-once](https://redis.io/docs/latest/develop/use-cases/pub-sub/), so persistence/replay comes from PostgreSQL. The design does **not** promise exactly-once delivery. Replays may duplicate a delivery; no event is discarded from the database because a hint failed.

## Important decisions

- **SSE instead of WebSockets:** notifications flow server to browser. Native EventSource provides reconnect behavior without a bidirectional protocol or extra server package.
- **Opaque sessions instead of JWTs:** a database lookup permits immediate REST logout revocation. Connected streams revalidate during reconciliation and replay batches. Tokens are kept out of JavaScript storage.
- **Workspace-local counters instead of a global sequence:** a global sequence can be allocated before another transaction commits, causing a cursor to skip a late-committing lower ID. Updating the workspace counter holds a row lock until the event transaction ends. The trade-off is serial writes within one busy workspace.
- **Redis hints instead of an outbox:** for this product, delayed notification is acceptable if the event remains stored. Periodic reconciliation repairs missed hints. External side effects requiring reliable job execution would need a different design.
- **No ORM or custom queue:** the SQL model is small; neither an ORM nor a background-job subsystem solves a current requirement.
- **String cursors:** PostgreSQL bigint can exceed JavaScript's exact Number range. Comparison uses BigInt, while HTTP/SSE sends decimal strings.

## Data model

```mermaid
erDiagram
  WORKSPACES ||--o{ USERS : contains
  WORKSPACES ||--o{ EVENTS : owns
  USERS ||--o{ SESSIONS : authenticates
  USERS ||--o{ EVENTS : publishes
  USERS ||--o{ READ_RECEIPTS : reads
  EVENTS ||--o{ READ_RECEIPTS : tracks
```

`workspaces` holds a name and transactional event counter. `users` holds workspace membership, role, normalized unique email, and password hash. `sessions` holds only a token hash and expiry. `events` is unique on `(workspace_id, sequence)`, which also supports ordered history scans. `read_receipts` is unique on `(event_id, user_id)`. See [initial migration](db/001_initial.sql). Applied SQL files have recorded checksums; changing an applied migration is refused. Add a new migration instead.

## API overview

| Method | Endpoint                         | Access             | Purpose                        |
| ------ | -------------------------------- | ------------------ | ------------------------------ |
| POST   | `/api/auth/register`             | Public, throttled  | Create workspace/admin/session |
| POST   | `/api/auth/login`                | Public, throttled  | Sign in                        |
| POST   | `/api/auth/logout`               | Session if present | Revoke cookie/session          |
| GET    | `/api/me`                        | Member             | Current account/workspace      |
| GET    | `/api/members`                   | Member             | Workspace members              |
| POST   | `/api/members`                   | Admin, throttled   | Provision a member             |
| GET    | `/api/events?before=42&limit=25` | Member             | Older history page             |
| POST   | `/api/events`                    | Admin              | Publish activity               |
| PUT    | `/api/events/:id/read`           | Member             | Personal read/unread state     |
| GET    | `/api/events/stream?after=42`    | Member             | SSE catch-up/live feed         |
| GET    | `/health/live`                   | Public             | Process liveness               |
| GET    | `/health/ready`                  | Public             | PostgreSQL/Redis readiness     |

The [OpenAPI document](docs/openapi.yaml) describes request/response fields. Admin/member roles are enforced on the server, not just by hiding buttons. Workspace IDs are derived from the authenticated session; clients cannot choose another workspace. Error JSON includes `code`, `message`, and `requestId`; validation responses also include field information.

## Local development

Prerequisites: Node.js 24+, npm, PostgreSQL 16+, Redis 7+, or Docker Compose for the two services. From the repository root:

```powershell
npm install
Copy-Item .env.example .env
```

The example credentials are only for disposable local services. Adjust `DATABASE_URL` and `REDIS_URL` to your services. To launch the supplied infrastructure:

```powershell
docker compose up -d postgres redis
npm run db:migrate
npm run dev:server
```

In another terminal:

```powershell
npm run dev:client
```

Open `http://localhost:5173`, choose **Create a workspace**, and register. In **Team members**, provision a disposable member account. Sign in as that member in a separate browser profile/private window; publishing from the admin window should appear in both inboxes. No personal database credentials or `.env` files belong in Git.

The development sandbox could not generate a dependency lockfile. Direct dependencies are pinned, but transitive resolution is not locked. **After the first successful clean `npm install`, review and commit the generated `package-lock.json`, then change installation steps to `npm ci` in CI/Docker.** This is an outstanding reproducibility requirement, not a completed check.

## Environment configuration

| Variable               | Meaning / default                                                                                       |
| ---------------------- | ------------------------------------------------------------------------------------------------------- |
| `NODE_ENV`             | `development`, `test`, or `production`; production requires HTTPS origin and Secure cookies             |
| `PORT`                 | API port, default `3000`                                                                                |
| `APP_ORIGIN`           | Exact browser origin without path/trailing slash; default `http://localhost:5173`                       |
| `DATABASE_URL`         | PostgreSQL connection URL, required                                                                     |
| `POSTGRES_PASSWORD`    | Compose local password; use URL-safe characters because Compose interpolates it into the connection URL |
| `REDIS_URL`            | Redis connection URL, required                                                                          |
| `LOG_LEVEL`            | `info`, `warn`, or `error`; default `info`                                                              |
| `SESSION_TTL_HOURS`    | Session lifetime, default `168`                                                                         |
| `SSE_RECONCILE_MS`     | Periodic durable catch-up, default `5000`                                                               |
| `SSE_DRAIN_TIMEOUT_MS` | Slow-client writable-drain deadline, default `5000`                                                     |
| `SSE_MAX_CONNECTIONS`  | Per-instance stream cap, default `100`                                                                  |
| `SSE_MAX_PER_USER`     | Per-user cap within one instance, default `3`                                                           |

## Docker

```powershell
Copy-Item .env.example .env # only if you have not already created it
docker compose config --quiet
docker compose up --build -d
```

Open `http://localhost:3000`. Compose runs PostgreSQL/Redis, a one-shot migration service, and the app after dependencies are healthy. PostgreSQL has a named persistence volume; Redis persistence is intentionally disabled because hints are disposable. Host ports bind to loopback. If 5432 is occupied by an existing PostgreSQL service, change the host-side mapping and the development `DATABASE_URL`; container-to-container addresses stay unchanged.

The image runs as the non-root `node` user, serves built frontend assets, and checks process liveness. Readiness separately returns 503 when PostgreSQL or Redis is unavailable, even though existing streams may continue reconciling during a Redis outage. Local Compose explicitly uses development mode for HTTP; an internet-facing deployment requires TLS, production mode, protected database/Redis access, and a reverse proxy with SSE buffering disabled. No cloud configuration is claimed.

Stop without deleting database data:

```powershell
docker compose down
```

## Tests and quality checks

```powershell
npm test                 # unit tests: passwords, roles, cursors, throttling, drain, UI dedup
npm run test:api         # real HTTP/SSE with test-only memory adapters
npm run lint
npm run typecheck
npm run format:check
npm run build
```

For full adapter integration, create a disposable local database named `signaldesk_test`. These tests refuse remote hosts and database names without `test`, migrate the database, create isolated workspaces, and delete only those workspaces afterward. They also use local Redis.

```powershell
$env:TEST_DATABASE_URL = 'postgresql://signaldesk:local-development-only@127.0.0.1:5432/signaldesk_test'
$env:TEST_REDIS_URL = 'redis://127.0.0.1:6379'
npm run test:integration
```

Optional CLI-level SQL checks use `psql` independently of the Node adapter. Set `PSQL_BIN`, `PGHOST`, `PGPORT`, and `PGUSER` if needed, then run `npm run test:sql`. The local database user needs CREATE DATABASE permission; the suite creates and drops a randomly named test database. The three checks verify real constraints, concurrent counter allocation, and failed-write rollback. They do not verify the `pg` adapter or Redis.

CI defines formatting, lint, type checking, unit/API/integration tests, frontend build, Compose validation, Docker build, and container health checks. A workflow file is not evidence that CI has passed; inspect its first run before using a passing badge.

## Example requests

From a POSIX shell with curl (use `curl.exe` in Windows terminals, adjusting quoting):

```bash
curl -c cookies.txt -H 'Content-Type: application/json' \
  -d '{"name":"Demo Admin","email":"admin@example.test","password":"disposable-demo-password","workspaceName":"Platform"}' \
  http://localhost:3000/api/auth/register

curl -b cookies.txt -H 'Content-Type: application/json' \
  -d '{"kind":"deployment","title":"Version 1.2 released","body":"The API deployment completed."}' \
  http://localhost:3000/api/events

curl -N -b cookies.txt 'http://localhost:3000/api/events/stream?after=0'
```

Session cookies are credentials: keep `cookies.txt` outside the repository and delete it after use. An activity frame looks like:

```text
id: 1
event: activity
data: {"id":"...","sequence":"1","title":"Version 1.2 released",...}
```

## Concurrency, observability, and failure behavior

- The database pool allows 10 connections per API process. Stream queries are short; a database connection is not held for an entire SSE lifetime.
- Replay queries load at most 50 events. A stream waits for `drain` after `write()` returns false and disconnects if it cannot drain within the configured deadline. The client retains at most 500 loaded items.
- Default caps are 100 streams per instance and 3 per user per instance. These are configured safeguards, **not benchmarked capacity claims**.
- Async scrypt is limited to 4 active operations per AuthService instance. Auth attempts have a bounded in-memory, per-instance IP throttle; no distributed rate-limit claim is made.
- JSON logs record event names, request IDs, response status/duration, and stream counts. They omit request bodies, passwords, cookies, raw session tokens, and service URLs. No Prometheus/Grafana deployment is claimed.
- SIGINT/SIGTERM stop accepting requests, close streams, release Redis/PostgreSQL resources, and enforce a 10-second shutdown deadline.
- PostgreSQL unavailable: writes cannot be accepted; readiness fails. Redis unavailable: stored history remains available and existing streams can reconcile; readiness reports degradation. Slow/disconnected browser: the stream closes and catches up after reconnect.

## Trade-offs and limitations

This is a production-oriented portfolio application, not a fully verified production service. Initial account provisioning uses admin-supplied passwords; invitations, password changes/recovery, email verification, and account deletion are absent. Use disposable demo accounts until those workflows exist. Events are text-only and immutable. There is no email/mobile push, scheduled delivery, audit-retention policy, or automatic expired-session cleanup. Publishing is not idempotent: a user retry after an ambiguous HTTP failure can create a duplicate event. Read toggles synchronize only in the current tab; another tab refreshes to see them.

Per-connection reconciliation increases database query load with connected clients. Counter allocation serializes writers within one workspace. Stream and auth throttles are per instance. SSE requires proxy timeout/buffering configuration. There is no measured throughput/RAM benchmark and no promise of exactly-once delivery.

## Demo and screenshots

No hosted URL or captured screenshot is available yet. The local demo is the actual application, not a separate fake-data mode. Use two browser sessions to demonstrate admin/member permissions, live activity, read isolation, offline reconnect, and Redis outage recovery. [Demo instructions](docs/DEMO.md) include the checks and the screenshot list to capture after visual verification.

## Future improvements

First close the verification gaps and commit a dependency lockfile. Then add expiring invitations/password recovery, external ingestion with idempotency keys, shared throttling, periodic session cleanup, and event retention. Before more infrastructure, measure connection/query pressure; consider one batched catch-up per active workspace rather than one query per connection.

See [design and candidate scoring](docs/DESIGN.md) for the project evaluation and architecture rationale.
