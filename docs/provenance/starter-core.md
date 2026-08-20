# Starter Core provenance

## Transfer authority and baseline

This file records the bounded `S01` transfer from the independent Starter
repository into Planner. It does not establish a Git upstream, cherry-pick
compatibility, submodule, subtree, or runtime dependency between repositories.

| Role                  | Repository                                               | Branch                         | Revision                                   | State                                                    |
| --------------------- | -------------------------------------------------------- | ------------------------------ | ------------------------------------------ | -------------------------------------------------------- |
| Source                | `/Users/denischernykh/projects/starters/nest-js-starter` | `stage`                        | `a0c8e8002af59536dea3c8209fe527bd033b2eca` | clean; local and remote `stage` matched during preflight |
| Target baseline       | `/Users/denischernykh/projects/planner`                  | `main`                         | `c8dcfffd4808e167b333ee333f868555d0c91d67` | clean; local and remote `main` matched during preflight  |
| Target implementation | `/Users/denischernykh/projects/planner`                  | `agent/s01-toolchain-transfer` | commit containing this file                | resulting commit SHA is reported in the task handoff     |

## Source and target paths

The transfer is restricted to these source root mechanics and their adapted
target equivalents:

- `.nvmrc`, `package.json`, `pnpm-workspace.yaml` and generated target
  `pnpm-lock.yaml`;
- `tsconfig.base.json`, `tsconfig.json`, `tsconfig.build.json` and
  `tsconfig.test.json`;
- `jest.unit.config.mjs`, `jest.integration.config.mjs` and
  `jest.e2e.config.mjs`;
- `eslint.config.mjs`, `.prettierrc.json`, `.prettierignore` and
  `.dependency-cruiser.cjs`;
- `nest-cli.json` and `prisma.config.ts`.

Planner's existing `.gitignore` and `IMPLEMENTATION_PLAN.md` are adapted in
place. No source repository file is modified.

## Named consumers

- `S01` consumes Node/pnpm pins, strict TypeScript, Jest, formatting, linting,
  dependency boundaries and the compiled-build contract.
- `S02` consumes the Nest, Prisma, PostgreSQL and Testcontainers dependencies
  for the API, migrator and database foundation.
- `S03` consumes HTTP, OpenAPI, logging, trace and clock tooling.
- `S04` consumes auth Redis, HTTP test and session-foundation dependencies.

The initial executable consumer is
`test/unit/toolchain/planner-skeleton.spec.ts`; it verifies Planner metadata,
runtime pins, plain-pnpm scripts and the excluded dependency set.

## Failure model

- Source or target revision drift stops the transfer before edits; config is
  not copied from an unreviewed Starter revision.
- Node outside major 24 or pnpm other than `11.15.1` stops dependency-changing
  commands instead of silently changing repository policy.
- Registry or sandbox failure is retried only as the same ordinary
  host-capable `pnpm install`; frozen or local-store workarounds are not used.
- A lifecycle-script denial is resolved only with a package-specific
  `allowBuilds` decision. The build policy is never weakened globally.
- Scripts that reference absent runtime, Prisma schema, OpenAPI document,
  Docker or source helpers are excluded from the S01 command surface so a
  missing later artifact cannot create a false gate.
- Root configuration that imports product modules would blur ownership and is
  rejected by the transfer allowlist.

## Adaptations

- Package identity is `planner`; Node remains `>=24 <25`, pnpm remains exactly
  `11.15.1`, and selected dependencies retain exact source versions.
- Repository scripts invoke plain `pnpm`. The S01 `check:quick` contains only
  gates backed by artifacts present in this task.
- Build cleanup removes only target `dist` with Node's `fs.rmSync`; the Starter
  helper under `scripts/` is not transferred.
- `tsconfig.base.json` is transferred explicitly because every selected
  TypeScript configuration extends it.
- Existing approved root specifications are listed in `.prettierignore` rather
  than being reformatted as unrelated S01 changes.
- The outbox-specific positive exception is removed from dependency-cruiser.
  Queue package names remain only in deny rules that enforce framework-free
  inner layers.
- `pnpm-workspace.yaml` preserves exact dependency, peer and lifecycle policy
  while removing entries used only by excluded dependencies.

## Intentional exclusions

S01 does not transfer runtime source, product or demo modules, Prisma schema or
generated client, migrations, Docker/OCI assets, OpenAPI artifacts, Git hooks,
approval requests, password/email flows, BullMQ, ioredis, transactional
outbox, queues or their dependencies. Their absence is intentional and must
not be repaired by wholesale copying.

## Evidence boundary

The task handoff records the install, RED/GREEN unit test, formatting, lint,
typecheck, architecture, build and Git evidence. These local checks do not
prove GitHub CI, publication, deployment, Docker runtime, restore behavior or
completion of the full M0 milestone.

