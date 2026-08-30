# Planner Backend: Frontend API Addendum

**Версия:** 1.0
**Дата:** 24 августа 2026 года
**Статус:** `F01…F09` опубликованы; cross-repository contract handoff `F10`
проверен и опубликован, remote CI/browser/hosted acceptance остаются отдельными
evidence
**Backend contract baseline:** `origin/main@ef76210ad66d442704417addfcf54e7f68cab65d`
**Frontend consumer baseline:** remote-reachable
`DenisChernykh/planner-frontend@5e300725b207398da088511eb59f4fd36168d29a`

## 1. Назначение и граница

Addendum закрывает разрыв между реализованным backend pilot и отдельным web
frontend. Он определяет недостающие публичные HTTP/read-model capabilities,
security/recovery semantics и acceptance gate. Бизнес-правила по-прежнему
принадлежат `PRD.md` и `TECHNICAL_DESIGN.md`; frontend не получает право
пересчитывать lifecycle, access, progress, report или publication policy.

Этот baseline сам по себе:

- не добавляет endpoints, migrations или OpenAPI operations;
- не означает, что frontend implementation или hosted deployment готовы;
- не меняет Telegram pilot flow `UF-06` в backend-документах;
- не выбирает frontend framework, component library, hosting или visual style.

Требования ниже возникают из frontend jobs `W-01…W-15`. Реализация считается
доступной consumer только после merge соответствующей task в backend `main`,
обновления committed `docs/api/openapi.json` и отдельной синхронизации
закреплённого контракта во frontend repository.

## 2. Общие контрактные инварианты

### 2.1. Identity и authorization

- Actor любой command выводится только из trusted web session. Payload не
  принимает `actorId`, `userId`, `spaceId` или acting `memberId`.
- `ownerMemberId` personal goal допустим только как target configuration,
  выбранный из backend-provided member mapping `GAP-01`; он не определяет actor.
- Missing и foreign-space resources неразличимы там, где это уже требует
  concealed-resource policy.
- Технические UUID не являются display labels и никогда не кодируют persona,
  роль или права.

### 2.2. Browser transport

- Все protected operations используют opaque HttpOnly session cookie;
  публичные Telegram OIDC start/callback сохраняют существующее explicit
  `@PublicEndpoint` исключение.
- Unsafe operations требуют exact JSON, допустимый `Origin`/`Referer` и
  session-bound `X-CSRF-Token` по существующему S03/S04 contract.
- GET/read models не требуют CSRF и никогда не меняют product state.
- Обычный browser path предполагает same-origin reverse/dev proxy; addendum не
  вводит CORS как обязательный runtime contract.

### 2.3. Идемпотентность, concurrency и числа

- Каждый mutation intent принимает canonical `commandId`; неизвестный network
  outcome повторяется только с тем же command ID и тем же fingerprint.
- Stale revision не перезаписывается: response возвращает current revision и
  finite `nextAction`, после чего frontend выполняет refetch и повторное
  осознанное подтверждение.
- Все `bigint`, revisions, counters и exact decimal quantities сериализуются
  строками и не требуют преобразования в JavaScript `number`.
- Success показывается только после подтверждённого server response; backend не
  зависит от optimistic client state.

### 2.4. Errors, consistency и delivery

- Ошибки используют существующий RFC 9457 `application/problem+json` contract:
  stable `code`, `requestId`, optional field `errors`, `conflict`, `blockers` и
  finite recovery action.
- Read model одной operation относится к одному consistent PostgreSQL snapshot;
  browser не склеивает lifecycle, facts и report из несовместимых revisions.
- Realtime между web и Telegram не обещается. Новое состояние становится
  видимым после refetch/reopen/focus return.
- Offline mutations и server-side offline queue не входят в scope. Локально
  введённое значение не считается подтверждённым и не отправляется позднее без
  нового пользовательского действия.

## 3. Locked frontend-readiness gaps

### GAP-01 — Workspace/member presentation context

**Implemented state (F01):** `GET /auth/me` по-прежнему возвращает только
`userId` и `sessionId`; browser read model — `GET /workspace/current`.

**Committed surface:** authenticated `GET /workspace/current`.

