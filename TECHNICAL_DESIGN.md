# Backend Technical Design: «План на месяц»

**Статус:** утверждённый backend baseline; implementation planning начат  
**Дата фиксации:** 2026-08-11  
**Продуктовые источники:** [PRD.md](./PRD.md), [USER_FLOWS.md](./USER_FLOWS.md), [SCREEN_MAP.md](./SCREEN_MAP.md), `monthly-plan-template`

## 1. Назначение документа

Документ определяет техническую архитектуру backend закрытого планировщика для
одной пары. Он переводит продуктовые требования в границы модулей, модель
данных, атомарные операции, контракты каналов, failure model и проверки.

Документ не является списком задач. Последовательность реализации приведена
только как карта зависимостей. Небольшие исполняемые задачи находятся в
отдельном [IMPLEMENTATION_PLAN.md](./IMPLEMENTATION_PLAN.md).

Decision lock не означает неизменяемость навсегда. Изменение утверждённого
решения требует явной записи нового решения, оценки совместимости, миграции
данных и обновления затронутых контрактов и тестов.

## 2. Scope и источники истины

### 2.1. В scope

- backend веб-версии и Telegram-интерфейса;
- Telegram-only human identity;
- одно закрытое пространство пары;
- каталог целей, линии целей и месячные планы;
- публикация неизменяемых снимков;
- все типы фактов и правила повторения из PRD;
- общие команды для web и Telegram;
- уведомления и Telegram delivery;
- расчёт прогресса и воспроизводимый отчёт;
- runtime-роли, наблюдаемость, безопасность и deployment gate;
- правила осознанного переноса capability между Planner и
  `nest-js-starter`.

### 2.2. Не в scope этого документа

- визуальная архитектура web frontend;
- нативные приложения;
- несколько пространств и публичная регистрация;
- автоматический импорт DOCX;
- rule-based парсер свободного текста;
- будущая ИИ-интерпретация свободного текста;
- выбор VPS, облачного провайдера или reverse proxy;
- подробный implementation plan и task breakdown.

### 2.3. Иерархия требований

1. Явно утверждённые решения этого Technical Design определяют техническую
   реализацию.
2. PRD определяет продуктовые правила и формулы.
3. User flows определяют пользовательские сценарии.
4. Screen map определяет поверхности и состояния UI.
5. Исходный DOCX и карта источника определяют происхождение стартового seed.

При обнаружении расхождения документы синхронизируются до реализации. Код не
должен выбирать один из противоречащих контрактов молча.

## 3. Архитектурная форма

### 3.1. Выбранный подход

Planner строится как модульный монолит на NestJS с PostgreSQL как источником
истины. Продукт мал по нагрузке, но имеет насыщенные транзакционные инварианты;
единая база и единые транзакции важнее независимого масштабирования сервисов.

Backend имеет три runtime-роли:

| Роль | Ответственность |
| --- | --- |
| `api` | HTTP API, web-сессии, OIDC callback, Telegram ingress и query endpoints |
| `planner-worker` | due-scan уведомлений, leases, delivery attempts и автоматическое закрытие месяца |
| `migrator` | одноразовое применение миграций до запуска runtime |

PostgreSQL хранит продуктовые данные, расписания, idempotency receipts,
module-owned history и отчёты. Redis пилота используется только для opaque
web-сессий. Queue Redis, BullMQ и transactional outbox не подключаются без
отдельно доказанной необходимости.

### 3.2. Почему не микросервисы

- `PublishMonth` и `CloseMonth` требуют атомарных изменений нескольких наборов
  данных;
- нагрузка двух пользователей не требует независимого масштабирования;
- сетевые контракты и distributed transactions добавили бы failure modes без
  продуктовой пользы;
- модульные порты позволяют позже выделить runtime без раннего разделения
  данных.

### 3.3. Почему нет глобального command bus и event sourcing

Прямые application commands, optimistic concurrency, durable receipts,
append-only revisions и module-owned action history уже обеспечивают
маршрутизацию, повторяемость, аудит и восстановление. Глобальная шина или event
sourcing создали бы второй механизм координации без независимого потребителя и
не устранили бы необходимость в транзакционных инвариантах.

## 4. Независимость Planner и Starter

### 4.1. Relationship

Planner и `nest-js-starter` — самостоятельные репозитории со своими remote,
CI, релизами и зависимостями. Общая Git-история не требуется и не используется
как механизм синхронизации. Между репозиториями нет автоматического upstream,
submodule, subtree или runtime package dependency.

Первоначальный bootstrap выбранного Starter Core и любой последующий перенос
capability в любую сторону выполняются отдельной задачей ИИ-агента. Нельзя
предполагать, что commits совместимы с cherry-pick.

### 4.2. Контракт задачи переноса

Перед изменениями агент обязан:

1. Проверить source и target repository, branch, revision и dirty state.
2. Прочитать актуальные repository instructions, architecture и catalog.
3. Зафиксировать named consumer, переносимый контракт и failure model.
4. Отделить product vocabulary от нейтральной механики.
5. Выбрать source paths и описать адаптацию в target architecture.
6. Реализовать перенос только в целевом репозитории.
7. Запустить target-specific gates.
8. Зафиксировать source revision, target revision и намеренные отклонения.
9. Обновить provenance и capability status только после фактического merge.

Текущий локально проверенный снимок Starter — `stage @ a0c8e80`. Это evidence
на дату документа, а не вечный source pin; задача bootstrap обязана проверить
revision повторно.

### 4.3. Что переиспользуется из Starter

- NestJS bootstrap и bounded lifecycle;
- config и environment validation;
- HTTP limits и graceful shutdown;
- PostgreSQL, Prisma, transaction pattern, migrations и migrator;
- liveness/readiness;
- RFC 9457 Problem Details и validation boundary;
- OpenAPI generation и drift gates;
- Pino logging и trace propagation;
- Docker/Compose/OCI и backup/restore runbook foundation;
- stable local User/principal;
- opaque browser sessions, revocation, CSRF/Origin и RBAC contracts;
- `REL-03` process-local periodic maintenance runner;
- `INT-01` bounded outbound HTTP attempt runner;
- module-local hexagonal reference pattern.

Password/email flows и демонстрационные модули не переносятся, если они не
нужны Planner.

Для первого runtime slice `S02` health и shutdown переносятся как единый
нейтральный Core-контракт:

- unprefixed `GET /health/live` не вызывает внешние зависимости и возвращает
  `200 { "status": "ok" }`, пока HTTP listener процесса доступен, включая
  startup и drain;
