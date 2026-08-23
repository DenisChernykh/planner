# Planner: локальный backup/restore drill

Этот runbook описывает только локальный O02 restore drill. Smoke поднимает
две отдельные PostgreSQL instance и два отдельных Redis контейнера,
восстанавливает только PostgreSQL и удаляет все принадлежащие drill ресурсы
по завершении. Production deployment, off-host storage, retention и PITR сюда
не входят.

## Prerequisites

- Node.js `24.x` и pnpm `11.15.1` согласно `package.json`.
- Docker Engine/Desktop с доступным Docker socket.
- Чистый или проверенный рабочий tree с актуальными миграциями.
- Loopback-порты, доступные Testcontainers.

Проверка toolchain:

```sh
node --version
pnpm --version
```

## One-time key

Ключ smoke — ровно 32 байта, canonical base64url. Не записывайте его в
команду, файл, `.env`, журнал CI или shell history. Сгенерируйте его в
памяти и передайте через скрытый prompt:

```sh
node -e 'process.stdout.write(require("node:crypto").randomBytes(32).toString("base64url") + "\n")' | pbcopy
read -r -s 'PLANNER_O02_BACKUP_KEY?Paste the one-time key: '
print
export PLANNER_O02_BACKUP_KEY
```

После drill удалите переменную:

```sh
unset PLANNER_O02_BACKUP_KEY
```

Smoke удаляет ключ из окружения дочерних процессов и зануляет Buffer при
завершении. Ключ не выводится в лог.

## Restore smoke

```sh
pnpm exec tsx scripts/smoke/planner-restore-smoke.ts
```

Smoke выполняет следующий локальный сценарий:

1. Проверяет внешний key contract и печатает только run-scoped recovery scope.
2. Поднимает source PostgreSQL/Redis с уникальными names/labels и запускает
   только `test/e2e/pilot/full-month-pilot.e2e.spec.ts` в guarded external E01
   режиме. E01 создаёт authenticated sessions и reminder retryable attempt
   через application pipeline.
3. Берёт source manifest одной `REPEATABLE READ READ ONLY` transaction.
4. Выполняет `pg_dump --format=custom --no-owner --no-acl` внутри source
   container. stdout сразу шифруется в `0600` AES-256-GCM envelope; plaintext
   dump не создаётся.
5. Проверяет tamper failure и authentication до любой target mutation.
6. Поднимает отдельный target PostgreSQL/Redis, проверяет отличия PostgreSQL
   container ID и persistent mount source, а target Redis оставляет пустым.
7. Подаёт authenticated plaintext stream в
   `pg_restore --single-transaction --exit-on-error --no-owner --no-acl`, затем
   запускает repository-owned `pnpm start:migrate` против target.
8. Сравнивает source/target manifest, пересчитывает
   `reportPayloadChecksum`, сверяет migration inventory и печатает только
   counts/digests/durations.

Перед migrations guarded E01 принимает только loopback effective PostgreSQL и
Redis endpoints без query override/fragment, проверяет `current_database()` и
отвергает любой пользовательский schema object (включая view, sequence,
function, type и extension-owned object).

Cleanup proof использует успешный read-only `docker volume ls` для каждого
собственного volume и сравнивает exact name; ошибки listing/daemon/permission/
timeout не считаются отсутствующим volume. Для temporary root только ENOENT
означает отсутствие; остальные stat errors останавливают drill.

Redis никогда не получает backup artifact. После restore target Redis пустой:
web users должны выполнить повторный OIDC login, потому что auth sessions —
короткоживущий cache/ceremony state, а не источник истины PostgreSQL.

## Controlled failure and cleanup

Для отдельной проверки failure path один раз запустите:

```sh
PLANNER_O02_FAIL_AFTER_BACKUP=1 pnpm exec tsx scripts/smoke/planner-restore-smoke.ts
```

Ожидается ненулевой exit после создания encrypted backup; это не GREEN
результат. В любом пути smoke останавливает только свои Testcontainers,
удаляет свой временный encrypted artifact и печатает
`containers=0 volumes=0 temp_artifact=removed` только после реальной scoped
проверки. Не используйте `docker system prune`, широкие удаления volumes или
unresolved globs.

Для детерминированной проверки signal cleanup после encrypted backup:

```sh
PLANNER_O02_WAIT_FOR_SIGNAL_AFTER_BACKUP=1 \
  pnpm exec tsx scripts/smoke/planner-restore-smoke.ts
```

Дождитесь `signal-probe-ready: run=<run-id>`, отправьте этому процессу
`SIGINT` и ожидайте exit `130`, строки `INTERRUPTED`, отсутствия `PASS` и
`containers=0 volumes=0 temp_artifact=removed`. SIGTERM использует тот же
cleanup path.

Если процесс был прерван жёстко, используйте напечатанный run id и сначала
проверьте только его scope:

```sh
docker ps -a --filter 'label=planner.o02.run=<run-id>' --format '{{.ID}} {{.Names}}'
```

Дальше удаляйте только явно перечисленные ID/volumes этого run после
`docker inspect`; чужие контейнеры, volumes и Docker state не затрагивайте.

## Diagnosis

- `Could not find a working container runtime strategy` означает, что текущий
  процесс не видит Docker runtime; повторите тот же command в host-capable
  terminal.
- Если E01 не проходит, проверяйте только source container readiness и
  guarded loopback/database-name/empty-database validation.
- Если target Redis не пуст, drill должен завершиться ошибкой: Redis backup
  или reuse target запрещены.
- Если mount sources совпали, target не является отдельной persistent
  instance и drill должен завершиться ошибкой.
- Если migration inventory отличается, сначала сверяйте `prisma/migrations`
  и `_prisma_migrations`; не применяйте ручные SQL исправления.
- В логах не должны появляться ключ, credentials-bearing URLs, Telegram IDs,
  tokens или пользовательский текст.

## Boundary

Этот runbook доказывает только локальный populated PostgreSQL backup/restore
и пустой restored auth Redis. Он не доказывает production RPO ≤ 1 часа, RTO ≤
4 часов, retention, PITR, off-host durability, backup key management,
hosted behavior, GitHub CI, deployment, TLS/DNS, live Telegram или OIDC.