The committed response schema is `workspace.current.v1` and contains exactly
`spaceId`, `timeZone = "Asia/Yekaterinburg"`, `currentMemberId`,
`personaMappingState` (`unbound|bound`) and two members ordered current first.
Each member contains `memberId`, explicit `relation` (`current|partner`),
finite backend-owned `displayName` and nullable `persona` (`memberA|memberB`).
Before the immutable April seed binding the labels are `Вы` and `Партнёр` and
both personas are `null`; after binding the labels are `Участник А` and `Участник Б` and
the mapping is stable for both viewers. The mapping is read-only from the
immutable `planning_seed_consumptions` row; F01 adds no presentation profile
table or migration.

Response должен в одном bounded read возвращать:

- `spaceId` и exact `timeZone = "Asia/Yekaterinburg"`;
- current `memberId`;
- ровно двух same-space members с `memberId`, безопасным `displayName` и
  backend-owned persona mapping;
- явный current/partner relation без вывода из массива, slot или UUID;
- `persona = null` только до разрешённого seed binding, с конечным capability
  marker для UI; после binding mapping стабилен.

Display name/persona не берутся из Telegram username и не раскрывают raw
Telegram ID. Если presentation profile потребует новую persistence, она
остаётся workspace-owned и не меняет равные права участников.

**Recovery:** `401` → новый login; missing membership → concealed finite
`403 WORKSPACE_AUTHORIZATION_DENIED`; inconsistent pair or partial mapping →
`409 WORKSPACE_STATE_CONFLICT`; database failure → `503 DEPENDENCY_UNAVAILABLE`.
No partial member list is returned.

**Acceptance:** `W-02/W-10/W-13/W-14` показывают «я / партнёр / shared», owner
selection и report labels без hardcoded UUID/persona.

### GAP-02 — Plan/month discovery

**Implemented state (F02):** authenticated `GET /planning/months` возвращает
один consistent `planning.month-index.v1` snapshot с bounded newest-first
keyset pagination.

**Committed surface:** authenticated `GET /planning/months?limit=20&cursor=...`.

`limit` — integer `1..50`, default `20`; cursor — opaque versioned keyset
token `v1.<base64url>`, internally bound to the last `{targetMonth,
planMonthId}` and never interpreted by the browser. The server reads `limit+1`
rows ordered by `month_start DESC, plan_month_id DESC` and returns `nextCursor`
only when another row exists. Invalid limit/cursor returns the existing `422`
Problem Details contract.

Response schema is exact `planning.month-index.v1`: `queryLocalDate` is the
single server-derived `Asia/Yekaterinburg` local date; each item has
`targetMonth`, server-derived `phase` (`draft|future|active|grace|closed`),
`lifecycle` (`planMonthId`, `status`, `mode`, string `revision`), mandatory
`draft.revision` string, nullable latest exact `publication` (`publicationId`,
string `revision`, `activeLocalDate`, `isActive`), nullable latest `report`
(`reportRevisionId`, string `revision`, `status: original|revised`) and exact
boolean `allowedActions` (`openDraft`, `openPublication`, `copySource`,
`cancel`, `reopen`, `reclose`). `items` is bounded and `nextCursor` is
nullable.

The latest immutable publication is selected by publication revision rather
than the active pointer, so a historical or cancelled publication remains an
exact `copySource`. `isActive` is derived from the same-space active pointer.
No UUID, revision, date, bigint, or lifecycle policy is inferred by the
browser.

Каждая запись обязана содержать canonical month, lifecycle status/mode,
plan-month/draft/publication/report references и их string revisions, а также
server-owned allowed actions: `openDraft`, `openPublication`, `copySource`,
`cancel`, `reopen`, `reclose`. Сортировка deterministic, newest-first; отсутствие
месяцев — успешный empty result. Browser не перебирает предполагаемые даты.

Copy source относится к exact immutable publication revision, включая
historical/cancelled revision только если это разрешает существующая P09 policy.

**Recovery:** stale list refetch; foreign space не раскрывается; превышение
bounded page size отклоняется без truncation неизвестного набора.

**Acceptance:** `W-05/W-07/W-08/W-13` открывают current, next и history из
одного authoritative index и не угадывают lifecycle client-side.

### GAP-03 — Create empty draft HTTP command

**Implemented state (F03):** authenticated + CSRF `POST /planning/drafts/empty`
реализован и закоммичен поверх существующего `planning.create-empty-draft.v1`.

**Committed surface:** authenticated + CSRF `POST /planning/drafts/empty` поверх
существующего `planning.create-empty-draft.v1`.

