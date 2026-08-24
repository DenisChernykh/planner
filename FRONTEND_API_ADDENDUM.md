# Planner Backend: Frontend API Addendum

**Версия:** 1.0
**Дата:** 24 августа 2026 года
**Статус:** обязательные backend-требования; реализация `F01…F10` не начата
**Backend contract baseline:** `44f00d00715d6a485ad5aff3f36680a414af96ae`
**Frontend consumer baseline:** `DenisChernykh/planner-frontend@9eb6e299bb9c36191fbf735004a3a78a1fd78d2f`

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

**Current state:** `GET /auth/me` возвращает только `userId` и `sessionId`;
workspace resolver не является browser read model.

**Required surface:** authenticated `GET /workspace/current`.

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

**Recovery:** `401` → новый login; missing membership → concealed finite `403`;
inconsistent pair state → safe `409/503`, без частичного member list.

**Acceptance:** `W-02/W-10/W-13/W-14` показывают «я / партнёр / shared», owner
selection и report labels без hardcoded UUID/persona.

### GAP-02 — Plan/month discovery

**Current state:** известный `targetMonth` читается через tracking query, а
active publication — отдельным query; перечисления history/future months нет.

**Required surface:** authenticated `GET /planning/months` с bounded pagination.

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

**Current state:** `CreateEmptyDraft` реализован в P01 только как application
command.

**Required surface:** authenticated + CSRF `POST /planning/drafts/empty` поверх
существующего `planning.create-empty-draft.v1`.

Body содержит ровно `commandId`, `targetMonth`, `focus`; actor/space отсутствуют.
Success/replay возвращает `planning.plan-draft.v1` со string revisions. Existing
month возвращает safe existing ref и `open-existing-month`; ambiguous network
result допускает exact replay.

**Acceptance:** любой из двух members создаёт один empty draft; competing или
replayed commands не создают второй month/history/receipt.

### GAP-04 — Create draft from publication HTTP command

**Current state:** `CreateDraftFromPublication` реализован в P09 только как
application command.

**Required surface:** authenticated + CSRF
`POST /planning/drafts/from-publication`.

Body содержит ровно `commandId`, `sourcePublicationId`, `targetMonth`; source
focus/config/order/provenance переносится по существующему P09 contract. Facts,
statuses, notes/results, reports, reminders, progress и publication metadata не
копируются. Missing и foreign source concealed одинаково.

**Acceptance:** source остаётся byte-stable; destination создаётся один раз и
открывается по возвращённой draft reference; no-facts copy доказан E2E.

### GAP-05 — Update month focus HTTP command

**Current state:** `UpdateMonthFocus` реализован в P01 только как application
command.

**Required surface:** authenticated + CSRF
`POST /planning/drafts/{planMonthId}/focus`.

Body содержит ровно `commandId`, positive decimal-string `expectedRevision` и
`focus`. Mutation разрешена только для draft, увеличивает только draft revision
и сохраняет existing planning action/history/receipt semantics.

**Recovery:** stale → current draft revision + `reload-draft-and-retry`;
published/non-editable → read-only conflict; exact replay стабилен.

**Acceptance:** параллельное изменение не затирается, server-confirmed focus
попадает в publication preview/snapshot, published month неизменяем.

### GAP-06 — Cancel and republish HTTP commands

**Current state:** P08 application commands и persistence реализованы, HTTP и
OpenAPI отсутствуют.

**Required surfaces:** authenticated + CSRF:

- `POST /planning/publications/{publicationId}/cancel` с `commandId`,
  `planMonthId`, positive lifecycle `expectedRevision`;
- `POST /planning/drafts/{planMonthId}/republish` с exact P07 confirmation
  fields, positive draft `expectedRevision` и `commandId`.

Cancel разрешён только до начала месяца и при `factsRevision = 0`; он очищает
active pointer, но не изменяет snapshot/history. Republish требует latest
cancellation marker и создаёт следующую append-only publication revision через
тот же P07 builder. Started/factual/stale states имеют разные finite conflicts.

**Acceptance:** `W-07/W-11` показывают только server-confirmed draft/new
publication; старые publications доступны по exact ID и не переписываются.

### GAP-07 — Fact and lifecycle audit read models

**Current state:** module-owned append-only history существует, но T07/report
read models отдают только current values/revisions.

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

**Acceptance:** `W-06` показывает полную доступную fact chain, а
`W-07/W-13/W-15` — bounded lifecycle timeline; foreign resources concealed.

### GAP-08 — Frontend-safe OIDC result redirect

**Current state:** success callback делает `303 /`, а terminal failures
возвращают Problem Details непосредственно в top-level browser navigation.

**Required behavior:** сохранить все A03 security/consume/cookie precedence, но
после распознанного terminal callback завершать browser ceremony `303` на
фиксированный relative frontend route `/auth/telegram/result`.

Redirect query содержит только один finite safe result code из backend-owned
allowlist. Provider description/URI, `state`, `code`, tokens, claims, Telegram
ID и internal exception не попадают в URL. Caller-controlled `returnTo` и open
redirect запрещены. Pre-binding malformed/mismatched requests, для которых
redirect ослабит security semantics, могут сохранить direct safe Problem
Details; точный boundary фиксирует F08 contract test.

**Acceptance:** cancel, login rejected, access denied, dependency unavailable и
invalid callback различимы в `W-01`; повтор login создаёт новую ceremony, а
существующая A03 fail-closed policy не ослаблена.

### GAP-09 — Bot navigation metadata

**Current state:** reminder delivery status не содержит server-owned bot link;
frontend не должен хардкодить username/URL.

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