## S02 universal runtime Core transfer

### Source and target mapping

S02 was adapted from the independently verified clean source
`/Users/denischernykh/projects/starters/nest-js-starter`, branch `stage`, revision
`a0c8e8002af59536dea3c8209fe527bd033b2eca`. The target baseline is Planner
`ab3a38bba62e150d9b17ba4a214d63ef363e59e3` on
`agent/s02-universal-runtime`. No source file was changed and no commit
compatibility is implied.

- Starter `src/platform/config/runtime-*` maps to Planner
  `src/platform/config/**`, reduced to API/PostgreSQL settings.
- Starter `src/platform/database/**` and
  `src/shared/application/transaction.port.ts` map to Planner
  `src/platform/database/**` and the framework-free
  `src/shared/application/database-transaction.port.ts`.
- Starter `src/platform/lifecycle/**`, `src/platform/http/bootstrap/**` and
  `src/platform/http/health/**` map to the equivalent Planner platform paths.
- Starter `src/bootstrap/api/**` maps to a product-free Planner `ApiModule` and
  its listener-first startup/bounded shutdown runtime.
- Starter `prisma/schema.prisma`, database migration tests, health/shutdown E2E,
  `Dockerfile` and `docker-compose.yml` supply the adapted migration, runtime
  and local composition patterns.

### Named consumers and failure model

The API process consumes config, database lifecycle, health and active-request
tracking. The one-shot migrator consumes `prisma migrate deploy`. Later product
modules consume `DatabaseTransactionPort` without importing Prisma or `pg`.

The API opens its listener before PostgreSQL startup so liveness and the
startup latch remain observable. PostgreSQL startup failure prevents readiness;
a later outage removes readiness without reversing the startup latch. Drain is
monotonic, rejects readiness before listener closure, waits at most 6000 ms for
active requests and shares a 10000 ms process watchdog. API startup never runs
migrations. The synthetic Testcontainers role contract proves a split where the
runtime role has only explicitly granted DML and no DDL or migration-history
access; local Compose deliberately uses one convenience superuser credential
and does not prove production role isolation.

### Adaptations and exclusions

Planner has no Starter demo/auth composition. Readiness therefore has one
required PostgreSQL contributor and returns only stable status bodies without
driver details. The foundation migration intentionally creates no product or
probe table; the integration test creates and grants its own disposable probe.
Local Compose contains only PostgreSQL, migrator and API.

S02 excludes Redis, queues, BullMQ, transactional outbox, demo modules, auth,
Problem Details/OpenAPI, logging/observability, production deployment and hosted
behavior. Dependencies already pinned by accepted S01 remain unchanged; S02
adds no package.

### S02 evidence boundary

The S02 handoff records Prisma validation/generation, focused Testcontainers
integration/E2E, formatting, linting, typecheck, architecture, compiled build,
`check:quick`, Compose rendering and Git whitespace evidence. These local checks
do not prove a Docker image smoke, GitHub CI, publication, deployment, hosted
health, backup restore or completion of M0.

## S03 backend contract-boundaries transfer

### Source and target mapping

S03 selectively adapts the independently verified Starter source
`/Users/denischernykh/projects/starters/nest-js-starter`, `stage @
a0c8e8002af59536dea3c8209fe527bd033b2eca`, into Planner from baseline
`68b196ca55d93163c58a04fcbd759947b12407c8`. The containing target commit is
owned by the S03 controller; no source checkout is modified and no cherry-pick
compatibility is implied.

- Starter `src/platform/http/context/**`, `errors/**`, selected
  `bootstrap/configure-http-application.ts` and `docs/**` map to Planner
  `src/platform/http/{context,errors,bootstrap,docs}/**`.
- Starter
  `src/platform/http/policy/public-endpoint.decorator.ts` maps exactly to
  Planner `src/platform/http/policy/public-endpoint.decorator.ts`; the
  production `src/platform/http/health/health.controller.ts` consumes the
  marker. S04 authentication policy is the named future consumer: default
  authentication may be bypassed only when this unique metadata key is
  explicitly present on a controller or handler. Unmarked endpoints remain
  protected by default; S03 adds no guard, session or authentication behavior.
- Starter `src/platform/logging/**`, `src/platform/observability/**`,
  `src/bootstrap/observability/**`, `src/bootstrap/contracts/**` and
  `scripts/openapi/**` map to same-purpose Planner paths.
- Planner `src/shared/application/product-clock.ts` and
  `src/platform/time/system-product-clock.ts` are an adaptation: Starter has
  no neutral ProductClock.

### Named consumers, failure model and exclusions