Body содержит ровно `commandId`, `targetMonth`, `focus`; actor/space отсутствуют.
Success/replay возвращает `planning.plan-draft.v1` со string revisions. Existing
month возвращает safe existing ref и `open-existing-month`; ambiguous network
result допускает exact replay.

**Acceptance:** любой из двух members создаёт один empty draft; competing или
replayed commands не создают второй month/history/receipt.

**F03 implementation contract:** `POST /planning/drafts/empty` requires the
session cookie, allowed browser origin and session-bound CSRF header. The JSON
body has `additionalProperties: false` and exactly `commandId` (UUID),
`targetMonth` (canonical `YYYY-MM`) and `focus` (one non-whitespace character,
no U+0000, maximum 500 characters, preserved without trim or normalization).
The actor is derived from the authenticated principal and workspace member resolver; actor,
space and `expectedRevision` payload fields are rejected. Create and exact
replay return `201` and `DraftMutationResponseV1` with string revisions.

The finite mutation Problems are authentication/CSRF, planning authorization,
malformed/unsupported/oversized body, validation, command fingerprint conflict,
`PLAN_MONTH_ALREADY_EXISTS`, and dependency unavailable. Existing-month
conflicts return only the safe draft reference and
`nextAction: "open-existing-month"`; user and space IDs are concealed. The
same conflict shape is used by empty, seed and future publication-copy
adapters so the browser can open the authoritative existing month without
guessing or retrying a second create.

### GAP-04 — Create draft from publication HTTP command

**Implemented state (F04):** `CreateDraftFromPublication` из P09 опубликован
через strict authenticated + CSRF HTTP adapter.

**Required surface:** authenticated + CSRF
`POST /planning/drafts/from-publication`.

Body содержит ровно `commandId`, `sourcePublicationId`, `targetMonth`; source
focus/config/order/provenance переносится по существующему P09 contract. Facts,
statuses, notes/results, reports, reminders, progress и publication metadata не
копируются. Missing и foreign source concealed одинаково.

**Acceptance:** source остаётся byte-stable; destination создаётся один раз и
открывается по возвращённой draft reference; no-facts copy доказан E2E.

**F04 implementation contract:** `POST /planning/drafts/from-publication`
requires the session cookie, allowed browser origin and session-bound CSRF
header. The JSON body has `additionalProperties: false` and exactly
`commandId` (UUID), `sourcePublicationId` (UUID) and canonical `targetMonth`
(`YYYY-MM`). Actor and space fields are rejected and never read; the actor is
derived from the authenticated principal and workspace member resolver. Create
and exact replay return `201` with `DraftMutationResponseV1` and decimal-string
revisions. Missing and foreign publication IDs both return the concealed
`PLAN_PUBLICATION_NOT_FOUND` Problem. Existing destination months return the
safe `PLAN_MONTH_ALREADY_EXISTS` shape with `open-existing-month`; no user,
space or source metadata is returned.

### GAP-05 — Update month focus HTTP command

**Implemented state (F05):** `UpdateMonthFocus` из P01 опубликован через strict
authenticated + CSRF HTTP adapter.

**Required surface:** authenticated + CSRF
`POST /planning/drafts/{planMonthId}/focus`.

Body содержит ровно `commandId`, positive decimal-string `expectedRevision` и
`focus`. Mutation разрешена только для draft, увеличивает только draft revision
и сохраняет existing planning action/history/receipt semantics.

**Recovery:** stale → current draft revision + `reload-draft-and-retry`;
published/non-editable → read-only conflict; exact replay стабилен.

**Acceptance:** параллельное изменение не затирается, server-confirmed focus
попадает в publication preview/snapshot, published month неизменяем.

**F05 implementation contract:** authenticated + CSRF
`POST /planning/drafts/{planMonthId}/focus` requires the session cookie, allowed
browser origin and session-bound CSRF header. Path `planMonthId` is UUID. The
JSON body has `additionalProperties: false` and exactly `commandId` (UUID),
positive decimal-string `expectedRevision` and `focus` (one non-whitespace
character, no U+0000, maximum 500 characters, preserved without trim or
normalization). Actor and space are derived from the authenticated principal
and workspace member resolver.

