# Local restore drill evidence

Date: 2026-08-23 (Asia/Yekaterinburg)

## Scope and baseline

- Repository: `/Users/denischernykh/projects/planner`
- Branch: `agent/o02-separate-database-restore`
- Baseline: `b7b0b93016fa4c5b7e66fb2f962829812ff747e0`
- Toolchain: Node `v24.18.0`, pnpm `11.15.1`
- Docker: host-capable Testcontainers run with pinned PostgreSQL `18.4` and
  Redis `8.8.0` image digests from the smoke script.

## Commands and exit codes

The key is intentionally omitted. The command below generates it in memory,
does not print it, and passes it only to the smoke process:

```sh
env PLANNER_O02_BACKUP_KEY="$(node -e 'process.stdout.write(require("node:crypto").randomBytes(32).toString("base64url"))')" \
  pnpm exec tsx scripts/smoke/planner-restore-smoke.ts
# exit 0
```

Focused probes:

```sh
pnpm exec tsx scripts/smoke/planner-restore-guard-probe.ts
# exit 0
pnpm exec tsx scripts/smoke/planner-restore-manifest-probe.ts
# exit 0; marker secret absent from mismatch output
pnpm exec tsx scripts/smoke/planner-restore-cleanup-probe.ts
# exit 0; volume listing/stat verification failures fail closed
```

Final successful run:

- run: `o02-mt64f2m6-55442ec5`
- encrypted backup: `591502` bytes,
  SHA-256 `b00906960fdcd8f85355d60120ebba5b4bd771e3376f64b39f00bd4224365b7b`
- source Redis: DBSIZE `2`, session keys `2`
- target Redis: DBSIZE `0`
- migrations: `32`, inventory digest
  `fac23ff1068d872caee1973155c1da3d34e934a3a460113a04141c006ce2475e`
- measured durations: backup `119 ms`; restore + migrations + verification
  `765 ms`; total drill `7116 ms`
- cleanup: `containers=0 volumes=0 temp_artifact=removed`

The smoke asserted distinct source/target PostgreSQL container IDs and
persistent mount sources, authenticated the envelope before target mutation,
proved one-byte tampering failed authentication, restored with the required
`pg_restore` flags, ran `pnpm start:migrate`, and deep-compared the manifests.

Safe manifest counts and digest prefixes from the successful output:

```text
users=2/6773396f32d21015
memberships=2/fbb2f3be76d11e86
externalIdentities=2/0cbcf0de1dced6c9
planMonths=2/69a2d0a13281cf38
publications=1/dc69232df99b5c19
goalSnapshots=41/b03eb3d1bb597aca
trackingFactRecords=9/04677a77d000b47e
trackingFactRevisions=11/7ca0db9a809c09e8
trackingActionGroups=10/60197246e90918f6
trackingFactChanges=11/ded634e37516ba96
reminderSchedules=1/34c9e8b745e56c0f
reminderScheduleSlots=3/42129ab72974d282
reminderOccurrences=2/3d9ee6859f8eaf20
notificationIntents=1/16682952f77b223c
notificationAttempts=1/978ed449c68d7ee8
reportRevisions=2/33cfdc4345ad23de
```

The source manifest contained users/memberships/external identities, an active
April publication and 41 goal snapshots, facts revision/current pointers and
full fact revision chains, one pending occurrence with one terminal retryable
attempt, and both original/revised reports. Restored report payload checksums
were recomputed and matched their stored checksums.

Controlled failure probe:

```sh
env PLANNER_O02_FAIL_AFTER_BACKUP=1 \
  PLANNER_O02_BACKUP_KEY="$(node -e 'process.stdout.write(require("node:crypto").randomBytes(32).toString("base64url"))')" \
  pnpm exec tsx scripts/smoke/planner-restore-smoke.ts
# smoke exit 1 (expected); scoped cleanup: containers=0 volumes=0 temp_artifact=removed
```

Run `o02-mt64fgf1-df7e1d29` produced an encrypted artifact, failed at the
controlled point before target creation, returned exit 1, and removed its
owned containers, volumes and temporary artifact. Independent exact-label
Docker queries returned no containers and no volumes.

Signal cleanup probe:

```sh
PLANNER_O02_WAIT_FOR_SIGNAL_AFTER_BACKUP=1 \
  PLANNER_O02_BACKUP_KEY="$(node -e 'process.stdout.write(require("node:crypto").randomBytes(32).toString("base64url"))')" \
  pnpm exec tsx scripts/smoke/planner-restore-smoke.ts
# SIGINT after signal-probe-ready; exit 130; no PASS; scoped cleanup proved
# containers=0 volumes=0 temp_artifact=removed
```

Run `o02-mt64g1fm-c2fc37fa` reached `signal-probe-ready`, received SIGINT,
returned exit 130 and printed no PASS. Independent exact-label Docker queries
returned no containers and no volumes.

The final full `pnpm check` on this amended candidate completed with exit 0:
unit `607/607`, contract `111/111`, integration `288`, E2E `105`.

## Evidence boundary

These are local timing and recovery observations only. They do not prove
production RPO ≤ 1 hour, RTO ≤ 4 hours, retention, PITR, off-host storage,
hosted behavior, GitHub CI, deployment, TLS/DNS, or live Telegram/OIDC.
