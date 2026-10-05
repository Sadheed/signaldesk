# SignalDesk interview notes

## A 60-second explanation

"SignalDesk is a team activity inbox. Admins publish deployment, incident, and announcement updates; members see them live and track personal read status. I used Node.js and TypeScript for the REST API and SSE connections, PostgreSQL for durable events and sessions, and Redis pub/sub for cross-instance wake-up hints. Redis is not the source of truth: disconnected clients catch up from PostgreSQL using a cursor, and periodic reconciliation repairs missed hints. The React frontend demonstrates the entire workflow. Local unit/HTTP tests and real SQL checks passed; full adapter integration, Docker, type/lint checks, and visual verification remain pending in the restricted build environment."

Do not replace the last sentence with a claim that all checks passed until they have actually run.

## Why this architecture

The problem is one-way activity delivery plus historical lookup. One server, a relational database, and a fan-out mechanism cover those needs. No microservices or custom queue is required. PostgreSQL keeps state; Redis wakes other instances; SSE carries updates; REST handles commands/history. Redis is useful when browser connections are distributed across processes, where an in-memory emitter cannot reach the other process.

## Why Node.js is appropriate

The backend spends much of its time waiting for database, Redis, and socket I/O. Async Node APIs allow the event loop to keep handling other connections during those waits. This does not make CPU-intensive code magically parallel: synchronous large JSON processing or cryptography would block responsiveness. Bodies are limited, replay loads small batches, and password hashing uses asynchronous scrypt. The worker pool still has capacity limits, so hashing is admission-limited.

Concrete Node topics to demonstrate in the repository:

- `server/realtime/writer.ts`: `Writable.write()` returning false, waiting for `drain`, deadlines, disconnect cleanup.
- `server/realtime/hub.ts`: per-connection state, coalesced wake-ups, async replay, cancellation, interval cleanup.
- `server/security.ts`: asynchronous crypto, random tokens, timing-safe verification.
- `server/main.ts`: HTTP lifecycle, SIGTERM/SIGINT, dependency closure, shutdown deadline.
- `tests/api/stream.test.ts`: real HTTP streaming and native fetch readers.

## Redis and delivery guarantees

Redis pub/sub is ephemeral and at-most-once. An offline subscriber misses a published message. SignalDesk therefore publishes only a workspace hint after committing the event to PostgreSQL. A subscriber always queries the durable database. Periodic reconciliation covers both a missing hint and a crash between commit and publish. Reconnect may redeliver an event; the frontend deduplicates by event ID. There is no exactly-once claim.

An outbox would be appropriate if a downstream side effect, such as charging a card or sending an external message, required reliable execution. This MVP promises stored history and recoverable inbox updates, for which polling reconciliation is simpler. It does not implement a general message broker.

## Concurrency and ordering

Each workspace has a bigint counter. Incrementing it in the same transaction as event insertion takes a row lock, so publishers for that workspace wait for the preceding transaction to end. Rollback undoes both the increment and the insert. Different workspaces have different rows and do not serialize on the same application counter.

A naive global sequence can allocate 10 to one transaction and 11 to another, while 11 commits first. Advancing a cursor to 11 before 10 commits can permanently skip event 10. The workspace counter avoids that commit-order gap by serializing allocation/insertion per workspace. It trades throughput for a straightforward ordering guarantee; it is not an unrestricted high-throughput event-log design.

Other concurrency boundaries:

- Per-user read receipts have a composite primary key; repeated read requests are idempotent.
- A stream has one active replay pump. Repeated hints set a wake-up flag rather than launching overlapping writes.
- A stream queries at most 50 events per batch and respects writable backpressure.
- String cursors avoid Number precision loss; compare them as BigInt.
- Connections are capped per process/per user within a process. These are safeguards, not distributed quotas.

## Failure scenarios

| Failure                                  | Behavior                                                               | Limitation                                                             |
| ---------------------------------------- | ---------------------------------------------------------------------- | ---------------------------------------------------------------------- |
| Redis fails after DB commit              | HTTP event remains successful; reconciliation finds it                 | Live latency can increase to the reconciliation interval               |
| Publisher crashes before publishing hint | Event stays stored and later catch-up sees it                          | No external side-effect execution guarantee                            |
| Browser disconnects                      | Reconnect uses Last-Event-ID to resume                                 | Duplicate delivery remains possible                                    |
| Browser drains too slowly                | Stream hits deadline and disconnects                                   | Repeatedly slow clients may repeatedly reconnect                       |
| Session revoked/expired                  | REST rejects it; stream rechecks session during reconciliation/batches | Revocation is not instantaneous at the exact write instruction         |
| PostgreSQL unavailable                   | Writes fail; readiness degrades; stream reconnects                     | Database availability remains a core dependency                        |
| Insert fails after counter update        | Transaction rolls both operations back                                 | Application must not run the two statements separately                 |
| Shutdown                                 | Close streams, stop requests, close adapters, hard deadline            | Process termination during a transaction relies on PostgreSQL rollback |