The empty API runtime consumes correlation, validation, bounded body/server
policy, Problem Details and safe access/error logs. Product HTTP adapters will
consume the immutable problem catalog and deterministic offline OpenAPI artifact;
temporal product tests consume `ProductClock`. Invalid input, unknown failures,
malformed or oversized requests have safe typed HTTP responses; malformed IDs
are replaced; logger/exporter failure loses telemetry only. No rejected values,
secrets, raw identity, raw URL/query/body or error message/cause is a permitted
recorded field.

S03 deliberately excludes Starter service names/titles/tags/problem URIs,
demo/auth/cookie/CSRF/docs-access policy, Redis instrumentation, OIDC, sessions,
product modules, deployment assets, queues and outbox. The OpenAPI artifact is
Planner metadata only and production does not enable/regenerate public docs.

### S03 evidence boundary

Focused unit/E2E, offline generation/drift/lint, architecture and quick gates
are local evidence only. They do not prove collector availability, GitHub CI,
OCI publication, deployment, hosted HTTP behavior, Telegram smoke or restore.

## T10 planner-worker and REL-03 adoption

T10 selectively adapts the clean Starter repository at
`/Users/denischernykh/projects/starters/nest-js-starter`, where
`stage = origin/stage = a0c8e8002af59536dea3c8209fe527bd033b2eca`.
The transferred source paths are
`src/platform/maintenance/periodic-maintenance-runner.ts` and
`src/bootstrap/workers/run-worker-application.ts`, with their focused unit
suites. The periodic runner entered Starter through merge `c010753` and is
present at the pinned source SHA.

Planner adopts only the process-local non-overlapping timer, signal admission
and bounded drain. The named consumer is PostgreSQL-backed CloseWeek. Durable
due state is the immutable physical weekly period; stable group identity,
generation command identity, receipt replay, month locking and exact effect
constraints remain product-owned.
The worker performs one authoritative scan before readiness, then waits a fixed
delay between settled cycles. Restart repeats the scan; competing processes may
observe the same row but serialize through the database command key and month.

Planner installs signal admission before PostgreSQL connect and initial scan,
then adapts the standalone application helper to race process termination with
a failed maintenance loop and close PostgreSQL before the outer ten-second
deadline. Startup cancellation does not announce readiness. It excludes
Starter outbox, BullMQ, queue Redis, leases, retry state,
dead letters, HTTP health endpoints and deployment policy. The local Compose
service proves only executable composition; hosted readiness, multi-replica
rollout and recovery remain deployment evidence.

## S04 local User and opaque-session transfer

### Source and target mapping

S04 selectively adapts the independently verified clean Starter repository at
`/Users/denischernykh/projects/starters/nest-js-starter`, `stage =
origin/stage = a0c8e8002af59536dea3c8209fe527bd033b2eca`. The Planner target baseline is
`4db2af5687d522cfd1d4655a6f3b14db906e9c27` on
`agent/s04-local-user-opaque-session`; the S04 containing commit is assigned by
the controller. Neither repository becomes an upstream or runtime dependency
of the other.

- Starter `src/platform/redis/redis-client.factory.ts`,
  `redis-auth.connection.ts`, `redis-command.executor.ts`,
  `redis-key.builder.ts`, `redis-codec.ts`, `redis-script.runner.ts`,
  `redis-lifecycle.ts`, `redis-readiness.indicator.ts`, `redis.module.ts` and
  `redis.tokens.ts` map to the same Planner paths under
  `src/platform/redis/**`, reduced to one auth-only capability.
- Starter `src/modules/auth/application/session-store.port.ts`,
  `authenticate-session.use-case.ts`, `get-csrf-token.query.ts` and the neutral
  issue/revoke mechanics map to Planner `src/modules/auth/application/**`.
- Starter `src/modules/auth/infrastructure/node-auth-crypto.adapter.ts`,
  `session-record.codec.ts`, `redis-session.scripts.ts`,
  `redis-session.store.ts` and the local-User lookup extracted from
  `prisma-auth.repository.ts` map to Planner auth infrastructure.
- Starter `src/modules/auth/presentation/session-cookie.ts`,
  `auth-cookie.adapter.ts`, `authentication.guard.ts`,
  `auth-request.context.ts`, `auth-request.interceptor.ts`,
  `current-principal.decorator.ts`, `browser-origin.guard.ts` and
  `session-csrf.guard.ts` supply the browser boundary. Planner exposes only
  `GET /auth/me`, `GET /auth/csrf` and `POST /auth/logout`.
- Starter auth Problem contribution, OpenAPI security definitions, required
  Redis readiness/lifecycle, local Compose and real Redis test support map to
  the corresponding Planner platform, bootstrap, documentation and test
  paths. The PostgreSQL target adds only `users(id, created_at, updated_at)`.