Success and exact replay return `200 DraftMutationResponseV1`. A fresh command
increments only draft revision and keeps P01 history/receipt semantics; same
focus under a fresh command remains a confirmed revision. Stale returns
`DRAFT_REVISION_CONFLICT` with `expectedRevision`, `currentRevision` and
`nextAction: "reload-draft-and-retry"`; it writes no receipt and the same
command ID can be retried with the current revision. Missing/foreign drafts are
concealed as `PLAN_DRAFT_NOT_FOUND`; published/non-editable months return
`PLAN_DRAFT_NOT_EDITABLE` and their immutable publication snapshots do not
change.

### GAP-06 — Cancel and republish HTTP commands

**Implemented contract:** P08 application commands и persistence доступны через
authenticated HTTP и committed OpenAPI.

**Required surfaces:** authenticated + CSRF:

- `POST /planning/publications/{publicationId}/cancel` с `commandId`,
  `planMonthId`, positive lifecycle `expectedRevision`;
- `POST /planning/drafts/{planMonthId}/republish` с exact P07 confirmation
  fields, positive draft `expectedRevision` и `commandId`.

Cancel разрешён только до начала месяца и при `factsRevision = 0`; он очищает
active pointer, но не изменяет snapshot/history. Republish требует latest
cancellation marker и создаёт следующую append-only publication revision через
тот же P07 builder. Started/factual/stale states имеют разные finite conflicts.

Cancel success и exact replay возвращают `200 planning.plan-month.v1`; stale
lifecycle revision использует `PLAN_MONTH_REVISION_CONFLICT`, а lifecycle guard
использует `PLAN_PUBLICATION_CANCELLATION_CONFLICT` с reason
`not_active|month_started|facts_exist`. Republish success/replay возвращают
`201 planning.plan-publication.v1`; неверный выбор initial publish/republish
возвращает `PLAN_PUBLICATION_MODE_CONFLICT` с required mode и nullable latest
publication revision. Actor и space остаются server-derived.

**Acceptance:** `W-07/W-11` показывают только server-confirmed draft/new
publication; старые publications доступны по exact ID и не переписываются.

### GAP-07 — Fact and lifecycle audit read models

**Implemented contract:** module-owned append-only history доступна через два
authenticated bounded read model без global audit store.

**Required surfaces:** authenticated bounded GET:

- `GET /tracking/facts/{factRecordId}/history`;
- `GET /planning/months/{planMonthId}/history`.

Fact history содержит original actor, last editor/system actor, timestamps,
correction/delete reason, typed old/new revision refs и tombstone/compensation
events. Month history содержит publish/cancel/reopen/reclose actor/reason/time,
old/new lifecycle status/mode и publication/report revision refs.

История остаётся module-owned: addendum не вводит global arbitrary-JSON audit
store. Free text reason разрешено вернуть авторизованным members, но запрещено
логировать или включать в telemetry. Pagination/order deterministic; response
принадлежит одному consistent snapshot.

Оба endpoint принимают optional integer `limit` `1..50` (default `20`) и
optional positive decimal-string `cursor`. Items отсортированы newest-first по
after revision; `nextCursor` равен after revision последнего item либо `null`.
Каждая страница, включая member resolution, header и items, читается в одной
`REPEATABLE READ READ ONLY` transaction.

Fact response `tracking.fact-history.v1` содержит original actor/createdAt,
current revision и exact variants `recorded|corrected|tombstoned|undone` с
actor/time, nullable reason, before/after revision refs и compensation detail.
Month response `planning.month-history.v1` содержит current lifecycle и exact
variants `published|publication_cancelled|grace_started|closed|reopened|reclosed`
с before/after status/mode/revision, actor/time, reopen reason и nullable exact
publication/report refs. Missing и foreign IDs concealed as module-owned 404;
reason возвращается только в authorized response и не входит в access logs или
telemetry.

**Acceptance:** `W-06` показывает полную доступную fact chain, а
`W-07/W-13/W-15` — bounded lifecycle timeline; foreign resources concealed.

### GAP-08 — Frontend-safe OIDC result redirect

**Implemented state:** после совпавшего browser-binding распознанные terminal
outcomes возвращают bodyless `303` на `/auth/telegram/result`.

**Required behavior:** сохранить все A03 security/consume/cookie precedence, но
после распознанного terminal callback завершать browser ceremony `303` на
фиксированный relative frontend route `/auth/telegram/result`.