## Bottlenecks and what changes at 10x scale

Do not claim measured capacity. The largest obvious cost is one catch-up query and session lookup per connected stream every interval, plus hint-triggered queries. At 10x connections, measure query count, database pool wait, RSS, event-loop delay, live delivery latency, and disconnect rate. Then share one bounded catch-up process per active workspace and fan out to authenticated local connections. Keep slow-consumer state independent.

A single busy workspace also serializes publishing on one counter row. Measure lock wait before replacing the ordering mechanism. Add retention and session cleanup to constrain table growth. Introduce shared auth throttling when multiple instances require a combined limit. Configure reverse proxies for unbuffered SSE and enough timeouts/connections. Add read replicas only after deciding which consistency lag the feed can tolerate. Larger infrastructure is a response to evidence, not a resume checklist.

## Security considerations

Passwords use salted scrypt; random session tokens are hashed at rest. The browser receives an HttpOnly, SameSite=Strict cookie; production also sets Secure and requires an HTTPS application origin. Browser mutation origins must match configuration. SQL uses parameters; schemas validate IDs, event types, body lengths, and publication input. Account role/workspace comes from the session rather than submitted IDs. React renders text instead of injecting HTML. Security headers and JSON size limits are set centrally. Logs omit sensitive payloads and raw credentials.

The MVP is deliberately incomplete as an account-management product: there is no email verification, invite flow, password change/reset, or shared abuse-control service. Admin-provisioned demo passwords must not be reused personal passwords. Avoid presenting the project as production-ready until those limitations and outstanding checks are addressed.

## Likely interview questions

**Why not WebSockets?**

Notifications need server-to-browser delivery only. SSE gives a standard HTTP stream and browser reconnect handling. Commands use REST. I would reconsider WebSockets for bidirectional collaboration, chat presence, or frequent client messages.

**Why both PostgreSQL and Redis?**

PostgreSQL owns durable events, access relationships, sessions, and read receipts. Redis broadcasts wake-up hints across server instances. Redis failures must not erase history, and PostgreSQL alone would require every instance to discover updates solely by polling.

**What does backpressure mean in your code?**

When `response.write()` returns false, the response's writable buffer has reached its threshold. The replay pump stops producing until `drain`, rather than filling an unbounded array. A timer and abort signal prevent a stalled connection from waiting forever; tests hold a Writable callback to prove the producer waits.

**What is your delivery guarantee?**

Stored events are committed transactionally; catch-up reads them. The transport can replay duplicates, so I deduplicate IDs. Redis hints are at-most-once and not durable. I do not promise exactly-once delivery or reliable external job execution.

**Why is a JWT not necessary?**

I need revocable browser sessions, not stateless cross-service identity. An opaque token plus a database session gives logout revocation and expiry checks. The cost is a database lookup. That is explicit and acceptable for this scope.

**How do you prevent data from another workspace appearing?**

The authenticated actor contains the workspace ID. SQL history, replay, member lookup, and read mutation constrain that ID. The client cannot select its workspace by changing a request parameter. HTTP tests and the unrun full adapter suite cover cross-workspace access; actual SQL constraint/order tests are separate evidence.

**What if an event commits but the HTTP response is lost?**

The client may retry and create a duplicate because event creation has no idempotency key. This is a documented limitation. I would add a unique workspace/idempotency-key constraint for external ingestion or clients that need safe command retries.

**How did you test it?**

Local evidence: 10 unit tests, 12 real HTTP/SSE tests with test-only adapters, 3 actual PostgreSQL CLI checks, and a frontend build. Separate full adapter tests cover database-backed auth, transaction ordering, rollback, Redis fan-out, and cross-instance SSE, but could not run locally because npm dependencies were unavailable. CI is defined, not claimed green. Explain this distinction plainly.

**Why didn't you write a job queue from scratch?**

It does not solve the selected product's current problem. Correct leases, retries, delayed jobs, crash recovery, and poison-job handling would shift the project toward infrastructure work while adding little to an activity-inbox demo.

## Deliberately not implemented

Microservices, Kubernetes, Kafka, email/mobile push, scheduling, rich HTML, analytics, and AI features. Existing Python projects already show ERP/AI experience; this project focuses on Node I/O, streaming, state boundaries, and frontend/backend integration. Stretch work is scoped in the design document, not represented as completed functionality.