### Named consumers and failure model

The global authentication guard is the immediate consumer of session
authentication and protects every route without exact `@PublicEndpoint`
metadata. A03 is the first production consumer of `IssueSessionUseCase`; S04
does not publish an issue endpoint or accept a `userId` from HTTP.

Issue verifies a pre-existing PostgreSQL User before any Redis write. Every
authenticated request rechecks that User. Missing, malformed, expired,
revoked, corrupt or missing-User sessions fail closed as
`AUTHENTICATION_REQUIRED`; Origin or CSRF rejection is
`AUTHORIZATION_DENIED`; PostgreSQL or auth-Redis failure is the safe core
`DEPENDENCY_UNAVAILABLE`. No failure mutates User state or returns driver,
connection URL, raw token or secret data.

The listener remains observable while PostgreSQL and auth Redis start in a
failure-atomic group. Initial readiness requires both. After the irreversible
startup latch, Redis loss leaves liveness/startup available while readiness and
session operations fail closed; recovery restores readiness. Database and
Redis cleanup share the S02 shutdown budget.

### Adaptations and exclusions

Planner removes Starter email/password, signup, approval, account status,
roles/RBAC, session listing, logout-all, rate limiting, device/network
fingerprints and user-session indexes. Each issue creates one independent
digest-addressed record. Atomic Lua create/touch/revoke keeps idle and absolute
expiry bounded without `KEYS` or resurrection. The raw 32-byte token remains
browser-only; Redis keys use its dedicated HMAC digest, while a separate secret
derives the session-bound CSRF token.

Only local `redis-auth` is added. Queue Redis, BullMQ, ioredis, outbox,
cache/pub-sub abstraction, Redis telemetry instrumentation, OIDC, allowlist,
external identity, workspace/membership, public provisioning and production
deployment configuration are intentionally absent. Package dependency sections
and `pnpm-lock.yaml` remain unchanged.

### S04 evidence boundary

Focused unit, real PostgreSQL/Redis integration, HTTP E2E, OpenAPI, Compose and
quick gates are local evidence. They do not prove GitHub CI, hosted runtime,
production credentials, OCI publication, deployment, backup restore, OIDC or
the later A01/A03 consumers.

## N03 Telegram outbound attempt ledger

### Source and target mapping

N03 consumes the independently verified Starter INT-01 merge commit
`a0c8e8002af59536dea3c8209fe527bd033b2eca` from
`/Users/denischernykh/projects/starters/nest-js-starter` `stage`. The source
checkout was clean; its local branch lagged `origin/stage` only by later INT-01
roadmap/status documentation commits. Planner starts from `5fa46c6` on
`agent/n03-telegram-outbound-attempt-ledger`.

Only the framework-free source path
`src/platform/http/outbound/fetch-outbound-http-attempt-transport.ts` and its
focused unit and loopback integration tests are transferred to the same target
paths. `BoundedOutboundHttpRunner` is intentionally excluded: retry sequencing,
durable state and restart recovery belong to Planner's PostgreSQL attempt ledger.

The named consumer is
`src/modules/telegram-bot/infrastructure/telegram-outbound.transport.ts`,
which implements the reminders application port
`ReminderDeliveryTransportPort`. Recipient resolution is a workspace-owned
`memberId → allowlisted Telegram ID` port; reminders does not query workspace
tables directly.

### Failure model and adaptations

The adapter performs one bounded native-fetch `sendMessage` attempt with the
existing Telegram token, timeout, response-body bounds and redirect rejection.
Accepted responses, retryable `429 retry_after`/`5xx`, terminal blocked or
chat-not-found errors, and ambiguous timeout/transport/malformed/oversized
responses are mapped to finite safe outcomes. Raw token, Telegram ID,
provider description, request body and rendered private content never enter
logs or attempt rows.

N03 adds the Planner-owned append-only `notification_attempts` ledger and
creates the initial `prepared` attempt atomically with the immutable N02
notification intent. Fencing protects `dispatching` and terminal completion;
orphaned `prepared` rows can be reclaimed, while orphaned `dispatching` rows
become terminal `ambiguous` and are never blindly resent. N03 records
retryable outcomes for the later N05 worker but does not own schedule,
template or retry policy.

### Evidence boundary

The INT-01 transfer tests, Telegram fake-provider contract tests, PostgreSQL
ledger recovery integration and local quick gates are local evidence. They do
not prove live Telegram delivery, hosted restart behavior, provider-side
acceptance, GitHub CI, deployment or pilot readiness.

The recovery suite also applies N02 migrations with a populated legacy intent
before applying N03 and verifies the upgrade backfill creates its initial
prepared attempt; stale completion is checked against the authoritative
occurrence fence and lease.
