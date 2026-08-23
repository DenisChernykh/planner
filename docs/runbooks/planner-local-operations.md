# Planner: локальные операции

Документ описывает только локальный Docker Compose runtime Planner. Он не
описывает production deployment, HTTPS, Telegram ingress или backup/restore.

## Prerequisites

- Docker Engine/Desktop и Docker Compose доступны в `PATH`.
- Node.js 24 и pnpm 11.15.1.
- Рабочий tree содержит актуальные `docker-compose.yml`, `Dockerfile` и
  миграции.
- Для worker задайте локальный токен в окружении процесса. В zsh используйте
  скрытый prompt: значение не выводится и не попадает в shell history:

```sh
read -r -s "TELEGRAM_BOT_TOKEN?Telegram bot token (input hidden): "
print
export TELEGRAM_BOT_TOKEN
```

## Normal local start

```sh
docker compose up -d --build --wait
```

Сервисы используют loopback host ports `5432`, `6379` и `3000` по умолчанию;
их можно заменить через `POSTGRES_PORT`, `REDIS_AUTH_PORT` и `API_PORT`.

| Service          | Role                             | Readiness/condition                                     |
| ---------------- | -------------------------------- | ------------------------------------------------------- |
| `postgres`       | Product PostgreSQL               | Compose healthcheck `pg_isready`                        |
| `redis-auth`     | Opaque web-session/OIDC Redis    | Compose healthcheck `redis-cli ping`                    |
| `migrator`       | One-shot Prisma migration runner | Starts after healthy PostgreSQL; must exit `0`          |
| `api`            | HTTP API and health endpoints    | Starts after successful migrator and healthy auth Redis |
| `planner-worker` | Reminder/month lifecycle worker  | Starts after successful migrator; readiness log below   |

## Status and health

```sh
docker compose ps
curl -fsS http://127.0.0.1:3000/health/live
curl -fsS http://127.0.0.1:3000/health/startup
curl -fsS http://127.0.0.1:3000/health/ready
worker_id="$(docker compose ps -q planner-worker)"
[[ -n "$worker_id" ]] || { print -u2 'planner-worker container is missing'; exit 1; }
worker_running="$(docker inspect --format '{{.State.Running}}' "$worker_id")"
[[ "$worker_running" == 'true' ]] || { print -u2 'planner-worker is not running'; exit 1; }
worker_started_at="$(docker inspect --format '{{.State.StartedAt}}' "$worker_id")"
docker logs --since "$worker_started_at" "$worker_id" \
  | rg -F '{"event":"planner_worker_ready","module":"bootstrap"}'
```

The three successful health responses are exactly `{ "status": "ok" }`. The
worker readiness oracle above resolves the current container and its exact
`StartedAt` before reading logs. It therefore cannot mistake an event from an
older boot for current readiness; reading all historical logs without
`--since` is not sufficient. The exact structured event is:

```json
{ "event": "planner_worker_ready", "module": "bootstrap" }
```

## Restart, stop and logs

```sh
docker compose restart api planner-worker
docker compose stop api planner-worker
docker compose start api planner-worker
docker compose logs --follow --no-color api planner-worker
docker compose logs --no-color --tail=100 migrator
```

The configured `stop_grace_period` for API and worker is 15 seconds. A manual
Compose stop suppresses `unless-stopped` auto-restart until an explicit start.
An unexpected in-container termination signal is different from
`docker kill` on Docker Desktop: manual `docker kill` marks the container as
manually stopped and is therefore not the crash-restart test mechanism.

## Migration and dependency diagnosis

```sh
docker compose ps migrator
docker compose logs --no-color migrator
docker compose exec -T postgres psql -U planner -d planner -c \
  'SELECT migration_name, finished_at, rolled_back_at FROM _prisma_migrations ORDER BY migration_name'
docker compose exec -T postgres psql -U planner -d planner -c \
  'SELECT count(*) FROM notification_attempts'
```

If API readiness is `503`, check PostgreSQL and `redis-auth` health first, then
inspect API logs. Readiness intentionally returns only
`{ "status": "unavailable" }` and does not expose driver details.

## Persistent volumes

The Compose project owns `postgres-data` and `redis-auth-data`; they persist
across ordinary `stop`, `start` and container recreation. **Warning:
`docker compose down --volumes --remove-orphans` destroys the local database
and auth Redis data.** Use it only when intentionally resetting local state or
cleaning an isolated smoke project.
