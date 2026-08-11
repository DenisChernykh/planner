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