Redirect query содержит только один finite safe result code из backend-owned
allowlist `success|cancelled|login_rejected|access_denied|dependency_unavailable|invalid_callback`.
Provider description/URI, `state`, `code`, tokens, claims, Telegram
ID и internal exception не попадают в URL. Caller-controlled `returnTo` и open
redirect запрещены. Pre-binding malformed/mismatched requests, для которых
redirect ослабит security semantics, могут сохранить direct safe Problem
Details; точный boundary фиксирует F08 contract test.

**Acceptance:** cancel, login rejected, access denied, dependency unavailable и
invalid callback различимы в `W-01`; повтор login создаёт новую ceremony, а
существующая A03 fail-closed policy не ослаблена.

### GAP-09 — Bot navigation metadata

**Implemented state:** authenticated `GET /telegram/navigation` возвращает
server-owned bot capability отдельно от reminder delivery status; frontend не
хардкодит username/URL.

**Required surface:** authenticated `GET /telegram/navigation`.

Response содержит configured HTTPS bot URL, finite capability/status и только
безопасные presentation metadata. Username/URL не является identity key. Raw
Telegram ID, chat ID, provider claims и bot token не возвращаются. Если нужен
`start` payload, он opaque, bounded, expiring и integrity-protected; прямое
включение member/user ID запрещено.

Bot unavailable/misconfigured возвращается как явный unavailable capability и
не блокирует web tracking. `blocked/connection_lost` продолжает принадлежать
`GET /reminders/delivery-status`.

**Acceptance:** `W-01/W-14` открывают правильного configured bot без frontend
constant и не смешивают navigation с delivery health.

Exact v1 response содержит `schemaVersion=telegram.navigation.v1`, capability
`open_bot`, status `available|disabled|misconfigured` и `url`. URL non-null
только для `available` и имеет canonical форму `https://t.me/<username>` без
query/start payload; disabled/misconfigured возвращают `url: null`.

## 4. OpenAPI и межрепозиторный handoff

Каждая `F01…F09` task обязана в том же commit:

1. добавить controller/DTO/problem contribution и exact operationId;
2. обновить unit/integration/E2E contract coverage;
3. regenerate, lint и drift-check `docs/api/openapi.json`;
4. сохранить закрытые schemas с `additionalProperties: false`;
5. проверить string serialization revisions/bigints/decimals и session/CSRF;
6. зафиксировать consumer-visible recovery semantics.

`F10` выбирает воспроизводимый handoff: frontend закрепляет backend Git SHA и
checksum committed OpenAPI artifact; local sibling-path и CI retrieval не могут
молча использовать разные bytes. Backend local commit, backend remote push,
frontend regeneration, hosted deployment и browser smoke являются отдельными
claims.

Проверенный F10 handoff использует backend OpenAPI revision
`ef76210ad66d442704417addfcf54e7f68cab65d`, SHA-256
`ed80c89d36296750da11f68f4597a732a8e4e08f82f2e81a6ba8369dd2a9a625` и
frontend consumer commit
`5e300725b207398da088511eb59f4fd36168d29a`. Команда
`pnpm frontend-api:verify` проверяет committed backend bytes, наличие canonical
OpenAPI revision в local tracking ref `origin/main`, clean frontend HEAD,
manifest, byte-for-byte snapshot, F01–F09 operation mappings, consumer
scripts/CI command и generated provenance. Live remote publication отдельно
зафиксирована через `git ls-remote` в
`docs/evidence/frontend-api-handoff.md`.

## 5. Acceptance gate

Backend объявляется frontend-contract-ready только когда одновременно:

- `GAP-01…GAP-09` имеют merged OpenAPI operations/behavior на published
  backend `main`;
- все mutation replays, stale conflicts, concealed-resource и PII-negative
  cases покрыты;
- frontend consumer закрепил exact backend SHA/OpenAPI checksum и успешно
  regenerated client;
- mobile/desktop browser flows прошли отдельный frontend gate;
- hosted OIDC, HTTPS/proxy, bot navigation и session/CSRF прошли deployment
  smoke без PII leakage.

Локальный `pnpm check`, backend Docker smoke или один успешный HTTP request не
доказывают весь gate.

На 30 августа 2026 года contract-часть `F10` принята независимым review и
frontend consumer commit опубликован. GitHub source-check для exact F10 commit
не запускался, потому что после merge PR #1 новая feature-ветка не имеет
открытого PR. Полный gate этого раздела также не закрыт: mobile/desktop browser
flows и hosted OIDC/HTTPS/proxy/bot/session smoke не выполнялись.