- `GET /health/startup` возвращает `503 { "status": "starting" }` до первого
  успешного подключения PostgreSQL, после чего latch необратимо возвращает
  `200 { "status": "ok" }` также во время drain;
- `GET /health/ready` возвращает `200` только в lifecycle phase `ready` при
  доступном PostgreSQL; во время startup, drain или database outage он
  возвращает `503`, не раскрывая driver details;
- `SIGTERM` и `SIGINT` идемпотентно начинают drain до закрытия listener,
  прекращают приём новых соединений, ждут in-flight requests не более
  `6_000 ms`, затем при необходимости принудительно закрывают transport и
  завершают database/application cleanup в общем watchdog `10_000 ms`;
  чистое завершение имеет exit code `0`, превышение bound или ошибка cleanup —
  exit code `1`.

### 4.4. Что не выбирается автоматически

- BullMQ и queue Redis;
- transactional outbox;
- generic organizations/multi-tenancy;
- generic notification templates/digests;
- generic audit-event store;
- multi-provider identity federation.

## 5. Модули и зависимости

| Модуль | Ответственность | Не владеет |
| --- | --- | --- |
| `auth` | local User, external identity, OIDC ceremony, сессии и trusted principal | membership пары, Bot API updates |
| `workspace` | singleton pair space, memberships, разрешение principal → member | цели и продуктовые записи |
| `planning` | каталог, analytical series, draft, publication revision, snapshots, expectations, periods и lifecycle месяца | пользовательские факты и delivery |
| `tracking` | facts, corrections, tombstones, close-day outcomes, undo и action history | конфигурация опубликованной цели |
| `progress` | чистые формулы quotas, progress, score, coverage, pace и forecast primitives | БД, HTTP и системные часы |
| `reminders` | personal slots, occurrences, relevance, suppression и content model | Telegram HTTP transport |
| `reporting` | provisional query model, immutable report revisions, graph series и forecast | изменение фактов и планов |
| `telegram-bot` | private-chat ingress, callbacks, wizards и mapping в application commands | auth federation, goal rules и reminder schedule |

Легенда: `A → B` означает, что `B` использует публичный контракт `A`.

```text
platform → все product modules
auth → workspace → planning → tracking
progress → tracking
planning + tracking + progress → reminders
planning + tracking + progress → reporting
public application APIs модулей → telegram-bot
```

`progress` получает все входы явными DTO. `telegram-bot` — edge adapter и не
содержит копий продуктовых правил. Platform не импортирует Planner modules.

## 6. Identity, доступ и сессии

### 6.1. Telegram OIDC

Web login использует Telegram OpenID Connect Authorization Code Flow:

- authorization и callback работают через зарегистрированные Allowed URLs;
- `state` обязателен для защиты callback;
- PKCE S256 обязателен;
- backend создаёт `nonce`; возвращённый ID token обязан содержать то же
  значение;
- server-side OIDC transaction хранит `state`, `nonce`, PKCE verifier,
  redirect target и короткий TTL и потребляется атомарно один раз;
- scopes: `openid profile telegram:bot_access`;
- `phone` не запрашивается;
- code обменивается на tokens только backend;
- client secret существует только в secret storage/runtime environment;
- ID token проверяется по JWKS;
- обязательны signature, `iss`, `aud`, `exp`, `iat` и ожидаемый `nonce`;
- raw code, access token и ID token не сохраняются после создания локальной
  сессии и не попадают в логи.

Provider contract:

- issuer: `https://oauth.telegram.org`;
- discovery: `https://oauth.telegram.org/.well-known/openid-configuration`;
- JWKS берётся из discovery/provider metadata;
- `sub` является внешней OIDC identity;
- numeric `id` из `profile` claim используется для Telegram allowlist и
  связывания с Bot API actor.

