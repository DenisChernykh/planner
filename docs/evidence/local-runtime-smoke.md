# Local runtime smoke evidence

Date: 2026-08-23 (Asia/Yekaterinburg)

## Evidence boundary

This is local evidence from branch `agent/o01-local-runtime-smoke`, starting at
predecessor `dc8059049c9cdd3f32d8f0d0635da10acd1d4467` with a clean baseline.
It does not prove GitHub CI, OCI publication, deployment, HTTPS/DNS, BotFather
settings, hosted/live OIDC or Telegram calls, production ingress, production
credential isolation, or backup/restore (O02).

## Toolchain

```text
Node v24.18.0
pnpm 11.15.1
Docker 29.4.3, build 055a478
Docker Compose v5.1.3
```

## Commands and observations

The executable contract was first run before Compose changes:

```sh
pnpm exec tsx scripts/smoke/planner-runtime-smoke.ts
```

It returned exit `1` before resource creation because the predecessor worker
command was `pnpm start:planner-worker` instead of the direct Node command.

After the Compose, Dockerfile and `.dockerignore` changes, and after the
corrective smoke assertions:

```sh
TELEGRAM_BOT_TOKEN='o01-smoke-token-static-only' docker compose config --quiet
pnpm exec tsx scripts/smoke/planner-runtime-smoke.ts
git diff --check
```

The config and diff checks returned exit `0`. The latest smoke returned exit
`0` for isolated project `planner-o01-mt5t5hjz-2ccvaz` using image tag
`planner:o01-mt5t5hjz-2ccvaz`, generated loopback ports `52091`, `52092` and
`52093`, and a graceful-stop timing of `207ms`. It proved:

- exactly five services and project-owned containers;
- pinned PostgreSQL/Redis images, healthy dependencies and one-shot migrator;
- 32 successful `_prisma_migrations` entries matching local migration
  directories;
- API live/startup/ready exact `200 {"status":"ok"}` responses;
- fresh `notification_attempts` count `0`;
- paused auth Redis kept live/startup at exact `200 ok` and changed ready to
  exact `503 {"status":"unavailable"}`; readiness recovered after unpause;
- API and worker remained up for at least 10 seconds, then each received an
  in-container `SIGTERM` to PID 1 and restarted automatically with increased
  restart count and a new worker readiness event; migrator timestamps and
  restart count stayed unchanged;
- Compose graceful stop of API and worker completed in `207ms`, both exited
  `0`, neither was `137`/OOM-killed, and manual stop did not auto-restart;
- explicit start restored API readiness and worker readiness;
- migration inventory and `notification_attempts = 0` remained unchanged.

The smoke printed a project-scoped recovery command before resource creation.
Cleanup ran `down --volumes --remove-orphans` only for the generated project,
removed only its unique image tag, and verified no project containers, volumes,
network or image tag remained. No token, Telegram ID, user text or other PII was
printed.

Two controlled interrupt probes completed with strict scoped cleanup. Probe A
interrupted resource creation for project `planner-o01-mt5t2ntu-2v88dj` and
image `planner:o01-mt5t2ntu-2v88dj`; SIGINT returned exit `130`, and no project
containers, volumes or network remained. Probe B used a temporary untracked
Docker shim to delay the project `down` command for
`planner-o01-mt5t3i8s-lqnlvl` / image `planner:o01-mt5t3i8s-lqnlvl`; SIGINT was
addressed to the Node smoke process after cleanup started, cleanup completed,
and exit was `130`. Both probes verified no scoped containers, volumes or
network, and image inspection returned the expected `No such image`. The
temporary shim and its marker files were removed.

## Aggregate gate

Four earlier plain `pnpm check` attempts had transient local Docker
Testcontainers port-binding failures. Three executor runs reached E2E and
failed while PostgreSQL containers waited for random host ports to bind; one
coordinator run failed in integration before tests on the same Testcontainers
port-binding timeout. Those observations are retained as local infra
diagnostics, not as product failures. The subsequent debug and plain aggregate
gates passed:

```sh
DEBUG=testcontainers pnpm check
pnpm check
```

Both commands returned exit `0`: quick/unit `607/607`, contract `111/111`,
integration `31` suites / `288/288`, and E2E `26` suites / `105/105`.

After the final explicit child lifecycle, timeout fallback and interrupt
cleanup fixes, the plain host-capable gate was rerun without `DEBUG`:

```sh
pnpm check
```

It returned exit `0` with the same complete totals: quick/unit `607/607`,
contract `111/111`, integration `31` suites / `288/288`, and E2E `26` suites /
`105/105`.

The focused post-smoke gates also returned exit `0`:

```sh
pnpm exec eslint scripts/smoke/planner-runtime-smoke.ts --max-warnings=0
pnpm run typecheck
TELEGRAM_BOT_TOKEN='o01-smoke-token-static-only' docker compose config --quiet
git diff --check
pnpm exec prettier --check scripts/smoke/planner-runtime-smoke.ts docker-compose.yml docs/runbooks/planner-local-operations.md docs/evidence/local-runtime-smoke.md IMPLEMENTATION_PLAN.md
```

## Explicit exclusions

- CI and hosted behavior;
- HTTPS/DNS and production ingress/deployment;
- BotFather configuration;
- hosted/live OIDC and Telegram provider calls;
- production credential isolation;
- encrypted backup, restore and recovery drill (O02).