Актуальная внешняя спецификация: [Log In With Telegram](https://core.telegram.org/bots/telegram-login).

Scope `telegram:bot_access` разрешает связанному боту отправлять пользователю
личные сообщения после согласия. Он не расширяет права пользователя внутри
Planner.

### 6.2. Mapping identity

Хранилище использует:

- внутренний `userId` UUID;
- предварительно созданный allowlist mapping `numeric Telegram ID → userId`;
- external identity с unique `(issuer, subject)` и проверенным provider user ID,
  создаваемую при первом успешном OIDC login;
- numeric Telegram user ID хранится как PostgreSQL `BIGINT`;
- TypeScript domain/adapter использует `bigint`, а JSON/логически внешний
  transport передаёт ID lossless decimal string;
- nullable email; фиктивный email из Telegram identity не синтезируется;
- mutable profile fields `name`, `preferred_username`, `picture` только для
  отображения.

Telegram username и email не используются для linking. Bot API `from.id`
разрешается в local User через pre-provisioned allowlist. OIDC login сначала
находит тот же allowlist row по numeric `id`, затем создаёт либо проверяет
binding `(issuer, subject)`. Несовпадение уже связанного subject, numeric ID или
userId является terminal identity collision; пользователь не создаётся и
сессия не выдаётся.

### 6.3. Закрытый allowlist

- Два пользователя provision-ятся заранее.
- Public signup и JIT provisioning отсутствуют.
- В пространстве ровно два равноправных membership.
- Приложение не использует enum `memberB/memberA`; права задаются membership FK.
- Ручное восстановление доступа — operator procedure с проверкой личности и
  append-only action history.
- Link/unlink другого identity provider в Planner отсутствует.

### 6.4. Bot access

- принимаются только private chats;
- actor берётся из проверенного `from.id`;
- group/supergroup/channel updates не открывают данные и не исполняют команды;
- blocked/deactivated bot state не меняет web-доступ, но показывается как
  предупреждение в настройках.

### 6.5. S04 local User и browser session contract

S04 создаёт только session substrate для будущего Telegram OIDC callback. В
PostgreSQL появляется стабильный local `User` с UUID и timestamps; production
runtime не принимает `userId` из HTTP и никогда не создаёт или upsert-ит User.
Pre-provisioning принадлежит A01, а первый production consumer session issuer —
A03. Email, password, account status, roles, permissions, public signup,
allowlist, external identity и workspace membership в S04 отсутствуют.

`AuthenticatedPrincipal` имеет ровно `{ userId: UserId; sessionId: string }`.
Внутренний issuer сначала перечитывает существующий User из PostgreSQL и только
затем создаёт новую независимую session; повторная выдача не отзывает ранее
созданные sessions. Каждый authenticated request перечитывает существование
User, а missing User fail closed без записи в PostgreSQL.

Browser session использует следующие exact controls:

- raw bearer token — 32 random bytes в canonical unpadded base64url (43 chars),
  public `sessionId` — отдельные 16 random bytes (22 chars), CSRF seed — ещё 32
  independent random bytes;
- Redis key содержит только HMAC-SHA256 raw token отдельным 32-byte secret; raw
  token не хранится ни в Redis key/value, ни в PostgreSQL или logs;
- CSRF token — session-bound HMAC-SHA256 от public session ID и seed с другим
  32-byte secret; оба runtime secrets canonical base64url и не могут совпадать;
- idle TTL — 7 дней, absolute TTL — 30 дней, touch выполняется не чаще одного
  раза в 5 минут и не продлевает absolute expiry; atomic touch/revoke не может
  воскресить revoked или expired session;
- cookie называется `planner-session` в development/test и
  `__Host-planner-session` в production, имеет `HttpOnly`, `SameSite=Lax`,
  `Path=/`, без `Domain`, а production также `Secure`;
- unsafe methods требуют `application/json`, не-cross-site request, ровно один
  разрешённый `Origin` либо exact origin из `Referer` и constant-time equal
  `X-CSRF-Token`; `GET`, `HEAD`, `OPTIONS` обходят Origin/CSRF checks, но не
  authentication.

Production HTTP surface S04: protected `GET /auth/me` возвращает только
`{ userId, sessionId }`, protected `GET /auth/csrf` возвращает session-bound
`{ csrfToken }`, `POST /auth/logout` атомарно отзывает current session, очищает
cookie с теми же attributes и возвращает `204`. Публичного issue endpoint нет.
Authentication default-on; только explicit `@PublicEndpoint`, включая health,
обходит global authentication guard.

Missing, malformed, expired, revoked session и session отсутствующего User
возвращают module-owned RFC 9457 `AUTHENTICATION_REQUIRED` 401. Invalid
Origin/CSRF возвращает module-owned `AUTHORIZATION_DENIED` 403, non-JSON unsafe
request — core `UNSUPPORTED_MEDIA_TYPE` 415. Ошибка PostgreSQL или auth Redis
возвращает core `DEPENDENCY_UNAVAILABLE` 503 без driver/URL/token details и без
User mutations. Эти auth definitions подключаются отдельным contribution и не
расширяют S03 core catalog.

Auth Redis — required API dependency с connect/command/health/shutdown bounds
`2_000/2_000/2_500/1_000 ms`. Listener становится доступен до dependency
startup, а irreversible startup latch и `ready` требуют первого успешного
подключения и PostgreSQL, и auth Redis. Последующая потеря Redis оставляет
`live/startup` доступными, делает `ready` и session operations fail closed;
startup failure очищает успешно поднятого sibling, а shutdown закрывает обе
dependencies внутри общего S02 watchdog. Redis instrumentation остаётся
выключенным. Queue Redis, cache/pub-sub abstraction и `KEYS` запрещены.

## 7. Концептуальная модель хранения

Названия таблиц являются целевыми концептами; окончательные Prisma names
определяются implementation plan без изменения инвариантов.

### 7.1. Identity и workspace

- `users`;
- `telegram_access_allowlist` с unique Telegram ID и unique `user_id`;
- `external_identities` с unique `(issuer, subject)`, unique provider user ID и
  FK на того же allowlisted `user_id`;
- `spaces` — одна product-owned запись;
- `memberships` с unique `(space_id, user_id)` и равными правами.

### 7.2. Catalog и analytical identity

- `goal_series` — стабильная аналитическая линия;
- `goal_definitions` — каталожная identity и archive state;
- `goal_definition_versions` — versioned mutable catalog configuration;
- stable child IDs для checkpoints, checklist items и OR variants.

Catalog archive никогда не удаляет historical versions. Published data не
читает mutable current catalog definition.

### 7.3. Month, draft и publication

- `plan_months` с unique `(space_id, year, month)`, lifecycle status,
  aggregate revision, `active_publication_id`, `facts_revision` и timestamps;
- `plan_drafts` с mandatory editable month focus и optimistic revision;
- `plan_draft_goals` с editable configuration, analytical-series reference,
  order и optional display-only `sourceProvenance`;
- `plan_publications` — append-only publication revisions с immutable month
  focus;
- `plan_goal_snapshots` — immutable calculation-relevant configuration;
- `fixed_expectations` — ожидаемые даты/checkpoints/items;
- `flexible_periods` — weekly/monthly period identity и сохранённый target.

Одна plan month может иметь несколько publication revisions, но не более одной
active publication. Cancel до начала месяца помечает revision cancelled; он не
переписывается и не удаляется.

Каждый снимок содержит все поля, влияющие на отображение и расчёты: title,
why, category, scope/owner, type, repetition, target, unit, precision,
aggregation, checkpoint aggregation, components, deadlines, order и config
schema version. Он также содержит optional display-only `sourceProvenance`:
source document/page, raw denominator/value и принятое resolution. Provenance
копируется в preview/report metadata, но не участвует в formulas или решении о
continuity analytical series.

### 7.4. Goal scope

- `personal` требует `owner_member_id`;
- `shared` требует отсутствия `owner_member_id`;
- shared goal имеет один progress/fact stream;
- `recorded_by` указывает автора действия, а не владельца результата.

Оба membership могут читать весь plan, catalog, facts и reports. Изменять
personal facts может только owner; shared facts может изменить любой участник с
обязательной общей history. Configuration draft доступна обоим на равных.

Инвариант закрепляется application validation и DB check constraint.

### 7.5. Expectations и periods

Fixed expectation имеет устойчивый ключ:

```text
(publicationId, planGoalSnapshotId, expectationDate, componentId?)
```

Flexible period имеет устойчивый ключ:

```text
(publicationId, planGoalSnapshotId, periodKind, periodStart, periodEnd)
```

Неделя — понедельник–воскресенье, но period обрезается границами месяца.
`weekly_planned_task` принадлежит календарной неделе, а не произвольному дню.

При поздней публикации expectations до `activeLocalDate` не создаются.
`not_applicable` для этих дней выводится системно из publication metadata и не
может редактироваться пользователем.

### 7.6. Facts и revisions

Не используется одна универсальная `value/status` запись для всех типов.

- boolean, time, rating, text, checklist item и `latest` quantity имеют logical
  record и append-only revisions/tombstone;
- `add` quantity создаёт отдельный contribution record для каждого вклада;
- OR occurrence хранит component identity и значения вариантов раздельно;
- flexible composite occurrence хранит component facts по local date;
- low rating является измерением, а не `not_done`;
- text содержит непустой текст и отдельный result `done/not_done`;
- checklist parent не создаёт дополнительную coverage unit.

Scalar values хранятся типизированно. JSONB допускается для versioned
discriminated goal config, immutable rendered notification content и report
payload, но не как неограниченный контейнер фактов.

`no_data` — вычисляемое отсутствие факта. `not_applicable` — system-only.
`done/not_done` сохраняются только там, где это предусмотрено продуктовым
сценарием или атомарным close-day.

### 7.7. Action history

Каждая logical command создаёт action group:

- actor и actor kind;
- target identity;
- command identity;
- before/after или ссылки на revisions;
- reason для correction/reopen;
- timestamp и aggregate revision.

История append-only и module-owned. Нет global arbitrary-JSON audit store.
Undo находит последнее разрешённое собственное действие и создаёт новую
компенсирующую revision, не удаляя историю.

## 8. Temporal contract

| Значение | Хранение |
| --- | --- |
| audit/event/lease/delivery instant | `TIMESTAMPTZ`, UTC |
| month и expectation date | `DATE` |
| period bounds | `DATE` |
| reminder/checkpoint wall time | `TIME WITHOUT TIME ZONE` |
| actual local time | `TIME WITHOUT TIME ZONE` + `expectationDate` |
| product timezone | immutable IANA identifier `Asia/Yekaterinburg` |

Ни один domain calculator не читает системное время сам. Он получает
`asOfInstant`, `asOfLocalDate` и `timeZone` через явный clock/application DTO.

Диапазон времени через полночь оценивается относительно expectation date.
Запись `00:30` может относиться к ожиданию предыдущего дня, если пользователь
выбрал его явно.

## 9. Атомарные workflow

### 9.1. `CreateDraftFromPublication`

Одна idempotent PostgreSQL transaction:

1. Проверяет actor, source publication и отсутствие другого destination month.
2. Создаёт destination `plan_month` и `plan_draft`.
3. Копирует focus как editable draft value.
4. Копирует goal snapshot configuration, analytical-series references, order и
   `sourceProvenance` в editable draft goals.
5. Копирует weekly planned task text и week ordinal.
6. Не копирует facts, record revisions, statuses, notes/results, coverage,
   progress, notification occurrences или reports.
7. Сохраняет action history и command receipt.

Source publication и исходный month остаются immutable. Unique
`(spaceId, year, month)` не позволяет создать второй destination month.

### 9.2. `PublishMonth`

Owner команды — application layer модуля `planning`. Одна PostgreSQL transaction
выполняет:

1. Idempotency lookup.
2. Проверку actor, lifecycle и draft expected revision.
3. Полную product validation.
4. Проверку обязательного непустого month focus.
5. Создание append-only publication revision с immutable focus.
6. Создание immutable plan goal snapshots вместе с `sourceProvenance`.
7. Детерминированную генерацию fixed expectations и flexible periods.
8. Сохранение prorated period targets и formula version.
9. Расчёт publication snapshot hash, включающего focus и goal snapshots.
10. Установку `active_publication_id` и нового month revision.
11. Action history и completed command receipt.

Ни один участвующий модуль не коммитится отдельно. Published month без полного
набора expectations/periods невозможен.

### 9.3. Cancel и republish

Cancel разрешён только до начала месяца и при отсутствии facts. Transaction:

- проверяет active publication и revision;
- помечает publication cancelled;
- очищает active pointer;
- возвращает plan month в draft;
- не меняет и не удаляет snapshot rows.

Republish создаёт следующую publication revision и новый набор expectations.
Records всегда ссылаются на конкретную publication revision.

### 9.4. `CloseDay`

Команда сначала возвращает preview unresolved fixed expectations. Подтверждение
передаёт preview revision/token. Transaction повторно проверяет набор и одним
action group переводит оставшиеся фиксированные units в `not_done`.

Flexible weekly/monthly goals и weekly planned tasks не получают daily
`not_done`. Повтор команды возвращает сохранённый результат.

### 9.5. `CloseWeek`

Владелец weekly planned task может выставить ей `done/not_done` в течение
недели через web или Telegram. В `00:00` следующего понедельника либо на
границе месяца worker исполняет idempotent `CloseWeek`:

1. Определяет period, обрезанный границами active month.
2. Находит незаполненные weekly planned tasks этого period.
3. Одним action group сохраняет для них `not_done` от system actor.
4. Не создаёт daily failures для flexible quotas.
5. Увеличивает `factsRevision` один раз и сохраняет receipt.

Повторный запуск не меняет уже выставленный пользователем результат.

### 9.6. `CloseMonth` и `RecloseMonth`

Owner lifecycle — `planning`; `reporting` предоставляет детерминированный
calculator и transaction-scoped repository participant. Одна transaction:

1. Выполняет receipt lookup и CAS/lock plan month.
2. Проверяет отсутствие конкурентной correction.
3. Читает exact `factsRevision` и active publication.
4. Строит report payload по snapshot + facts + formula version.
5. Добавляет immutable report revision.
6. Переводит month в `closed`.
7. Добавляет action history и receipt.

Report revision содержит:

- `publicationId`;
- `publicationSnapshotHash`;
- `sourceFactsRevision`;
- `formulaVersion`;
- `payloadChecksum`;
- status `original` либо `revised`.

Reopen не удаляет report revisions, не разблокирует configuration и не
возобновляет notifications. Каждая последующая correction увеличивает
`factsRevision`; reclose создаёт следующую report revision.

### 9.7. Scheduled lifecycle enforcement

Publication хранит `activeLocalDate`. Для будущего месяца это первое число, для
late publication — local date публикации. До этой даты API запрещает facts и
reminders независимо от того, успел ли worker материализовать переход.

Effective lifecycle вычисляется из persisted state и календарных границ:

- с первого дня следующего месяца для обычного lifecycle применяются правила
  `grace`;
- с `00:00` четвёртого дня обычного grace corrections блокируются до
  выполнения system `CloseMonth`;
- worker находит due lifecycle transitions и исполняет idempotent system
  commands;
- задержка или перезапуск worker не расширяют окно редактирования;
- manual reopen после закрытия требует actor, reason и отдельной revision;
- reopen устанавливает lifecycle mode `reopened`, отменяет обычный calendar
  auto-close deadline и снова разрешает только corrections;
- reopened grace закрывается только явной member-командой `RecloseMonth`; worker
  не исполняет для него обычный scheduled `CloseMonth`.

Таким образом, correctness не зависит от запуска process-local timer ровно в
полночь, а persisted transition и report создаются recoverable worker-командой.

## 10. Application commands, idempotency и concurrency

### 10.1. Envelope

```ts
type ApplicationCommand<TPayload> = {
  commandId: string;
  trustedActor: {
    kind: "member" | "system";
    id: string;
  };
  expectedRevision?: bigint;
  payload: TPayload;
};
```

Web и Telegram adapters создают одинаковые product commands. `trustedActor`
никогда не принимается из untrusted payload: web получает его из сессии,
Telegram — из verified private-chat `from.id`, worker использует отдельного
system actor.

### 10.2. Durable receipt

Unique scope:

```text
(actorScope, commandType, commandId)
```

Receipt хранит canonical request fingerprint, result reference, aggregate
revision и completion time. Effect, action history и completed receipt
коммитятся одной transaction.

Порядок выполнения обязателен:

1. Найти receipt.
2. При same key/different fingerprint вернуть conflict.
3. При same key/same fingerprint вернуть прежний result.
4. Только для нового command проверить expected revision и permissions.
5. Выполнить effect и атомарно записать receipt.

Crash до commit не оставляет ни effect, ни receipt. Retry выполняет команду
заново. Receipts пилота хранятся не меньше связанных facts.

### 10.3. Command IDs

- web генерирует UUID на одно намерение пользователя и переиспользует его при
  retry;
- при render Telegram action/preview backend создаёт semantic `actionIntentId`,
  связанный с actor, command type, payload fingerprint, expected revision и
  expiry;
- versioned callback payload содержит opaque `actionIntentId`; повторные
  нажатия одной Confirm-кнопки используют один и тот же application
  `commandId`, даже если Telegram прислал разные callback query IDs;
- Telegram `update_id`/callback query ID используются только для ingress
  dedupe и диагностики, но не определяют identity product intent;
- callback payload не содержит доверенные actor/permissions;
- notification external send не покрывается product command receipt и имеет
  собственный attempt ledger.

### 10.4. Optimistic concurrency

CAS применяется к минимальному изменяемому aggregate:

- draft revision для редактирования плана;
- plan month revision для lifecycle;
- record revision для исправления;
- schedule revision для настройки уведомлений;
- wizard revision для Telegram-мастера.

Независимые `add` contributions не конфликтуют только из-за одновременности;
каждый вклад является отдельным command/effect.

## 11. Progress policy

`progress` — чистый policy module. Он принимает immutable goal snapshot,
expectations/periods, facts, calendar и явный `asOf`.

Обязательные свойства:

- decimal arithmetic без binary floating-point для продуктовых значений;
- единый `round_half_up`;
- week Monday–Sunday с обрезкой month bounds;
- `not_applicable` исключается из numerator и denominator;
- `no_data` участвует только там, где PRD задаёт ожидаемую coverage unit;
- flexible debt не переносится в следующий period;
- OR variants используют maximum normalized fraction, а не сумму;
- raw overperformance хранится, score cap применяется только при агрегации;
- rating score основан на заполнении checkpoints, не на величине настроения;
- formula behavior имеет version identifier.

Точные формулы, score и coverage определены в PRD §12 и являются
acceptance-contract. Изменение формулы создаёт новую `formulaVersion`; старые
закрытые report revisions не переписываются.

## 12. Reporting

### 12.1. Active и grace

Объём данных пары ограничен, поэтому provisional report вычисляется bounded DB
query по active publication и facts. Warehouse, OLAP pipeline и event ledger не
нужны.

### 12.2. Closed

Closed report читается из immutable report revision. Payload содержит три
раздельных раздела: каждый personal owner и shared. Shared score не попадает в
personal sections.

Pilot payload обязательно содержит:

- общий `monthScore` каждого раздела;
- по каждой цели `goalScore`, uncapped `progressPercent`, `fact / target` и
  отдельное overperformance;
- coverage;
- heatmap states;
- cumulative quantity;
- actual time;
- rating trends.

Completed v1 дополнительно отдаёт:

- streak/current-best series;
- day-of-week/category distributions;
- actual/required pace;
- forecast для targeted quantity и flexible goals;
- closed-month comparison по analytical series;
- correlation observations.

Forecast появляется после трёх active days и использует простую экстраполяцию
темпа без ML. Correlation observations допускаются только при минимум 90 paired
observations и всегда содержат sample size и hypothesis wording.

## 13. Reminder scheduling и delivery

### 13.1. Source of truth

PostgreSQL хранит:

- personal reminder schedules с morning/day/evening slots;
- schedule revision;
- due occurrences;
- immutable notification intents;
- delivery attempts и safe outcome.

`REL-03` будит process-local непересекающийся цикл. Default interval пилота —
30 секунд; configuration принимает только диапазон 15–60 секунд. При здоровом
worker ожидаемая задержка обнаружения due row не превышает configured interval
плюс время bounded query. Task выполняет indexed DB query по
`nextDueAt`/`dueAt`. Это намеренный DB polling, а не Telegram long polling и не
durable scheduler внутри `REL-03`.

### 13.2. Occurrence identity

Unique key:

```text
(recipientMemberId, localDate, slotKind)
```

Schedule revision не входит в unique key. Перенос будущего unsent slot меняет
due time существующего occurrence. Если новое время сегодня уже прошло,
изменение действует со следующего дня. Disable переводит pending occurrence в
terminal cancelled/suppressed state.

`expiresAt` равен началу следующего включённого slot в тот же local day; если
следующего slot нет — `00:00` следующего local day. Формально это более ранняя
из доступных границ `nextEnabledSlotInstant` и `nextLocalDayStart`. После
`expiresAt` attempt не начинается. Morning focus сам по себе не создаёт
message.

### 13.3. Claim и relevance

Worker:

1. Выбирает due rows через indexed query.
2. Claim-ит ограниченный batch с lease и fencing token.
3. Загружает authoritative publication, facts и progress.
4. Повторно проверяет relevance максимально близко к первой external attempt.
5. При пустом content помечает occurrence `suppressed`.
6. Иначе атомарно создаёт immutable rendered intent и attempt со state
   `prepared`.
7. Непосредственно перед HTTP side effect атомарно переводит attempt в
   `dispatching`, сохраняя fencing token и `startedAt`.
8. Выполняет один bounded provider attempt.
9. Сохраняет outcome и, если допустимо, `nextAttemptAt` не позже `expiresAt`.

Recovery различает crash window:

- orphaned `prepared` означает, что dispatch ещё не начинался; его можно
  безопасно reclaim-ить;
- orphaned `dispatching` без terminal outcome считается `ambiguous` и никогда
  не отправляется повторно;
- новый retry attempt создаётся только после явно сохранённого retryable
  provider outcome и только до `expiresAt`;
- fencing не позволяет старому worker записать outcome после reclaim.

Завершённая personal/shared норма подавляется. Shared completion подавляет её у
обоих участников. После последнего reread остаётся неизбежное окно до внешнего
side effect; система не обещает current-at-receipt или exactly-once. Crash
между `dispatching` и фактической передачей запроса может дать безопасный
пропуск, выбранный вместо риска дубля.

### 13.4. Telegram outcome model

| Outcome | Поведение |
| --- | --- |
| provider accepted | terminal `provider_accepted`; не называть delivered/read |
| `429 retry_after` | retryable только в пределах `expiresAt` |
| definite failure до передачи запроса либо явный provider `5xx` response | bounded retry в пределах `expiresAt` |
| blocked/deactivated/chat not found | terminal, warning в web |
| timeout/reset после возможной передачи запроса | terminal `ambiguous`, без blind retry |
| expired/superseded | terminal, не отправлять |

Telegram Bot API не предоставляет idempotency key для `sendMessage`, поэтому
exactly-once недостижим. Для низкокритичных reminders потенциальный дубль после
ambiguous outcome хуже пропуска.

### 13.5. Почему не BullMQ delayed jobs

- wall-clock schedule редактируется в PostgreSQL;
- delayed jobs создают DB→Redis gap и reconciliation;
- изменение времени требует remove/replace job;
- downtime создаёт backlog, который всё равно надо фильтровать по expiry;
- relevance всё равно требует перечитать authoritative product state.

BullMQ можно добавить после intent creation при доказанной нагрузке, но он не
становится source of truth расписания.

## 14. Telegram interface

### 14.1. Ingress

Один application handler обрабатывает нормализованный Telegram update.
Transport может получать updates через webhook либо `getUpdates`; production
выбор отложен до deployment gate. Одновременно активен только один ingress
mode.

Нормализация проверяет:

- private chat type;
- allowlisted `from.id`;
- update/callback dedupe;
- callback schema version;
- wizard revision;
- aggregate expected revision.

### 14.2. Pilot и v1

Pilot bot предоставляет Today, ввод/исправление, close day, progress и
notifications. Для одного ожидаемого ввода пилот может хранить bounded
per-action state до подтверждения, но не реализует универсальный мастер
редактирования плана.

Только completed v1 добавляет полный catalog/draft editor. Его wizard state
хранится в PostgreSQL, имеет TTL 24 часа, Back/Cancel/Resume, preview и explicit
confirmation. До подтверждения product data не меняется.

### 14.3. Outbound transport boundary

`telegram-outbound-transport` выполняет ровно один bounded HTTP attempt поверх
Starter `INT-01`. Он знает Bot API endpoint, timeout/body bounds и provider
error mapping. Он не знает schedule, goal state, content policy, persistence
или retries.

## 15. HTTP API и контракты

- REST API документируется OpenAPI.
- Ошибки используют RFC 9457 Problem Details.
- Web и Telegram вызывают одинаковые application commands и validators.
- Read models могут быть channel-specific, но не переопределяют доменные
  значения.
- Version conflict возвращает typed conflict с актуальной revision и безопасным
  next action.
- Same idempotency key/different fingerprint возвращает отдельный conflict.
- Authorization проверяется server-side для каждого command/query.

Contracts не «железные навсегда»:

- до независимо развёртываемого consumer допустимы контролируемые breaking
  changes вместе с regeneration;
- после появления такого consumer требуются compatibility policy и versioning;
- DB меняется migrations, Telegram callback и wizard payloads — versioned
  schemas;
- опубликованные product snapshots остаются immutable независимо от API
  evolution.

### 15.1. S03 platform contract

S03 вводит нейтральную HTTP-boundary до появления product modules. Каждый
response получает выбранный `X-Request-ID`: принимается ровно один canonical
UUID либо uppercase ULID; отсутствующий, malformed, lowercase, overlong или
multi-value header заменяется `randomUUID()`. Этот же ID входит в
`urn:request:<requestId>`, access/application logs и trace-safe attributes.

Ошибки отдаются только как `application/problem+json` RFC 9457 с полями
`type`, `title`, `status`, `detail`, `instance`, `code`, `requestId`; validation
добавляет `errors: [{ pointer, code, detail }]`. Namespace типов строго
`https://planner.invalid/problems/<slug>`. Core registry содержит только
`MALFORMED_REQUEST` 400, `NOT_FOUND` 404, `CONFLICT` 409,
`PAYLOAD_TOO_LARGE` 413, `UNSUPPORTED_MEDIA_TYPE` 415,
`VALIDATION_FAILED` 422, `RATE_LIMIT_EXCEEDED` 429, `INTERNAL_ERROR` 500 и
`DEPENDENCY_UNAVAILABLE` 503. Duplicate или unregistered definitions
останавливают startup; unknown exceptions схлопываются в constant safe
`INTERNAL_ERROR` без message, cause или stack.

Global validation использует `transform: true`, disabled implicit conversion,
`whitelist: true`, `forbidNonWhitelisted: true` и `forbidUnknownValues: true`.
Field errors используют отсортированные и deduplicated RFC 6901 pointers и
никогда не содержат rejected values. JSON и URL-encoded body ограничены
`1_048_576` bytes; request/headers/keep-alive timeouts равны соответственно
`30_000`, `10_000` и `5_000 ms`. Эти limits не меняют S02 drain `6_000 ms` и
hard shutdown watchdog `10_000 ms`.

Access records могут содержать только route template, uppercase method, status,
duration и correlation. Structured attributes primitive-only и event-allowlisted;
request body/query/raw URL/cookie/authorization, OIDC payload/token/code, raw
Telegram ID/username/phone, email, free text и database/Redis URLs отбрасываются.
Error serialization содержит type и не более восьми sanitized frames, без
message/cause. Trace exporter allowlist-only, удаляет events/links, не включает
Redis instrumentation или Redis-specific `db.statement`; logger/exporter/
collector failure теряет только telemetry и не меняет safe HTTP response.

OpenAPI существует как deterministic offline artifact
`docs/api/openapi.json` c Planner metadata. Только explicit
`openapi:generate` пишет artifact; `openapi:drift` non-writing byte-compares;
`openapi:lint` validates artifact. Runtime его не regenerates; public
development docs возможны только при explicit enable, а production default off.

`ProductClock` — Planner adaptation, а не Starter transfer:
`{ now(): Date; today(timeZone: "Asia/Yekaterinburg"): string }`. Только outer
system adapter читает `new Date()`; fake clock проверяет UTC-to-
Asia/Yekaterinburg date boundary, а `progress` и product/domain logic остаются
pure.

## 16. Failure model

| Failure | Обязательное поведение |
| --- | --- |
| OIDC provider unavailable | fail closed; существующие sessions продолжают жить по собственной policy |
| invalid state/nonce/token | session не создаётся; безопасная ошибка без token data |
| unknown Telegram identity | no JIT; доступ запрещён |
| PostgreSQL unavailable | API/worker not ready; никаких partial effects |
| auth Redis unavailable | новые/проверяемые sessions fail closed; product DB не повреждается |
| duplicate web command / Telegram callback | receipt replay возвращает прежний result |
| same key/different payload | typed conflict, effect отсутствует |
| stale revision | typed conflict и актуальное состояние |
| crash внутри transaction | rollback effect/history/receipt вместе |
| worker crash после claim | orphaned `prepared` reclaim; orphaned `dispatching` становится terminal ambiguous; fencing блокирует stale outcome |
| completion во время reminder send | последний authoritative reread; exactly-once/current-at-receipt не обещается |
| Telegram 429 | bounded retry до expiry |
| ambiguous Telegram acceptance | terminal ambiguous, без retry |
| concurrent correction и close | month CAS/lock; одна операция получает conflict |
| calendar auto-close после reopen | scheduled command игнорирует `reopened`; закрывает только explicit `RecloseMonth` |
| reopen/reclose | старая report revision сохраняется, новая добавляется |

## 17. Security, privacy и retention

- Все provider credentials и bot token находятся в secret storage/environment.
- Raw OIDC и Telegram provider payload не сохраняются без отдельной
  диагностической необходимости; в пилоте такая необходимость отсутствует.
- Логи не содержат tokens, Telegram IDs в открытом виде, username, phone,
  полный текст личных записей или rendered private notification content.
- Diagnostics используют safe error code, hashed/correlated identifiers и
  bounded provider response metadata.
- HTTP имеет body/time bounds и корректный proxy trust contract.
- Web session использует существующие Starter controls: opaque ID, revocation,
  secure cookie, CSRF/Origin policy и bounded lifetime.
- Plans, facts, action history, receipts и report revisions private pilot
  хранит бессрочно. Отдельная erasure/retention policy должна быть принята до
  публичного или многопользовательского продукта.
- Query истории и отчётов всегда проверяет membership/ownership.

## 18. Observability

### 18.1. Logs и traces

- correlation ID проходит API, application command и provider attempt;
- command logs содержат command type, safe actor ref, aggregate ref и outcome;
- notification logs содержат occurrence/intent/attempt ID и safe outcome;
- formula/report logs содержат formula version и source revisions;
- sensitive values не логируются.

### 18.2. Метрики

Минимальный набор:

- API latency/error rate;
- OIDC success/failure by safe reason;
- command replay/conflict count;
- due occurrences, claim latency и expired count;
- notification suppressed/accepted/retryable/ambiguous/terminal counts;
- worker last successful cycle и lease recovery count;
- report build latency/failure;
- DB/Redis readiness.

Metrics не содержат member names или raw Telegram IDs.

## 19. Testing strategy

### 19.1. Unit

- все PRD formulas и `round_half_up`;
- late publication и partial weeks;
- cross-midnight time ranges;
- all goal type evaluators;
- score/coverage/overperformance;
- relevance/suppression;
- forecast и correlation gate;
- canonical command fingerprint.

Используется fake clock; tests не зависят от реального `now()`.

### 19.2. PostgreSQL integration

- DB constraints identity/scope/publication;
- `CreateDraftFromPublication` copies config/provenance but no facts;
- `PublishMonth` atomicity;
- cancel/republish append-only behavior;
- command receipt + effect transaction;
- concurrent web/Telegram CAS;
- add contributions и latest revisions;
- close-day preview race;
- `CloseWeek` preserves a user result and closes unresolved weekly planned tasks;
- CloseMonth/correction race;
- reopen/reclose report revisions;
- occurrence unique key, leases и recovery;
- orphaned `prepared` reclaim и orphaned `dispatching → ambiguous` recovery.

### 19.3. Contract

- OpenAPI validation/drift;
- Problem Details shapes;
- OIDC callback через fake issuer/JWKS: success mapping и fail-closed invalid
  state, nonce, PKCE, signature/claims, consumed transaction и ID outside
  allowlist;
- Telegram update normalization и versioned callbacks;
- bounded outbound transport с fake Telegram provider outcomes.

### 19.4. E2E

- allowlisted OIDC `(issuer, subject) + numeric ID` → pre-provisioned user →
  local session; negative OIDC cases не создают user/session;
- create/copy/publish month;
- all record types through web and Telegram command adapters;
- duplicate callback не удваивает `add`;
- completed norm disappears from reminders;
- grace/reopen/reclose;
- reproducible report fixture;
- April seed publishability вместе с обязательным prefilled focus.

### 19.5. Acceptance traceability

| Acceptance | Главная проверка |
| --- | --- |
| `AC-01`, `AC-01b` | OIDC contract + allowlist integration + E2E session |
| `AC-02`, `AC-23` | copy-month transaction integration + E2E no-facts copy |
| `AC-03` | draft validation unit/integration + publish rejection E2E |
| `AC-04…AC-08`, `AC-13…AC-21` | formula/type unit fixtures + typed persistence integration |
| `AC-09` | atomic CloseDay integration + web/Telegram replay E2E |
| `AC-10` | reminder relevance/suppression integration + transport contract |
| `AC-11` | grace/reopen/reclose integration + report revision E2E |
| `AC-12` | completed-v1 wizard CAS/idempotency E2E |
| `AC-22`, `AC-SM-01` | April seed fixture + automated assertions/manual provenance review |
| `AC-24` | week-boundary fake-clock + idempotent CloseWeek integration |
| `AC-15` | completed-v1 correlation sample-size unit/contract test |

Live Telegram, DNS, TLS и hosted restart не выдаются за проверенные до
deployment gate.

## 20. Deployment gate

Конкретный provider, VPS и reverse proxy отложены. Это допустимо для design и
локальной реализации, но до пилотного месяца обязательна отдельная deployment
задача, которая доказывает:

- production composition `api + planner-worker + migrator`;
- PostgreSQL persistent volume и runtime/migrator credentials;
- отдельный persistent auth Redis;
- HTTPS, proxy trust и secret handling;
- production origin и callback URI зарегистрированы в BotFather Allowed URLs;
- production OIDC Client ID/Secret и JWKS verification проверены hosted smoke;
- выбранный Telegram ingress mode и его security contract: для webhook —
  authenticity secret, dedupe и recovery; для `getUpdates` — один active
  consumer, durable offset и recovery;
- single- и multi-replica worker lease behavior;
- worker readiness, restart и graceful shutdown;
- backup и restore drill;
- hosted web login smoke;
- hosted Telegram command и reminder smoke;
- наблюдаемость без PII leakage.

Starter production Compose не содержит готового product worker; Planner владеет
его executable, readiness, rollout и recovery contract.

### 20.1. Data protection objectives

- PostgreSQL RPO: не более 1 часа.
- Полный service RTO после объявления инцидента: не более 4 часов.
- Deployment обязан делать encrypted off-host backup либо continuous/PITR
  эквивалент, удовлетворяющий RPO.
- Минимальная retention: hourly recovery points 48 часов, daily 35 дней,
  monthly 12 месяцев.
- Auth Redis не является источником истины и может быть восстановлен пустым;
  пользователи выполнят повторный OIDC login.
- До пилота restore drill разворачивает отдельную PostgreSQL instance,
  применяет нужные migrations и проверяет identities, active publication,
  facts revisions, pending reminders и воспроизводимость sample report.
- Restore drill повторяется после изменения backup mechanism и не реже одного
  раза в три месяца.

## 21. Starter capability markers

После утверждения этого документа capability catalog Starter получает
необязательное поле отдельной задачей:

```md
- **Expected from Planner:** ...
```

Marker означает источник будущей реализации/adoption evidence. Он не означает
`Available`, roadmap commitment или автоматический перенос.

| Capability | Состояние после catalog update | Что ожидается из Planner |
| --- | --- | --- |
| `ID-10` Telegram OIDC | `Validated candidate` | provider-specific Reference и security/runtime evidence |
| `REL-03` periodic runner | остаётся `Available` | adoption evidence due-state polling; новой реализации не ожидается |
| `REL-05` command idempotency | `Validated candidate` | product-owned receipts и web/Telegram concurrency proof |
| `COM-02` notification delivery | остаётся `Validated candidate` | первый durable reminder vertical и neutral-boundary evidence |
| `COM-09` Telegram outbound | новая `Validated candidate` | bounded `sendMessage` Reference и outcome map |
| `GOV-02` action history | остаётся `Validated candidate` | module-owned finite history pattern |
| `INT-03` webhook ingress | остаётся `Deferred` | после выбора webhook отдельная catalog task может предложить `Validated candidate` |

Ни один candidate не попадает в список текущего содержимого Starter до
отдельного PR, tests, adoption/removal docs и merge в `stage`.

Planner-only и не переносится:

- pair space и allowlist;
- goal catalog/types/series и month lifecycle;
- progress/score/coverage formulas;
- personal/shared policy;
- three reminder slots и `Asia/Yekaterinburg` policy;
- relevance, suppression, wording и keyboards;
- Telegram wizards и product command mapping;
- report definitions и April seed.

Catalog и roadmap Starter на дату документа ошибочно называют `INT-01`
feature-branch-only, хотя код уже находится в `stage @ a0c8e80`. Это отдельный
documentation drift и не считается capability, созданной Planner.

## 22. Стартовый April seed

Seed полностью заполнен и публикуем. Решения являются данными, а не
hardcoded domain constants:

- month focus — «Показатель 108»;
- meditation — Boolean flexible monthly goal с `N=16`;
- обе бумажные нормы `2–3` получают exact `N=2`;
- перечисленные каналы Reels и article/post используют `all`;
- collaborations — targeted monthly quantity, unit `коллаборации`, aggregation
  `add`, target `7`;
- «важная задача дня» — `shared`;
- five weekly outreach tasks принадлежат Участник Б;
- бумажные summary denominators сохраняются как provenance;
- authoritative target рассчитывается calendar formulas для выбранного месяца;
- 30–31 марта не создают April expectations.

Generic validation сохраняется: будущий пользовательский draft с range,
невыбранным owner, невалидной unit или отсутствующим required field не может
быть опубликован.

## 23. Последовательность технических зависимостей

```text
Starter Core transfer
  → identity/workspace
  → planning/publication
  → tracking/progress
  → reminders/Telegram pilot
  → close/reporting
  → completed v1
```

Это не epic structure и не task list. Каждый transfer Starter ↔ Planner остаётся
отдельной задачей. Конкретная декомпозиция и размер задач определены в
[IMPLEMENTATION_PLAN.md](./IMPLEMENTATION_PLAN.md).

## 24. Отложенные решения

Следующие решения намеренно не блокируют backend design, но имеют явный gate:

- hosting/provider/VPS;
- reverse proxy и release mechanism;
- production Telegram webhook либо `getUpdates`;
- начальное количество replicas;
- публичная privacy/erasure policy;
- извлечение любого `Expected from Planner` candidate обратно в Starter;
- frontend technical design;
- будущая AI free-text phase.

## 25. Self-review checklist

Перед фиксацией implementation plan документ должен удовлетворять:

- нет `TBD`, `TODO` и неявных placeholder decisions;
- PRD, User Flows и Screen Map описывают тот же OIDC flow;
- April seed не содержит уже разрешённых blockers;
- publication и close имеют одну transaction boundary;
- report revision ссылается на точные publication/facts/formula revisions;
- actor выводится только из trusted channel context;
- command replay проверяется до CAS;
- time types и timezone явны;
- notification model не обещает exactly-once;
- deployment provider может быть отложен, но pre-pilot gate обязателен;
- Starter candidates не названы реализованными.
