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
module-owned history и отчёты. Auth Redis пилота используется только для
opaque web-сессий и короткоживущих one-time Telegram OIDC transactions. Queue
Redis, BullMQ и transactional outbox не подключаются без отдельно доказанной
необходимости.

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

Locked ceremony-start contract для A02:

- public `GET /auth/telegram/start` не принимает caller-controlled body/query,
  callback или post-login redirect: любое query field, parser-accepted JSON
  object/array и non-JSON text wire body возвращают existing
  `VALIDATION_FAILED` `422` до provider/Redis. Strict JSON scalar и malformed
  JSON сохраняют общий `MALFORMED_REQUEST` `400`, а valid JSON body больше
  `1_048_576 bytes` — общий `PAYLOAD_TOO_LARGE` `413`; обе parser-границы
  срабатывают до controller. Success отвечает `302` без body, с
  `Cache-Control: no-store`, `Pragma: no-cache`,
  `Referrer-Policy: no-referrer` и request ID;
- discovery всегда загружается только с фиксированного
  `https://oauth.telegram.org/.well-known/openid-configuration`: redirects
  запрещены, timeout равен `2_000 ms`; body до `16_384 bytes` включительно
  разрешён, `16_385 bytes` отклоняется до полной буферизации;
- metadata обязана содержать exact issuer `https://oauth.telegram.org`, exact
  authorization endpoint `https://oauth.telegram.org/auth`, response type
  `code`, PKCE method `S256` и scopes `openid`, `profile`,
  `telegram:bot_access`; внешний provider не входит в readiness;
- runtime принимает только `TELEGRAM_OIDC_CLIENT_ID` как canonical positive
  decimal string, `TELEGRAM_OIDC_CALLBACK_URL` с exact path
  `/auth/telegram/callback` и отдельный 32-byte canonical base64url secret
  `AUTH_OIDC_STATE_KEY_SECRET`; production callback использует HTTPS, а
  development/test дополнительно допускают HTTP только на literal loopback IP
  `127.0.0.1` или `[::1]`; hostname `localhost` не считается canonical;
- `state`, `nonce` и PKCE verifier независимо создаются из 32 CSPRNG bytes и
  проходят decode/re-encode canonical validation как unpadded base64url length
  `43`; PKCE challenge равен `base64url(SHA-256(ASCII(verifier)))` и проходит
  ту же validation. Полный authorization URL строится до Redis create;
  совпавший entropy tuple либо Redis state collision приводит к полной
  повторной генерации, максимум три раза;
- authorization query содержит ровно `client_id`, configured `redirect_uri`,
  `response_type=code`, `scope=openid profile telegram:bot_access`, `state`,
  `nonce`, `code_challenge`, `code_challenge_method=S256`; `phone` и
  caller-controlled query отсутствуют;
- Redis key равен
  `planner:auth:v1:oidc-transaction:<HMAC-SHA-256(state)>`; raw `state` не
  хранится ни в key, ни в value. Exact record:
  `{ schema: 1, issuer: "https://oauth.telegram.org", clientId, nonce,
  codeVerifier, callbackUrl, returnTo: "/" }`; encode валидирует и проецирует
  ровно эти семь полей, а decode требует `clientId` и `callbackUrl`, равные
  текущему runtime config;
- transaction TTL равен `300_000 ms`; create использует `SET NX PX`, consume
  использует atomic `GETDEL`; missing, expired и replayed state возвращают
  отсутствие transaction, malformed record удаляется и fail-closed как auth
  dependency failure;
- start привязывается к инициировавшему браузеру transient cookie, равной raw
  `state`: `planner-oidc-state` в development/test и
  `__Host-planner-oidc-state` в production; `HttpOnly`, `SameSite=Lax`,
  `Path=/`, no `Domain`, `Secure` в production, `Max-Age=300`; новый start в
  том же браузере заменяет cookie, поэтому валиден последний start;
- A03 до Redis consume обязана constant-time сравнить callback `state` с этой
  cookie. Mismatch не consumes transaction и не очищает cookie другого
  валидного concurrent start; matched terminal callback consumes transaction
  один раз и очищает cookie;
- discovery/Redis failure возвращает существующий safe
  `DEPENDENCY_UNAVAILABLE` `503` без cookie, redirect и PostgreSQL writes.
  Provider failure происходит до Redis create; неоднозначный Redis timeout
  может оставить только inert TTL-record и всё равно отвечает `503`;
- `state`, cookie, `nonce`, verifier, challenge, authorization `Location`,
  code/tokens/provider payload и raw Telegram ID не логируются;
- A02 не выполняет callback, token exchange, JWKS/claims validation, allowlist
  lookup, identity binding, User/session creation — всё это принадлежит A03.

Anonymous ceremony-start остаётся ограничен временем жизни Redis records, но
не глобальной cardinality и не числом discovery requests. Это явно принятый
риск локального закрытого пилота; отдельный доказанный ingress rate-limit
contract обязателен до любого публичного deployment. A02 не переносит
password-flow limiter и не вводит новый application-wide Redis abstraction.

Locked callback/identity contract для A03:

- public `GET /auth/telegram/callback` не принимает caller-controlled redirect.
  Strict JSON scalar и malformed JSON сохраняют общий `MALFORMED_REQUEST` `400`,
  valid JSON body больше `1_048_576 bytes` — `PAYLOAD_TOO_LARGE` `413`, а любой
  parser-accepted object/array или non-JSON text body даёт
  `VALIDATION_FAILED` `422` до ceremony I/O;
- первая фаза принимает ровно один canonical 43-character `state`. Missing,
  duplicate, non-canonical state либо constant-time mismatch с browser-binding
  cookie возвращает module-owned `OIDC_LOGIN_REJECTED` `401` без `GETDEL` и без
  очистки cookie. После match controller заранее выставляет
  `Cache-Control: no-store`, `Pragma: no-cache`,
  `Referrer-Policy: no-referrer`, вызывает application use case через
  `try/finally` и всегда очищает state cookie;
- use case выполняет ровно один `GETDEL` без retry до обработки остального
  callback. Затем exact success query содержит только scalar `state` и `code`,
  где code — visible ASCII length `1..4096`. Exact OAuth error содержит
  `state`, `error` и optional `error_description`/`error_uri`: каждое поле
  scalar и unique; `error` — RFC 6749 NQSCHAR length `1..128`, description —
  NQSCHAR до `1024`, URI value — NQSCHAR до `2048`. Description и URI не
  сохраняются и не логируются;
- code вместе с error, duplicate/array/unknown/missing/invalid remaining fields
  при уже matched canonical state образуют application candidate `invalid`:
  transaction consumes один раз, затем existing `VALIDATION_FAILED` `422`
  получает ровно одну safe issue
  `{ pointer: "/query", code: "invalid_value", detail: "OIDC callback query is invalid." }`.
  OAuth error consumes transaction, не вызывает provider/PostgreSQL/session и
  возвращает `OIDC_LOGIN_REJECTED` `401`;
- missing/expired/replayed transaction, token endpoint `invalid_grant`, invalid
  signature/claims/nonce возвращают тот же safe `OIDC_LOGIN_REJECTED` `401`.
  Verified identity вне allowlist и любой binding collision возвращают новый
  `OIDC_ACCESS_DENIED` `403`; dependency failures — существующий safe
  `DEPENDENCY_UNAVAILABLE` `503`. Titles/details не содержат provider data;
- success отвечает bodyless `303` с exact relative `Location: /`, request ID,
  перечисленными cache/referrer headers, новой local-session cookie и очисткой
  state cookie. Callback response, state, code, OAuth error values, cookies,
  tokens и raw Telegram ID не логируются;
- после `GETDEL` provider выполняет ровно по одному redirect-free request в
  порядке discovery → token → JWKS, без retry, cache или UserInfo. Каждый
  request имеет timeout `2_000 ms`, принимает только JSON и streaming body до
  `16_384 bytes` включительно. Discovery фиксирует issuer, authorization,
  token и JWKS endpoints, Authorization Code grant, `client_secret_basic`,
  `RS256`, `S256` и A02 scopes;
- token request использует Basic credentials и form ровно из
  `grant_type`, `code`, `redirect_uri`, `client_id`, `code_verifier`. Только
  JSON `400 { error: "invalid_grant" }` является login rejection; другие
  status/error/malformed/oversized responses — dependency failure. Success
  требует bounded non-empty `access_token`, compact `id_token`, exact
  `token_type=Bearer`; optional `expires_in` — positive safe integer;
- pilot pin-ит `RS256`; BotFather configuration с другим signing algorithm
  является rejected operational drift. Fresh JWKS на каждый callback содержит
  не более 16 keys с unique `(kid, alg)` и ровно один подходящий public RSA key
  не короче 2048 bits; `use` absent/`sig`, `key_ops` absent либо содержит
  `verify`. Protected header требует `alg=RS256`, bounded `kid`, optional exact
  `typ=JWT` и запрещает `none`, `jku`, `x5u`, `jwk`, `x5c`, `crit`, `b64`;
- JWT проверяется локальным JWK set с exact issuer и scalar audience, optional
  `azp` absent/exact client ID, bounded opaque case-sensitive `sub`, integer
  `exp`/`iat`, expected nonce и numeric `id`. Один injected `nowMs` используется
  и для JWT, и для session; tolerance `30 s`, `iat` лежит в
  `[now-330 s, now+30 s]`, `exp > iat` и `exp > now-30 s`. Nonce canonical и
  сравнивается constant-time. JSON-number `id` должен быть positive integer не
  больше `2^52-1`, затем конвертируется в `bigint`. Optional `at_hash` и
  `c_hash` проверяются по access token/code. Profile/phone claims игнорируются;
- API runtime требует отдельный `TELEGRAM_OIDC_CLIENT_SECRET`: opaque exact
  non-trimmed UTF-8 value `16..512 bytes` без control characters. Secret не
  нужен database-only provisioner/migrator и никогда не входит в diagnostics;
- exact flow: consume → provider verification → atomic PostgreSQL binding
  commit → S04 session issue → cookies. PostgreSQL failure не создаёт session.
  Redis session failure даёт `503` и no session cookie, но уже проверенный
  durable binding сохраняется; новая ceremony idempotently переиспользует его.
  Response-write failure может оставить только недоступную TTL session.
  Негативные исходы до binding не создают identity/session.

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
- future display projection может хранить mutable `name`,
  `preferred_username`, `picture` только в отдельной named task после появления
  consumer; identity binding A03 эти claims не сохраняет.

A03 не сохраняет profile claims: до появления named display consumer они
проверяются только как untrusted optional payload и немедленно отбрасываются.
`telegram_external_identities` хранит immutable
`{ issuer, subject, provider_user_id, user_id, created_at }`, unique
`(issuer, subject)`, `(issuer, provider_user_id)` и `(issuer, user_id)` и
composite FK `(user_id, provider_user_id)` на одну allowlist row. Auth-owned
binding adapter читает из workspace-owned allowlist только эту exact identity
projection и не импортирует workspace module.

OIDC `id` приходит JSON number и поэтому A03 принимает только диапазон
`1..2^52-1`. A01 сознательно сохраняет более широкий lossless signed-BIGINT
operator boundary; provisioned значение выше OIDC range остаётся валидной
allowlist записью, но не может аутентифицироваться через текущий Telegram JSON
claim contract.

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

### 6.6. A01 operator provisioning и pair workspace

A01 создаёт pair identity только одноразовой PostgreSQL-only operator-командой
`pnpm provision:pair`. HTTP endpoint, public/JIT signup, Redis и OIDC в этом
процессе отсутствуют. Команда читает из `stdin` один JSON document не больше
`16_384` bytes и принимает только объект следующей формы:

```json
{
  "members": [
    { "userId": "lowercase-canonical-uuid", "telegramId": "9007199254740993" },
    { "userId": "lowercase-canonical-uuid", "telegramId": "9007199254740995" }
  ]
}
```

Объект и каждый member имеют exact keys. `members` содержит ровно две записи с
разными `userId` и Telegram ID. Telegram ID существует только как canonical
positive signed-`BIGINT` decimal string: без leading zero, знака, exponent или
JSON number; application/Prisma получают `bigint`. Порядок двух записей не
значим, но mapping `userId → telegramId` значим.

Команда использует отдельную validated database-only config projection и не
требует Redis/session/API variables. В одной PostgreSQL transaction под
фиксированным transaction-scoped advisory lock она через auth-owned operator
seam создаёт отсутствующих local User, затем один Space, два Membership и две
allowlist-записи. Уже существующий User с тем же explicit UUID сохраняется без
изменений. Space и Member UUID генерируются только при первом успешном запуске.
Crash или constraint failure откатывает все записи.

Exact same mapping, включая reversed input order и новый process, возвращает
прежние Space/Member UUID без writes. Любое изменение user set, Telegram set
или их pairing, а также partial/inconsistent workspace state возвращает typed
`PairProvisioningConflictError`; provisioning не является repair/update
процедурой. Concurrent equal commands дают один create и replay с тем же
result, concurrent different commands — один complete winner и один conflict,
без mixed pair.

`spaces` имеет DB-enforced singleton constant. `memberships` использует только
technical slots `1|2` с `CHECK` и unique `(space_id, slot)`, unique
`(space_id, user_id)` и unique `user_id`; slot не задаёт persona, owner, role
или права. `telegram_access_allowlist.telegram_id` — PostgreSQL `BIGINT` unique,
`user_id` unique и ссылается на membership того же User. Поэтому второй Space,
третий Membership и allowlist для User вне пары не коммитятся. «Закрытое» не
является status-колонкой: оно означает отсутствие публичного provisioning.

CLI возвращает только canonical JSON `{ status, spaceId, members: [{ memberId,
userId }] }`, отсортированный по `userId`, и никогда не печатает Telegram ID.
Exit codes: `0` для `created/existing`, `2` для invalid input, `3` для state
conflict и `1` для dependency/unexpected failure; stderr содержит только finite
safe message.

`WorkspaceMemberResolver` реализует ledger contract и возвращает ровно
`{ spaceId, memberId, userId }`. Unknown User/Telegram ID даёт safe typed
`WorkspaceMemberNotFoundError` без writes, database failure — отдельный
`WorkspaceDependencyUnavailableError`. P01 расширяет тот же public port методом
`resolveMember(memberId)` с тем же exact result и safe error contract. Planning
commands принимают trusted member actor, разрешают member server-side и выводят
`spaceId`; payload не содержит `spaceId`, `memberId`, `userId` или
`trustedActor`. A01 доказывает общий `spaceId` и
отсутствие role; read-all plan и сравнение trusted `memberId` с будущим
`owner_member_id` проверяются в первых planning/personal-mutation slices, а не
симулируются до появления этих моделей.

## 7. Концептуальная модель хранения

Названия таблиц являются целевыми концептами; P01 фиксирует первые physical
names и ограничения ниже, следующие tasks добавляют только свои модели без
ослабления этих инвариантов.

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

P02 фиксирует только version envelope и continuity mechanism. Его metadata —
ровно `title`, `why`, `category`; typed `GoalConfig`, scope/owner/type/unit,
precision/repetition/aggregation, children, draft attachment, publish
validation и snapshots принадлежат P03 и следующим задачам. P02 выполняет
только явное `SeriesDecision = 'continue' | 'new'` и не выводит semantic
compatibility из metadata. Metadata-only P02 version не publishable и не
attachable к draft до typed seam P03.

Public identities и read views P02:

```ts
type GoalDefinitionId = string;
type GoalDefinitionVersionId = string;
type GoalSeriesId = string;
type GoalDefinitionState = "active" | "archived";
type SeriesDecision = "continue" | "new";

type GoalDefinitionVersionView = {
  goalDefinitionVersionId: GoalDefinitionVersionId;
  versionNumber: bigint;
  goalSeriesId: GoalSeriesId;
  seriesDecision: SeriesDecision;
  title: string;
  why: string;
  category: string;
};

type GoalDefinitionSummary = {
  goalDefinitionId: GoalDefinitionId;
  state: GoalDefinitionState;
  revision: bigint;
  currentVersion: GoalDefinitionVersionView;
};

type GoalDefinitionDetail = GoalDefinitionSummary & {
  versions: readonly GoalDefinitionVersionView[];
};
```

P02 migration `20260811140000_goal_catalog` создаёт четыре tables. Definition
имеет UUID identity в одном space, finite state, positive consecutive revision,
exact state/archive-time consistency и deterministic list index; identity,
space и created time immutable, DELETE запрещён. Series immutable и принадлежит
ровно одному definition. Version immutable, имеет positive sequential number,
definition-owned series, finite decision и exact metadata; database continuity
требует initial `1/new`, predecessor `+1`, predecessor series для `continue`,
ранее неиспользованную series для `new` и active definition. Immutable
`planning_goal_catalog_changes` хранит typed refs/state/decision для пяти
catalog actions без metadata duplication или arbitrary JSON.

### 7.3. Month, draft и publication

- `plan_months` с UUID PK, `space_id` FK RESTRICT, canonical month как первый
  день в `month_start DATE`, unique `(space_id, month_start)`, finite lifecycle
  status `draft|published|grace|closed`, lifecycle revision `BIGINT >= 1` и
  explicit timestamps; начиная с P08 отдельный `facts_revision BIGINT >= 0`
  изменяется только tracking-командами и не смешивается с lifecycle revision;
- `plan_drafts` с mandatory editable month focus и optimistic revision;
- `plan_draft_goals` с editable configuration, analytical-series reference,
  order и optional display-only `sourceProvenance`;
- `plan_publications` — append-only publication revisions с immutable month
  focus;
- `plan_goal_snapshots` — immutable calculation-relevant configuration,
  provenance и exact successful P04 calendar;
- `fixed_expectations` — ожидаемые даты/checkpoints/items с
  `UNIQUE NULLS NOT DISTINCT` stable key;
- `flexible_periods` — weekly/monthly/weekly-task period identity и сохранённый
  exact P04 target;
- `planning_publication_changes` — immutable typed history detail
  `published|cancelled`; publish хранит confirmed preview и переход
  `NULL -> publication`, cancel — переход `publication -> NULL` без изменения
  publication row;
- `planning_month_copy_changes` — immutable typed detail только для
  `draft_copied`: source publication ID, bounded количество скопированных целей
  и exact destination order новых plan-goal IDs.
- `planning_seed_consumptions` — immutable typed detail одноразового
  `draft_created_from_seed`: exact seed ID/schema/version, выбранная actor
  persona, постоянные `memberA|memberB -> member` bindings, 41 новых definition IDs
  и exact destination order.

Одна plan month может иметь несколько publication revisions, но не более одной
active publication. Cancel до начала месяца помечает revision cancelled; он не
переписывается и не удаляется.

P01 создаёт только goal-empty draft: `plan_months` и `plan_drafts` без catalog,
goal, fact, publication, seed, active-publication pointer или facts revision.
Focus хранится exact без trim/Unicode normalization; application и database
требуют `btrim(focus)` non-empty и `char_length(focus) <= 500`.

Каждый снимок содержит все поля, влияющие на отображение и расчёты: title,
why, category, scope/owner, type, repetition, target, unit, precision,
aggregation, checkpoint aggregation, components, deadlines, order и config
schema version. Он также содержит optional display-only `sourceProvenance`:
source document/page, raw denominator/value и принятое resolution. Provenance
копируется в preview/report metadata, но не участвует в formulas или решении о
continuity analytical series.

#### 7.3.1. P03 typed draft-goal contract

P03 разводит две границы: exact-shape `DraftGoalConfigV1`, который можно
сохранить с null/empty required leaves, и narrowed `GoalConfigV1`, прошедший
publish validation. Structurally malformed type/discriminator/format, extra
field, prototype/accessor/boxed value или forged child ID отклоняется до записи;
semantic incompleteness сохраняется и возвращается как blocker data. Snapshot
всего input выполняется до первого `await`; output является recursively frozen
plain-data clone. Строки, Unicode bytes и array order не нормализуются.

Pure validator возвращает discriminated result: `{ publishable: true, config:
GoalConfigV1, blockers: [] }` либо `{ publishable: false, config: null,
blockers: nonEmptyTuple }`. `GoalConfigV1` дополнительно имеет private
unique-symbol compile-time brand, который не существует в runtime JSON; только
validator может создать refined value. Planning orchestration, вызывающая
P04/P05, принимает только этот refined `GoalConfigV1` и проецирует его в
complete exact structural DTO соответствующего low-level progress seam.
Сами pure progress seams не принимают на себя доказательство publishability:
они валидируют только полноту/exact shape собственного DTO, не очищают P03
blockers и не должны вызываться с unchecked `DraftGoalConfigV1`.
Public refinement boundary повторно снимает exact stored-form snapshot: она не
брендирует caller-owned object, отклоняет accessor/extra/null child ID и
возвращает recursively frozen clone, не зависящий от последующей мутации input.

`DraftGoalConfigV1` имеет ровно `schemaVersion: 1`, `scope`, `repetition`,
`measurement`, `checkpoints`. Scope — `personal` с nullable
`ownerMemberId` либо `shared` без owner. Repetition — `daily`, `weekdays` с
unique weekday literals в уже canonical Monday order, `weekly|monthly` с
nullable canonical positive integer string `n`, `one_off` с nullable canonical
date или `weekly_planned_task` с nullable ordinal string `1..5` и nullable task
text. Weekly planned task требует boolean measurement, разрешён для personal и
shared и не имеет daily checkpoints.

Measurement — discriminated union:

- `boolean` и `text` без дополнительных полей;
- `quantity` с nullable `targeted|informational` mode, unit, precision `0..3`,
  `add|latest` aggregation и target;
- `actual_time` с nullable canonical `HH:mm` start/end; overnight разрешён,
  равные endpoints publish-blocking;
- `rating` с nullable safe-integer minimum/maximum;
- `checklist` с ordered `{ itemId, label }`;
- `any_of` с ordered `{ variantId, label, unit, precision, target }`.

Canonical decimal — `0` или unsigned integer without leading zeroes с optional
fraction, без sign/exponent/whitespace; scale не превышает precision. Complete
targeted/OR/checkpoint quantity target положительный; scale quantity checkpoint
также не превышает precision его parent quantity measurement; informational quantity
имеет null target. Complete rating требует `minimum < maximum`. Required
text/unit/name/label bounded to 500 Unicode code points and non-whitespace.
Null/empty required leaves являются blockers; malformed non-null values —
structural error. Checklist items, OR variants and checkpoints bounded to 100;
active goals in one draft and reorder IDs bounded to 200. Bound overflow —
structural `422`. P03 проверяет у one-off только canonical date syntax и
completeness; принадлежность target month и calendar eligibility начинает P04.

Checkpoints nullable и разрешены только при `daily`. Non-null value имеет
nullable `independent|all` aggregation и ordered items `{ checkpointId, name,
deadline, satisfaction }`. Deadline — nullable `HH:mm`. Satisfaction
discriminator обязан совпадать с parent measurement: boolean/rating/text без
leaf values, quantity со своим target, actual-time со своим range, checklist/
any-of используют parent composition. Nested checkpoints запрещены. Stable
UUID child IDs живут внутри immutable config JSON: add принимает только absent/
null IDs и назначает server UUID; update сохраняет известные IDs и назначает
UUID только новым absent/null children, запрещая forged, duplicate и
cross-component reuse.

Optional `SourceProvenanceV1` имеет exact shape `{ schemaVersion: 1,
sourceDocument, sourcePage, rawValue, rawDenominator, resolution }`. Document и
resolution — exact non-whitespace strings до 500 code points; page — positive
safe integer; raw fields — nullable exact strings до 2,000 code points.
Provenance display-only: оно меняет command fingerprint, но исключено из
semantic series signature, formulas и future expectations.

Physical P03 seam создаётся одной migration
`20260811150000_typed_draft_goals`: mutable root `plan_draft_goals`, immutable
`plan_draft_goal_revisions` и immutable typed detail
`planning_draft_goal_changes`. Root хранит plan/space/definition identity,
display order, current revision и nullable detached time; revision хранит source
catalog version отдельно от effective series, exact config/provenance и
timestamp. Stable children не имеют отдельных tables. Cross-space composite
FKs, deferrable current-revision FK, immutable revision/history triggers,
no-DELETE root guard и finite action/detail shape не позволяют обходить
application invariants. P02 series не считается orphan, если на неё ссылается
catalog version или draft-goal revision.
Partial unique active `(plan_month_id, goal_definition_id)` запрещает два
одновременных attachments одной definition; application проверяет тот же
инвариант под draft lock и возвращает finite structural `422`, а unique index
остаётся DB backstop. Remove tombstones существующий
root; последующий add создаёт новый plan-goal, revision и stable child IDs, не
восстанавливая старую identity. Deferred root invariant ограничивает active set
200 строками и требует dense display order `0..count-1` после add/remove/
reorder. Typed history хранит exact `before_order`/`after_order`: reorder
фиксирует полную перестановку active set, remove — полный previous set и ровно
этот set без tombstoned goal; произвольные, duplicate, subset и foreign-month
UUID запрещены.
Typed detail дополнительно связывает exact current/adjacent config revisions,
parent draft `before/+1/after`, completed receipt aggregate/result и финальный
effect. Поэтому старая, обратная или несмежная revision pair, ложный previous
order и receipt другого plan month/revision не могут закоммититься.

P07 создаётся ровно migration `20260811151000_plan_publication`. Она добавляет
`plan_months.active_publication_id` с deferred same-month pointer FK и пять
tables: `plan_publications`, `plan_goal_snapshots`, `fixed_expectations`,
`flexible_periods`, `planning_publication_changes`. Publication revision
positive/consecutive и unique внутри month; publication, snapshots, calendars и
typed detail запрещают ordinary UPDATE/DELETE. Same-space composite FKs
связывают month, publishing member, source root/revision/catalog
version/effective series и owner. Snapshot order dense, active source set
полон и не превышает 200. Fixed stable key использует `UNIQUE NULLS NOT
DISTINCT`; flexible stable period и ordinal keys unique, quota arrays
sorted/unique/in-bounds и согласованы с exact P04 JSON.

Deferred commit invariants требуют: draft month имеет `NULL` pointer,
published/grace/closed — same-month pointer; publication содержит ровно current
active draft roots и полный materialized calendar; `month_published` имеет
ровно один typed detail, completed receipt с publication result ref и exact
month before/+1/after effect. P07 исправляет P03 all-month action unique index,
не меняя принятую миграцию: draft actions сохраняют отдельную partial
последовательность draft revision, `month_published` — отдельную lifecycle
последовательность.

Один preview/publication имеет deterministic hard cap
`MAX_PUBLICATION_MATERIALIZED_ROWS = 10_000`. В cap входят все будущие
`plan_goal_snapshots` + развёрнутые `fixed_expectations` + все
`flexible_periods`; header/history/receipt не входят. P06 считает его только из
уже полученных successful P04 calendars и locked component-expansion rule. При
превышении P06 до вычисления hash добавляет один plan-level blocker
`{planGoalId:null,pointer:'/goals',code:'incompatible',detail:'Publication
materialization exceeds 10000 rows.'}`. P07 пересчитывает тот же blocked preview
под lock и не пишет ни одной строки.

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

P07 разворачивает fixed calendar в компоненты однозначно. Без checkpoints
scalar и `any_of` создают одно expectation `goal` с `NULL component_id` на
каждую P04 fixed date; checklist создаёт по одному `checklist_item` на stable
item ID без дополнительного parent expectation. При наличии checkpoints
создаётся по одному `checkpoint` на stable checkpoint ID/date; вложенные
checklist/any-of значения остаются частью будущего checkpoint fact и не
создают второе измерение expectation. Quota и `weekly_planned_task` создают
periods, а не fixed expectations. Все quota periods из P04 сохраняются,
включая preactivation period с target `0`; полностью preactivation
weekly-task period отсутствует и его `not_applicable` остаётся derived.

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

#### 7.6.1. T01 Boolean/quantity record kernel

Application command `tracking.record-fact.v1` принимает exact payload
`{ publicationId, planGoalSnapshotId, localDate, value }`, где `value` имеет
вид `{kind:'boolean',result:'done'|'not_done'}` либо
`{kind:'quantity',value:canonicalDecimal}`. Result —
`tracking.fact-record.v1`; actor берётся только из trusted context. HTTP,
Telegram и presentation DTO в T01 не добавляются.

Target всегда относится к active publication конкретного месяца и immutable
goal snapshot. Локальная дата обязана быть не позже injected current local
date, не раньше `activeLocalDate` и соответствовать physical fixed expectation
либо eligible date ненулевого flexible period. Scalar T01 отклоняет checkpoint,
weekly planned task и другой measurement kind. Personal fact изменяет только
owner; shared snapshot имеет один logical stream, доступный обоим участникам.

Для Boolean и quantity `latest` отсутствие `expectedRevision` означает create.
Начиная с T05 существующий logical stream изменяется только dedicated
`tracking.correct-record.v1`; повтор typed record-команды возвращает finite
`correction_required`. Конкурентный create одного logical stream даёт одному
command success, второму finite conflict. Quantity `add` запрещает
`expectedRevision`: каждый новый command создаёт отдельный opaque contribution
record revision `1`, поэтому конкурентные независимые вклады не конфликтуют.
Exact command replay выполняется до clock, membership и target lookup.
Для нового effect durable executor создаёт единственный `occurredAt`; его
локальная дата в `Asia/Yekaterinburg` одновременно задаёт future-date policy и
проверяемую audit boundary, поэтому отдельного чтения часов после replay нет.

Migration `20260811160000_tracking_record_kernel` добавляет typed
`tracking_fact_records`, append-only `tracking_fact_revisions`, module-owned
`tracking_action_groups` и `tracking_fact_changes`. Одна durable PostgreSQL
transaction блокирует month, создаёт/версионирует fact, переводит current
pointer, увеличивает `plan_months.facts_revision` ровно один раз, добавляет
history и completed receipt. Deferred constraints связывают active publication,
calendar unit, scope/owner, measurement/precision, revision chain,
`factsRevision`, action и receipt; history/revisions immutable, physical delete
record запрещён. Unique `(plan_month_id, after_facts_revision)` не позволяет
двум completed effects разделить один revision increment. Upgrade preflight под
lock отклоняет legacy T01 command/result receipts и необъяснимый ненулевой
`facts_revision`, потому что безопасного backfill до typed kernel нет. Tombstone
discriminator зарезервирован в revision schema для T05, но T01 command создаёт
только `recorded` revisions.

#### 7.6.2. T02 Time/rating/checkpoint extension

T02 добавляет application-only команды `tracking.record-time.v1`,
`tracking.record-rating.v1` и `tracking.record-checkpoint.v1`; все три
возвращают `tracking.fact-record.v1` и используют тот же durable executor,
membership boundary, owner rule и CAS revision chain, что T01. HTTP, OpenAPI и
Telegram остаются границей H01/G03. Time и rating payload фиксируют
`{ publicationId, planGoalSnapshotId, expectationDate, value }`, checkpoint
добавляет обязательный stable `checkpointId` и discriminated Boolean/time/rating
value. Create не принимает `expectedRevision`; начиная с T05 correction
исполняет dedicated audited command с текущей positive fact revision.

`expectationDate` является частью identity и не выводится из времени ввода:
overnight значение после полуночи можно связать с ожиданием предыдущего дня.
Команда всё равно запрещает дату позже durable `occurredAt` в
`Asia/Yekaterinburg`. Top-level time/rating в T02 требуют physical fixed goal
expectation без checkpoints; flexible time/rating возвращают finite
`unsupported` до writes, а composite occurrence остаётся T04. Checkpoint
command адресует ровно physical
`fixed_expectations(component_kind='checkpoint', component_id=checkpointId)`;
поэтому разные checkpoints одной даты имеют независимые logical records,
revisions и receipts. Rating обязан быть safe integer внутри опубликованного
parent range, но minimum остаётся заполненным и достигнутым фактом. Для time
любой canonical `HH:mm` от `00:00` до `23:59` сохраняется, PostgreSQL `24:00`
отвергается, а попадание в обычный/overnight range вычисляет P05.

Migration `20260811161000_time_rating_checkpoints` добавляет typed
`actual_time_value TIME(0)` и `rating_value BIGINT`, расширяет finite fact и
command discriminators и заменяет single-value identity на calendar-component
keys. Обновлённые deferred checks связывают command kind, component identity,
published config, typed revision, owner, month `facts_revision`, action и
receipt; old T01 records остаются валидными и immutable.

Read-only `GetGoalProgressQuery` строит channel-neutral P05 input только из
immutable publication snapshot/calendar и current fact revisions. Он сохраняет
отдельные checkpoint values, группирует quantity contributions и вызывает
чистый `evaluateGoalProgress`; presentation query shapes для Today/Month будут
добавлены T07/H01, а не T02.

#### 7.6.3. T03 Text/checklist extension

T03 добавляет application-only команды `tracking.record-text.v1` и
`tracking.record-checklist-item.v1`; обе возвращают
`tracking.fact-record.v1`, используют общий durable executor, trusted member,
owner rule, future-date boundary и CAS revision chain T01. HTTP, OpenAPI и
Telegram остаются последующими H02/G04.

Text payload имеет exact shape
`{ publicationId, planGoalSnapshotId, expectationDate, checkpointId, text,
result }`, где `checkpointId` — stable UUID либо `null`, `text` — исходная
непустая строка, а `result` — `done|not_done`. Checklist-item payload имеет
exact shape
`{ publicationId, planGoalSnapshotId, expectationDate, checkpointId,
checklistItemId, state }`, где `state` — `done|not_done`. Отсутствие
`expectedRevision` означает create; начиная с T05 correction исполняет
dedicated audited command с текущей positive revision. Exact replay
предшествует clock, membership и target lookup.

Без checkpoints text адресует physical `goal` expectation, а checklist item —
ровно свой physical `checklist_item` expectation. При checkpoints обе команды
адресуют physical `checkpoint` expectation; checklist item дополнительно
несёт stable item ID из parent measurement. Поэтому каждый checklist item
имеет отдельный logical record/revision chain, но P05 projector группирует
актуальные item states обратно в одно checklist value соответствующей даты или
checkpoint. Отдельный parent fact, parent expectation или parent coverage unit
не создаётся. Flexible text/checklist occurrence остаётся T04 и в T03
отклоняется finite `unsupported` до writes.

Migration `20260811162000_text_checklist_facts` добавляет typed
`text_value`, `text_result`, `checklist_item_state` и nullable stable
`checklist_item_id`, расширяет finite command/fact discriminators и physical
identity indexes. Deferred checks связывают command kind, exact published
goal/checkpoint/item component, typed revision history, owner, month
`facts_revision`, action и receipt. Старые T01/T02 records остаются валидными и
immutable.

#### 7.6.4. T04 OR/informational/flexible composite extension

T04 добавляет application-only команды `tracking.record-or-variant.v1` и
`tracking.record-composite-occurrence.v1`; обе возвращают
`tracking.fact-record.v1` и переиспользуют durable replay, trusted-member
authorization, owner rule, future-date boundary и CAS revision chain tracking
kernel. HTTP, OpenAPI и Telegram остаются H02/G04, correction reason и
tombstones — T05.

OR-variant payload имеет exact shape
`{ publicationId, planGoalSnapshotId, expectationDate, checkpointId,
variantId, value }`, где `checkpointId` — stable UUID либо `null`, `variantId`
— stable UUID опубликованного варианта, а `value` — canonical nonnegative
decimal с precision этого варианта. Команда адресует fixed `goal` либо
`checkpoint` expectation. Каждый вариант имеет отдельный logical record и CAS
revision chain, но P05 projector группирует актуальные варианты одного
expectation и использует maximum normalized fraction, не сумму.

Flexible composite payload имеет exact shape
`{ publicationId, planGoalSnapshotId, localDate, component }`, где component —
`{ kind:'checklist_item', checklistItemId, state:'done'|'not_done' }` либо
`{ kind:'or_variant', variantId, value }`. Команда допускает только eligible
дату ненулевого weekly/monthly period без checkpoints. Logical identity
ограничена publication, snapshot, physical period, local date и stable
component ID. Компоненты одной даты сохраняют независимые revision chains, а
projector детерминированно собирает их в один `quota_occurrence`. Отдельный
parent fact не создаётся.

Informational quantity продолжает использовать
`tracking.record-fact.v1`: fixed measurement остаётся coverage unit, flexible
occurrence не получает target, progress, score, coverage или вклад в aggregate
score. Notification/reminder suppression доказывается в последующих
notification tasks; T04 не создаёт delivery rows.

Migration `20260811163000_or_composite_facts` добавляет typed
`or_variant_value` и nullable stable `or_variant_id`, расширяет finite
command/fact discriminators и component-aware fixed/flexible uniqueness.
Deferred checks связывают exact command mode, published variant/item,
precision, calendar period/date, typed revision history, owner, month
`facts_revision`, action и receipt. Populated T01–T03 rows остаются byte-stable,
valid и immutable после upgrade.

#### 7.6.5. T05 Corrections and tombstones

T05 добавляет application-only команды `tracking.correct-record.v1` и
`tracking.delete-record.v1`. Exact correction payload —
`{ factRecordId, value, reason }`, deletion — `{ factRecordId, reason }`;
обе команды требуют positive `expectedRevision`, trusted member и непустую
причину длиной не более 2000 символов. Result остаётся
`tracking.fact-record.v1` с тем же record ID и новой revision. HTTP, OpenAPI,
Telegram, undo и reopen остаются H02/G04, T06 и L02.

Correction адресует record по opaque ID внутри пространства, повторно
проверяет active publication, effective `published|grace` lifecycle и текущую
revision. Она создаёт следующую typed `recorded` revision и может восстановить
текущий tombstone. Personal record изменяет только owner; shared record может
исправить любой участник, но причина всегда обязательна. Первоначальный
`created_by_member_id` immutable, текущий revision actor является last editor.

Delete разрешён только owner personal record. Он не удаляет record, revisions
или history, а добавляет `tombstoned` revision со всеми value columns `NULL`.
Shared delete и повторный delete отклоняются. Read state и P05 используют
только current `recorded` revisions, поэтому tombstone даёт derived `no_data`;
последующая correction с current tombstone revision восстанавливает факт.

Обычное correction window заканчивается в `00:00` четвёртого локального дня
после месяца независимо от задержки worker: effect с local date позже третьего
дня отклоняется как `closed`. Reopened lifecycle добавит L02; T05 не расширяет
окно и не меняет plan configuration.

Migration `20260811164000_fact_corrections_tombstones` добавляет finite
`fact_corrected|fact_tombstoned`, exact command discriminators и bounded
immutable action reason. Одна durable transaction блокирует month/record,
проверяет CAS/ownership/window, добавляет revision, переводит pointer,
увеличивает `facts_revision` ровно один раз и связывает action/change/receipt.
Deferred constraints запрещают old record-командам создавать новые revisions,
связывают before/after chain, actor, reason, typed current value/tombstone и
сохраняют старые T01–T04 actions/revisions неизменными.

#### 7.6.6. T06 Undo last own action

T06 добавляет application-only команду
`tracking.undo-last-own-action.v1` с exact payload `{ factRecordId }`,
обязательной positive `expectedRevision` текущего record и result
`tracking.fact-record.v1`. Actor берётся только из trusted member context;
system actor запрещён. HTTP, OpenAPI, Telegram и UI остаются H03/G05. Exact
replay и fingerprint conflict исполняются durable executor до clock,
membership и чтения target.

Команда закрепляет месяц opaque target record и находит в нём последнее по
`after_facts_revision` ещё не компенсированное reversible-действие этого
участника. Undo-actions, действия партнёра и system-actions кандидатами не
являются. Если кандидат относится к другому record, возвращается finite
`not_latest`; если current revision уже имеет чужое либо системное
происхождение — `superseded`. Более старое действие не выбирается. Повторный
Undo пропускает уже компенсированные actions и идёт назад по этому стеку.

Undo create/add добавляет tombstone. Undo correction и personal delete
добавляет `recorded` revision с точной копией всех typed value columns из
before-revision компенсируемого action; actor и timestamp принадлежат Undo,
первоначальный recorder record остаётся неизменным. Действуют active
publication, effective `published|grace`, T05 correction deadline и CAS target
record; `closed` или inactive month не изменяется.

Migration `20260811165000_fact_undo` добавляет immutable one-to-one
`tracking_fact_undo_changes(action_id, undone_action_id,
restored_from_revision_id)`. Одна transaction блокирует month, затем record,
добавляет revision, переводит current pointer, увеличивает `facts_revision`
ровно на один, создаёт `fact_undone` action/change/detail и completed receipt.
Deferred constraints повторно связывают own/latest uncompensated action,
same month/record, current provenance, adjacent revisions, точное restored
value, receipt и final `facts_revision`; UPDATE/DELETE undo history запрещены.
Dispatcher сохраняет populated T01–T05 history и применяет T06 checks только к
новому command discriminator.

#### 7.6.7. T07 Today and Month read models

T07 добавляет channel-neutral `GetTodayQuery({ trustedActor })` и
`GetMonthQuery({ trustedActor, targetMonth })`. Оба принимают только trusted
member actor и возвращают tagged read model `no_plan|draft|published`;
отсутствие плана является успешным состоянием, а не `404`. Today один раз
читает локальную дату `Asia/Yekaterinburg` и возвращает только её день. Month
принимает любой canonical `YYYY-MM` пространства и возвращает все даты месяца.

Published variant содержит active publication metadata, lifecycle и facts
revisions, immutable ordered goal config/calendar, viewer-relative access
`personal_owner|shared|partner_read_only`, current typed fact revisions,
tombstones, fixed expectations, flexible/weekly periods и чистый P05 progress.
Даты до `active_local_date` остаются `not_applicable`; отсутствие current
record не превращается в `not_done`. Full audit revision history не входит в
read model. Quota period дополнительно содержит вычисленные P04
`expectedProgress` и P05 `actualProgress` на тот же as-of; weekly planned task
имеет `expectedProgress = null`, а после T09 содержит current week-level
`done/not_done` fact с record ID, revision и автором.
Flexible-only цель считается применимой по календарю периода и получает
`no_data|partial|filled` по current period facts, хотя её P05 coverage остаётся
намеренно `0/0`; агрегат дня учитывает такую применимость отдельно от coverage.

PostgreSQL adapter выполняет bounded set-based projection в одной read-only
`REPEATABLE READ` transaction: не более 200 goals, 10 000 materialized units и
10 000 current records. `facts_revision`, records и derived P05 state относятся
к одному MVCC snapshot; превышение лимита отклоняет весь ответ без truncation.
Для дня progress считается на `min(day, queryLocalDate)`, для month summary —
на `min(queryLocalDate, monthEnd)`. Effective phase не доверяет задержавшемуся
worker: persisted `published` после month end читается как `grace`, а после
третьего grace-дня writeability блокируется календарной correction deadline;
`closed` требует persisted close/report. Edge adapters не читают
planning/tracking tables напрямую и не создают собственное состояние.

HTTP публикует authenticated GET `/tracking/today` и
`/tracking/months/{targetMonth}` без CSRF. Malformed month возвращает finite
`400 TRACKING_QUERY_INVALID`, missing membership —
`403 TRACKING_AUTHORIZATION_DENIED`, dependency/projector failure — общий
`503 DEPENDENCY_UNAVAILABLE`. Write endpoints, CloseDay, weekly result,
Telegram и UI остаются H01–H03, T08–T09 и G01–G05.

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

P01 материализует planning-owned `planning_action_groups` только с finite
`draft_created|month_focus_updated`, exact actor member/system columns and
consistency checks, actor scope, plan-draft target, command identity,
nullable/positive before revision, positive after revision и одним
`occurred_at`. One-to-one `planning_month_focus_changes` хранит nullable exact
before focus и mandatory exact after focus. Composite action command key имеет
deferred FK на completed receipt key: action допустим до insert receipt внутри
одной transaction, но orphan не коммитится. Receipt и обе history tables
запрещают ordinary UPDATE/DELETE database triggers.

P02 делает `plan_month_id` nullable, добавляет `goal_definition_id` и расширяет
finite action kind ровно
`goal_definition_created|goal_definition_versioned|goal_definition_archived|goal_definition_restored|goal_definition_copied`.
Exact target/action check требует только plan month для двух P01 kinds и только
goal definition для пяти P02 kinds. P01 actor consistency, command key,
revisions, deferred receipt FK и immutable trigger сохраняются. Product effect,
typed catalog detail, action group и completed receipt используют одну
transaction и один executor timestamp.

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

Application-only команда `planning.create-draft-from-publication.v1` принимает
exact payload `{ sourcePublicationId, targetMonth }`, запрещает
`expectedRevision` и возвращает `planning.plan-draft.v1` revision `1`. Source
может быть любой same-space publication по ID, включая cancelled или
historical revision. Target — любой canonical свободный `YYYY-MM` в диапазоне
`0001..9999`; product clock задаёт только единый audit timestamp и не
ограничивает месяц.

Durable executor до clock, membership и source read обрабатывает exact replay
и fingerprint conflict. Для fresh command одна PostgreSQL transaction:

1. Авторизует member и читает exact same-space source publication; missing и
   foreign source одинаково дают `PlanPublicationNotFoundError`.
2. Пытается создать unique destination `plan_month`. Любой уже существующий
   destination status даёт `PlanMonthAlreadyExistsError(existingRef)` без
   copy history и completed receipt; competing inserts сериализуются unique
   constraint и создают ровно один destination.
3. Создаёт `draft` с lifecycle/draft revision `1`, `facts_revision = 0`,
   `active_publication_id = NULL` и source focus.
4. Одним bounded set-based copy до `200` целей создаёт новые plan-goal и config
   revision IDs. Из snapshot сохраняются definition version, analytical series,
   order, scope/owner, exact config, provenance и stable component IDs, включая
   weekly planned task text и ordinal.
5. Добавляет finite `draft_copied` action,
   `planning_month_copy_changes(sourcePublicationId, copiedGoalCount,
   afterOrder)` и completed receipt в той же transaction.

Migration `20260811153000_copy_month` deferred constraints связывают action,
source publication, destination month/draft/goals и completed receipt; требуют
same-space, обе destination revisions `1`, exact copied configuration/order и
отсутствие лишних destination config revisions. Copy detail и участвующая
publication history immutable; UPDATE/DELETE запрещены.

Source publication и исходный month остаются byte-stable. Destination не
получает publication metadata, preview/hash, calendars, expectations, periods,
facts, statuses, notes/results, coverage, progress, notification occurrences
или reports. Facts/corrections/reports до T01/E01 ещё отсутствуют в schema,
поэтому P09 доказывает их структурное отсутствие; regression с populated source
принадлежит T01/E01.

#### 9.1.1. `CreateDraftFromSeed`

HTTP/application команда `planning.create-draft-from-seed.v1` принимает exact
payload `{ targetMonth, actorPersona: 'memberA'|'memberB' }`, запрещает
`expectedRevision` и возвращает `planning.plan-draft.v1` revision `1`.
`POST /planning/drafts/from-seed` требует session и CSRF. Target — любой
canonical свободный `YYYY-MM`; clock задаёт только единый audit timestamp.

Membership slots остаются техническими и не определяют persona или права.
Пользователь явно выбирает свою persona только при использовании ещё не
израсходованного seed. Planning-local resolver под transaction lock требует
ровно двух same-space members, связывает actor с выбранной persona и второго
member с оставшейся persona. Оба участника сохраняют равные права; immutable
consumption навсегда фиксирует обе привязки.

Durable executor обрабатывает exact replay и fingerprint conflict до clock,
membership, pair binding и persistence. Fresh transaction сначала сериализует
`(space, april-plan)` advisory lock и проверяет consumption, затем destination.
Поэтому уже использованный seed даёт `PlanSeedAlreadyConsumedError`, а любой
существующий destination при ещё свободном seed —
`PlanMonthAlreadyExistsError(existingRef)` без consumption или receipt.

Fresh success одним bounded set-based materialization создаёт goal-empty kernel
и одновременно 41 новые active definitions, по одной new series/version `1`,
41 draft roots/config revisions `1`, current pointers, dense order, exact
P10 config/provenance и stable component IDs. Draft и lifecycle остаются
revision `1`; отдельных P02 catalog actions для initial seed identities нет —
их происхождение покрывает один `draft_created_from_seed` action. Publication,
snapshots, expectations, periods и facts не создаются.

Migration `20260811155000_seed_consumption` делает consumption/history
immutable, unique `(space_id, seed_id)` и deferred связывает exact command,
member actor/persona, destination header/focus, все новые catalog/draft rows,
порядок и completed receipt. Commit-time проверка повторяет финальное состояние,
поэтому mutation после insert detail и любая partial failpoint transaction
полностью откатываются.

### 9.2. `PublishMonth`

Owner команды — application layer модуля `planning`. Одна PostgreSQL transaction
выполняет:

1. Durable executor берёт receipt advisory lock и делает lookup. Exact replay
   возвращает сохранённый publication ref до clock, membership, draft read и
   writes; fingerprint conflict предшествует lifecycle/CAS.
2. Executor читает `clock.now()` один раз. `occurredAt` является publication
   instant, а `Asia/Yekaterinburg` local date выводится из него без второго
   обращения к clock.
3. Transaction разрешает trusted member, затем вместе блокирует
   `plan_months` и `plan_drafts` через `FOR UPDATE`. Missing/foreign concealed,
   status обязан быть `draft`, active pointer — `NULL`, draft revision — exact
   caller-confirmed revision.
4. Под удерживаемым lock одним internally consistent read получает current
   roots/revisions/catalog metadata/order/config/provenance.
5. Ровно один раз перестраивает принятый P06 projector с frozen local date и
   до первой записи сравнивает draft revision, preview schema/hash versions и
   hash. Blockers дают отдельный publication-blocked conflict.
6. Из уже построенного preview, без второго P04 и без P05/facts, создаёт
   append-only publication revision, immutable goal snapshots с exact P04
   calendars, fixed expectations и flexible periods.
7. Устанавливает `active_publication_id`, переводит month `draft -> published`
   и увеличивает только lifecycle revision на один; draft revision не меняется.
8. Создаёт finite `month_published` action и typed publication detail.
9. Executor проверяет `planning.plan-publication.v1` result ref, записывает
   completed receipt с тем же timestamp, после чего deferred constraints
   проверяют pointer, completeness, history/effect/linkage и выполняется один
   commit.

Ни один участвующий модуль не коммитится отдельно. Published month без полного
набора expectations/periods невозможен.

Publication snapshot hash — это подтверждённый и заново вычисленный P06
`planner.publication-preview-hash.v1`; отдельного P07 hash algorithm нет,
generated IDs/timestamps не добавляются в preimage. Different command IDs
сериализуются month/draft lock: winner публикует, loser получает
already-published/non-editable conflict без второй revision. Edit-first делает
preview stale, publish-first блокирует edit. Любая ошибка materialization,
history, receipt или deferred validation откатывает все строки.

### 9.3. Cancel и republish

Cancel разрешён только до начала месяца и при отсутствии facts. Transaction:

- exact replay `planning.cancel-publication.v1` возвращает сохранённый
  `planning.plan-month.v1` ref до clock, membership и aggregate read;
- одним clock read выводит local date по `Asia/Yekaterinburg`, разрешает
  member, блокирует month и exact publication, проверяет active pointer,
  lifecycle revision, `localDate < monthStart` и `factsRevision = 0`;
- добавляет immutable cancellation marker/history; саму publication row не
  обновляет;
- очищает active pointer;
- возвращает plan month в draft и увеличивает lifecycle revision один раз;
- не меняет и не удаляет snapshot rows.

`planning.republish-month.v1` принимает тот же revision-bound confirmed preview,
что P07 publish, но разрешён только после cancellation marker. Он использует тот
же projector/materialization builder и создаёт следующую consecutive
publication revision с новым набором snapshots/expectations/periods. Обычный
`planning.publish-month.v1` после cancel отклоняется: initial publish и
republish являются разными durable intents. Records всегда ссылаются на
конкретную publication revision.

### 9.4. `CloseDay`

T08 добавляет channel-neutral `PreviewCloseDayQuery` и durable
`tracking.close-day.v1`. Участник может явно закрыть текущую или прошедшую
применимую дату active publication до обычной correction deadline: в месяце
`published` и в grace-дни 1–3. Пропущенный день автоматически не меняется:
после deadline он остаётся `no_data` без возможности ручного CloseDay.

Preview содержит actor-relative ordered set unresolved fixed expectations,
`factsRevision` и versioned SHA-256 hash. В набор входят personal ожидания
участника и shared; personal партнёра, flexible weekly/monthly goals и
`weekly_planned_task` исключаются. Любая current recorded typed revision,
включая частичное значение, считается заполнением; tombstone снова делает
expectation unresolved.

Подтверждение одной transaction блокирует month, повторно проверяет active
publication, membership, local date, effective `published|grace`, correction
deadline, CAS и exact preview hash. Один `day_closed` action создаёт отдельные
generic `fixed_not_done` records для оставшегося набора, переводит их pointers,
увеличивает `facts_revision` ровно один раз и связывает multi-effect history,
immutable closure detail и completed receipt. Пустой exact set всё равно
создаёт closure marker и revision step. Unique `(publication_id, local_date,
member_id)` запрещает второй intent; exact command replay возвращает receipt.

Последующая typed запись перекрывает generic marker в P05 и T07 projections;
её tombstone или Undo снова проявляет `not_done`. Generic marker нельзя
адресовать correction/delete/Undo. Month/Today возвращают viewer-relative
closure metadata, но полная audit history остаётся вне read model. Migration
`20260811166000_close_day` сохраняет populated T01–T07 rows и deferred-проверяет
set, ownership, dates, adjacent facts revision, effects и receipt.

### 9.5. Weekly planned task result

T09 добавляет durable `tracking.record-weekly-task-result.v1` с exact payload
`{ publicationId, flexiblePeriodId, result }`. Initial запись не принимает
`expectedRevision`: logical identity задаётся immutable `flexible_period_id`, а
повторный новый intent требует существующую `tracking.correct-record.v1` с
positive record revision и причиной. Exact replay выполняется до clock,
membership и target lookup.

Member может записать personal period только как owner, а shared — как любой
участник пространства. Target обязан быть physical `weekly_planned_task`
period active publication; запись разрешена только между
`max(period_start, active_local_date)` и `period_end` включительно. Canonical
storage anchor `local_date = period_start` не создаёт daily expectation и не
делает результат quota occurrence.

Одна transaction блокирует month и period, повторно читает logical identity
после lock, создаёт record/revision/pointer, увеличивает `facts_revision` ровно
на один и сохраняет action/change/receipt. Fact kind `weekly_task_result`
использует `boolean_result`; T05 correction/personal delete и T06 Undo работают
через расширенные dispatchers. Today/Month прикрепляют current revision ко
всему period, а P05 считает `done = 100%`, `not_done|no_data = 0%`. Physical
system actor result и автоматический already-system-closed path появляются
только вместе с T10 `CloseWeek`; T09 фиксирует конечную application error для
этой границы без создания системных строк.

### 9.6. `CloseWeek`

Владелец weekly planned task может выставить ей `done/not_done` в течение
недели через web или Telegram. В `00:00` следующего понедельника либо на
границе месяца worker исполняет idempotent `CloseWeek`:

1. Определяет period, обрезанный границами active month.
2. Находит незаполненные weekly planned tasks этого period.
3. Одним action group сохраняет для них `not_done` от system actor.
4. Не создаёт daily failures для flexible quotas.
5. Увеличивает `factsRevision` один раз и сохраняет receipt.

Повторный запуск не меняет уже выставленный пользователем результат.

T10 реализует это внутренней durable-командой `planning.close-week.v1` с
payload `{ publicationId, periodStart, periodEnd }`, без `expectedRevision` и
только от `system:planner-worker`. Все physical weekly planned tasks одной
публикации с одинаковыми границами образуют одну группу; минимальный
`flexiblePeriodId` группы является стабильной group identity и command ID
первого закрытия. Если уже закрытый system-result впоследствии tombstoned,
следующее закрытие получает детерминированный generation command ID из group
identity и числа предыдущих `week_closed` actions. Поэтому competing workers
используют один durable key внутри generation, а completed receipt предыдущей
generation не подавляет повторное закрытие. Receipt возвращает
`planning.week-close.v1`, aggregate ID action group и aggregate revision,
равную новому `factsRevision`.

Transaction блокирует month и повторно читает logical results. Recorded
`done/not_done` сохраняются; отсутствующий record получает system-authored
revision `1`, а текущий tombstone — следующую system-authored recorded revision
`not_done`. Один `week_closed` action содержит все changes и увеличивает
`factsRevision` ровно один раз. Если под lock незаполненных задач уже нет,
операция не создаёт receipt или history. Tracking actor columns используют
exact-one member/system representation; Today/Month возвращают nullable
`recordedByMemberId` и `recordedBySystemActorId`.

Отдельный `planner-worker` сначала выполняет authoritative due-scan и только
после его успеха объявляет process-local readiness. Затем transferred REL-03
runner запускает непересекающиеся циклы с default delay 30 секунд
(конфигурируемый диапазон 15–60 секунд). Due instant равен `00:00` дня после
`periodEnd` в `Asia/Yekaterinburg`, поэтому один контракт покрывает Monday и
month boundary. Неожиданная ошибка завершает process; restart повторяет scan.
Runner прекращает admission и ждёт активный цикл до 5 секунд, общий shutdown
PostgreSQL/observability ограничен 10 секундами.
SIGINT/SIGTERM admission устанавливается до PostgreSQL connect и initial scan;
сигнал отменяет startup, не допускает readiness и запускает тот же bounded
cleanup PostgreSQL/observability.

### 9.7. `CloseMonth` и `RecloseMonth`

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

### 9.8. Scheduled lifecycle enforcement

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
export type ActorRef =
  | { readonly kind: "member"; readonly id: string }
  | { readonly kind: "system"; readonly id: "planner-worker" };

export type ApplicationCommand<TPayload> = {
  readonly commandId: string;
  readonly trustedActor: ActorRef;
  readonly expectedRevision?: bigint;
  readonly payload: TPayload;
};

export type DurableCommandResultRef<K extends string = string> = {
  readonly kind: K;
  readonly aggregateId: string;
  readonly aggregateRevision: bigint;
};

export type CommandExecutionContext = { readonly occurredAt: Date };

export type CommandDefinition<TPayload, K extends string> = {
  readonly commandType: string;
  readonly resultKind: K;
  readonly toCanonicalPayload: (payload: TPayload) => CanonicalJsonObject;
};

export interface CommandExecutor {
  execute<TPayload, K extends string>(
    definition: CommandDefinition<TPayload, K>,
    command: ApplicationCommand<TPayload>,
    effect: (
      context: CommandExecutionContext,
    ) => Promise<DurableCommandResultRef<K>>,
  ): Promise<DurableCommandResultRef<K>>;
}
```

Web и Telegram adapters создают одинаковые product commands. `trustedActor`
никогда не принимается из untrusted payload: web получает его из сессии,
Telegram — из verified private-chat `from.id`, worker использует отдельного
system actor. `commandId` — canonical lowercase UUID. Member actor scope равен
`member:<canonical-lowercase-member-uuid>`, system scope —
`system:planner-worker`.

### 10.2. Durable receipt

Unique scope:

```text
(actorScope, commandType, commandId)
```

Receipt хранит SHA-256 lowercase 64-hex canonical request fingerprint, finite
typed result kind, aggregate ID, positive aggregate revision и completion time;
произвольного result JSONB нет. Neutral receipt port и Prisma adapter принадлежат
database platform, не planning. Effect, action history и completed receipt
коммитятся одной transaction.

Порядок выполнения обязателен:

1. Взять transaction-scoped PostgreSQL lock
   `pg_advisory_xact_lock(hashtextextended(keyJson, 8503113703))` для полного
   receipt key.
2. Найти receipt.
3. При same key/different fingerprint вернуть
   `CommandFingerprintConflictError`.
4. При same key/same fingerprint восстановить typed ref и вернуть его без clock,
   permission, aggregate read или effect.
5. Только для нового command прочитать `ProductClock.now()` ровно один раз.
6. Вызвать module effect, который владеет permission, CAS, effect и typed
   history.
7. Проверить expected result kind, canonical ID и positive revision.
8. Записать completed receipt с тем же timestamp и commit.

Crash до commit не оставляет ни effect, ни receipt. Retry выполняет команду
заново. Completed receipts immutable. Collision advisory hash может
сериализовать unrelated commands, но не меняет correctness. Receipts пилота
хранятся не меньше связанных facts.

Canonical fingerprint v1 имеет preimage с ключами `commandType`,
`expectedRevision`, `payload`. Actor и command ID не входят в fingerprint,
поскольку входят в receipt key. `expectedRevision` отсутствующий становится
`null`, присутствующий — positive canonical base-10 decimal string. Command
definition exact-validates and exact-projects payload, включая rejection extra
fields. Canonical JSON recursively сортирует object keys по UTF-16 code units,
сохраняет array order/string bytes, не делает trim/Unicode normalization и
кодируется UTF-8 JSON. Он rejects `undefined`, payload bigint, unsafe/non-finite
numbers, Date, class instances, cycles и unpaired surrogates. Lossless integer
DTO уже является decimal string. Known vector:

```text
{"commandType":"planning.update-month-focus.v1","expectedRevision":"7","payload":{"focus":"Прожить апрель","planMonthId":"018f0000-0000-7000-8000-000000000001"}}
d2a4181c1d2a1f3ce552e90e927be25f2ff2cc7f6f431ec39de2f8580c72f5de
```

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

P01 `CreateEmptyDraft` принимает exact `{ targetMonth, focus }`, запрещает
`expectedRevision`, создаёт lifecycle revision `1n` и draft revision `1n` и
возвращает `planning.plan-draft.v1` ref. Canonical month — `YYYY-MM`, years
`0001..9999`; P01 не ограничивает create текущим/следующим месяцем. Different
command ID для уже существующего space/month возвращает safe existing ref в
`PlanMonthAlreadyExistsError` без receipt/history.

P01 `UpdateMonthFocus` принимает exact `{ planMonthId, focus }`, требует
positive draft `expectedRevision`, атомарно увеличивает только
`plan_drafts.revision`; plan-month lifecycle revision не меняется. Same focus
под новым command ID является новой подтверждённой правкой. Stale fresh command
не пишет receipt, поэтому тот же command ID можно retry с новой expected
revision/fingerprint. `GetDraftQuery({ trustedActor, targetMonth })` выполняет
member authorization без receipt и возвращает `null` или exact draft view.
Оба pair member имеют равные права; fresh system actor возвращает
`PlanningAuthorizationDeniedError` без effect/history/receipt.

Named query возвращает `null` либо ровно:

```ts
{
  readonly planMonthId: string;
  readonly spaceId: string;
  readonly targetMonth: string;
  readonly status: "draft";
  readonly focus: string;
  readonly planMonthRevision: bigint;
  readonly draftRevision: bigint;
}
```

P01 public errors finite: `CommandValidationError`,
`CommandFingerprintConflictError`, `PlanningAuthorizationDeniedError`,
`PlanMonthAlreadyExistsError` с safe existing draft ref,
`PlanDraftNotFoundError`, `PlanDraftNotEditableError`,
`DraftRevisionConflictError { expectedRevision, currentRevision }` и
`PlanningDependencyUnavailableError`. Same-key conflict/exact replay всегда
предшествуют permission/CAS. Fresh stale command не пишет receipt, поэтому тот
же command ID может быть повторён с новой revision и новым fingerprint.

P02 commands имеют exact contracts:

```text
planning.create-goal-definition.v1
  expectedRevision absent
  payload { title, why, category }
planning.create-goal-definition-version.v1
  positive expectedRevision required
  payload { goalDefinitionId, title, why, category, seriesDecision }
planning.archive-goal-definition.v1
  positive expectedRevision required
  payload { goalDefinitionId }
planning.restore-goal-definition.v1
  positive expectedRevision required
  payload { goalDefinitionId }
planning.copy-goal-definition.v1
  positive expectedRevision required for the source
  payload { sourceGoalDefinitionId }
```

Every mutation возвращает только
`DurableCommandResultRef<'planning.goal-definition.v1'>`; `aggregateId` —
target definition UUID, `aggregateRevision` — `goal_definitions.revision`.
Copy проверяет source revision, но возвращает новый active target revision `1n`
с новой version `1n` и новой series, не меняя source. Create создаёт initial
`new`; create-version разрешён только active definition, `continue` использует
series непосредственного predecessor, а `new` создаёт ранее неиспользованную
definition-owned series. Same metadata под fresh command ID является реальной
версией. Archive/restore меняют state и consecutive revision без новой version;
один command timestamp устанавливает/очищает `archived_at`.

Metadata — required primitive strings, exact bytes без trim/Unicode
normalization, non-whitespace, bounds Unicode code points: title `1..200`, why
`1..2_000`, category `1..100`. Exact snapshot до первого await rejects extra
keys, boxed strings, unstable accessors, non-plain objects и injected actor/
member/user/space IDs. Create запрещает `expectedRevision`; остальные P02
commands требуют positive bigint. Replay/conflict precedes clock, permission,
aggregate read, CAS и state validation. Fresh stale/state failure не оставляет
completed receipt/history/effect и допускает retry того же command ID с новым
fingerprint/revision.

`ListGoalDefinitionsQuery({ trustedActor, state })` принимает
`active|archived|all`, default `active`, сортирует по definition `created_at`,
затем ID. `GetGoalDefinitionQuery` возвращает detail или `null`, versions
descending. Оба разрешают только member, не пишут receipt/history, foreign
identity неотличима от not found. External JSON сериализует bigint только как
canonical positive decimal strings; TypeScript/PostgreSQL сохраняют
`bigint`/`BIGINT`.

P02 finite public errors добавляют `GoalDefinitionNotFoundError`,
`GoalDefinitionRevisionConflictError { expectedRevision, currentRevision,
currentState }` и `GoalDefinitionStateConflictError { requestedState,
currentState, currentRevision }`; остальные — `CommandValidationError`,
`CommandFingerprintConflictError`, `PlanningAuthorizationDeniedError` и
`PlanningDependencyUnavailableError`.

P03 commands имеют exact contracts:

```text
planning.add-draft-goal.v1
  positive expectedRevision required
  payload { planMonthId, goalDefinitionId, config, sourceProvenance }
planning.update-draft-goal.v1
  positive expectedRevision required
  payload { planMonthId, planGoalId, goalDefinitionVersionId, config,
            sourceProvenance }
planning.remove-draft-goal.v1
  positive expectedRevision required
  payload { planMonthId, planGoalId }
planning.reorder-draft-goals.v1
  positive expectedRevision required
  payload { planMonthId, orderedPlanGoalIds }
```

Все четыре command возвращают только
`DurableCommandResultRef<'planning.plan-draft.v1'>`; aggregate ID — plan month,
revision — новая `plan_drafts.revision`. P03 не имеет draft-copy command:
catalog copy уже принадлежит P02 и затем добавляется обычным add; month copy
остаётся P09. Remove ставит detach/tombstone, сохраняя root/revisions/history;
reorder требует полную exact permutation всех active goal IDs и выполняется как
одна action/revision.

Caller не передаёт actor/member/user/space/series ID или series decision. Add
атомарно выбирает active current same-space catalog version и её series. Update
может выбрать только version того же definition. Catalog series выбранной
source version сравнивается с catalog series предыдущей source version: только
переход на version из другой catalog series заменяет effective series. Выбор
той же source version или более новой `continue` version в прежней catalog
series сохраняет текущую custom effective series; hard signature change при
этом создаёт новую definition-owned series, а compatible change переиспользует
текущую. Hard
signature включает scope/owner, measurement kind, quantity mode/unit/precision/
aggregation, checkpoint aggregation/composition/satisfaction schema,
checklist-item set и OR-variant set. Repetition kind/frequency/N, targets,
dates/times, display order, child labels и provenance линию не разрывают.
Metadata semantic break выражается P02 version на новой series, не caller flag.

Каждая fresh mutation в одной existing DurableCommandExecutor transaction
делает: receipt lock/replay or fingerprint conflict; member authorization;
same-space draft/month/status lock and draft CAS; catalog/config/series effect;
ровно один finite action `draft_goal_added|draft_goal_updated|
draft_goal_removed|draft_goals_reordered` и один typed detail; draft revision
`+1`; completed receipt. Plan-month lifecycle revision не меняется. Stale,
unauthorized, malformed или dependency-failed command оставляет zero writes;
rollback после product effect откатывает root/revision/series/history/receipt.

`GetDraftEditorQuery({ trustedActor, targetMonth })` является отдельной P03
query и не меняет exact P01 `GetDraftQuery`. Она возвращает draft envelope,
ordered attached goals, catalog metadata/source version/effective series,
recursively frozen config/provenance, per-goal blockers и aggregate blockers.
Validator framework-free, pure, не fail-fast и сортирует safe issues
`{ planGoalId, pointer, code, detail }` по display order, goal ID, RFC 6901
pointer и code. Он проверяет только P03 completeness/compatibility; P04 calendar
targets, P05 score/evaluation, P06 preview/hash и P07 publication/snapshots/
lifecycle не входят.

HTTP seam P03: authenticated `GET /planning/drafts?targetMonth=YYYY-MM`;
session+Origin+CSRF mutations `POST /planning/drafts/{planMonthId}/goals`
(`201`), `POST .../{planGoalId}/update` (`200`), `POST
.../{planGoalId}/remove` (`200`) и `POST
/planning/drafts/{planMonthId}/goals/reorder` (`200`). Request schemas exact,
nested union branches use `oneOf`/discriminator mappings and
`additionalProperties: false`; add/update/stored config имеют отдельные schemas:
add child ID только omitted/null, update — omitted/null/existing UUID, stored —
обязательный UUID. Planning-owned OpenAPI contribution устанавливает эту
лексику через generic platform composition seam. External bigint strings lossless. Structural
validation is finite `422`, not-found draft/goal/version is safe `404`,
not-editable and revision conflict are `409`; only revision conflict carries
its dedicated exact current/expected extension. Publish blockers remain `200`
response data, never RFC 9457 Problems.

## 11. Progress policy

`progress` — чистый policy module. Он принимает immutable goal snapshot,
expectations/periods, facts, calendar и явный `asOf`.

### 11.1. P04 calendar-targets boundary

P04 создаёт public framework-free seam `src/modules/progress` с exact
`CALENDAR_TARGETS_FORMULA_VERSION = "planner.calendar-targets.v1"` и тремя
pure functions: `calculateEligibleCalendar`, `calculatePeriodTarget` и
`calculateExpectedPace`. Модуль владеет structural union
`CalendarRepetitionV1`; последующий planning adapter проецирует в него уже
validated `GoalConfigV1`, поэтому `progress` не импортирует `planning`, другие
product modules, platform/shared/bootstrap, framework/Prisma/HTTP adapters,
`Date`, `Intl` или системные часы.

Граница намеренно двухуровневая: planning orchestration допускает к mapper
только refined `GoalConfigV1`, а low-level `calculateEligibleCalendar` принимает
любой complete exact structural `CalendarTargetsInput`. Он не видит private
planning brand, не доказывает publishability всей цели и не удаляет/переопределяет
P03 blockers. `GoalConfigV1['repetition']` структурно совместим с
`CalendarRepetitionV1`, но mapper всё равно создаёт новый exact object и удаляет
не календарные поля, например `taskText`; nullable
`DraftGoalConfigV1['repetition']` с low-level seam несовместим. Такое разделение
сохраняет dependency direction `planning → progress`, не создавая обратного
импорта.

Calendar context exact: canonical реальный `targetMonth: YYYY-MM` с годом
`0001..9999`, canonical реальный `activeLocalDate: YYYY-MM-DD` строго внутри
target month и literal `timeZone: "Asia/Yekaterinburg"`. Это уже вычисленная
локальная дата; P04 не конвертирует instant и использует manual proleptic
Gregorian arithmetic. Invalid shape/context/math вызывает
`CalendarTargetsInputError` с finite value-free issues `{ pointer, code,
detail }`; inputs не coercе-ятся. Calendar incompatibility является normal
discriminated data: `{ eligible: false, calendar: null, issues }`, а успешный
результат — `{ eligible: true, calendar, issues: [] }`. One-off вне target
month имеет pointer `/repetition/dueDate`, code `incompatible`; отсутствующий
ordinal weekly planned task — `/repetition/weekOrdinal`, `incompatible`.
Outputs являются detached recursively frozen plain data; dates ascending и
unique.

Calendar branches:

- `daily|weekdays|one_off` возвращают fixed `expectationDates`; даты до
  activation исключаются. One-off внутри месяца, но до activation, — успешный
  not-applicable результат без expectation; one-off вне месяца — blocker data.
- `weekly|monthly` возвращают quota periods с `activeDates == eligibleDates`.
  Month имеет один period. Week — chronological Monday–Sunday segment,
  пересечённый month bounds; `periodStart/periodEnd` clipped, но denominator
  всегда `periodDays = 7`. Возвращаются все weekly segments, включая полностью
  pre-activation с пустыми eligible dates и target `0`; каждый segment
  рассчитывается независимо, без debt carry.
- `weekly_planned_task` выбирает максимум один week-level segment с target `1`,
  без daily expectation и even pace. Ordinal `1..5` считает month-bounded
  segments, включая leading partial как `1`; в шестисегментном месяце ordinal
  `5` выбирает пятый, а шестой не назначается. Если ordinal отсутствует в
  четырёхсегментном месяце, возвращается calendar incompatibility. Полностью
  pre-activation выбранный segment — успешный not-applicable результат без
  period; если activation попадает внутрь выбранного segment, один week-level
  period сохраняет исходные clipped start/end и target `1`.

`calculatePeriodTarget({ n, periodDays, activeDays, eligibleDays })` принимает
canonical positive decimal string произвольной длины и safe integers с
`1 <= periodDays <= 366` и `0 <= eligibleDays <= activeDays <= periodDays`.
Нулевой active/eligible count даёт `0`; иначе функция exact integer
`round_half_up` считает `min(max(1, rounded), eligibleDays)`. Она не вызывает
`Number(n)`/unbounded `BigInt(n)`: oversized decimal насыщается относительно
малой доказуемой границы до bounded conversion.

`calculateExpectedPace({ period, asOfLocalDate })` принимает только quota
weekly/monthly period, проверяет unique ascending eligible dates внутри его
bounds, их exact equality с active dates и contiguous active suffix исходного
calendar segment, затем считает текущую eligible date включительно. До первой eligible date
результат `0`, после последней — `periodTarget`, при пустом denominator — `0`;
результат exact half-up и capped target. Функция не принимает previous-period
debt и не читает clock.

Exact public TypeScript ledger P04:

```ts
type CalendarWeekday = 'mon' | 'tue' | 'wed' | 'thu' | 'fri' | 'sat' | 'sun'

type CalendarRepetitionV1 =
  | { kind: 'daily' }
  | { kind: 'weekdays'; weekdays: readonly CalendarWeekday[] }
  | { kind: 'weekly'; n: string }
  | { kind: 'monthly'; n: string }
  | { kind: 'one_off'; dueDate: string }
  | { kind: 'weekly_planned_task'; weekOrdinal: '1' | '2' | '3' | '4' | '5' }

type CalendarTargetsInput = {
  targetMonth: string
  activeLocalDate: string
  timeZone: 'Asia/Yekaterinburg'
  repetition: CalendarRepetitionV1
}

type QuotaCalendarPeriod = {
  cadence: 'weekly' | 'monthly'
  ordinal: number
  periodStart: string
  periodEnd: string
  periodDays: number
  activeDates: readonly string[]
  eligibleDates: readonly string[]
  periodTarget: number
}

type FixedCalendar = CalendarContext & {
  kind: 'fixed'
  expectationDates: readonly string[]
}
type QuotaCalendar = CalendarContext & {
  kind: 'quota'
  cadence: 'weekly' | 'monthly'
  periods: readonly QuotaCalendarPeriod[]
}
type WeeklyPlannedTaskCalendar = CalendarContext & {
  kind: 'weekly_planned_task'
  periods: readonly {
    cadence: 'weekly'
    ordinal: number
    periodStart: string
    periodEnd: string
    periodTarget: 1
  }[]
}
type CalendarContext = Pick<
  CalendarTargetsInput,
  'targetMonth' | 'activeLocalDate' | 'timeZone'
>

type EligibleCalendarResult =
  | {
      formulaVersion: 'planner.calendar-targets.v1'
      eligible: true
      calendar: FixedCalendar | QuotaCalendar | WeeklyPlannedTaskCalendar
      issues: readonly []
    }
  | {
      formulaVersion: 'planner.calendar-targets.v1'
      eligible: false
      calendar: null
      issues: readonly [CalendarEligibilityIssue]
    }

declare function calculateEligibleCalendar(
  input: CalendarTargetsInput,
): EligibleCalendarResult
declare function calculatePeriodTarget(input: {
  n: string
  periodDays: number
  activeDays: number
  eligibleDays: number
}): number
declare function calculateExpectedPace(input: {
  period: QuotaCalendarPeriod
  asOfLocalDate: string
}): number
```

`CalendarTargetsInputError.issues` — frozen non-empty array. Его exact finite
codes: `invalid_type|invalid_value|unexpected_property`; pointers:
`""|/targetMonth|/activeLocalDate|/timeZone|/repetition|/repetition/kind|
/repetition/weekdays|/repetition/n|/repetition/dueDate|
/repetition/weekOrdinal|/n|/periodDays|/activeDays|/eligibleDays|/period|
/period/cadence|/period/ordinal|/period/periodStart|/period/periodEnd|
/period/periodDays|/period/activeDates|/period/eligibleDates|
/period/periodTarget|/asOfLocalDate`. `detail` принадлежит экспортируемому
finite literal union и никогда не включает rejected value. Normal
`CalendarEligibilityIssue` имеет только два exact варианта:
`{/repetition/dueDate, incompatible, due date is outside target month}` либо
`{/repetition/weekOrdinal, incompatible, week ordinal is not present in target
month}`.

### 11.2. P05 goal evaluation boundary

P05 добавляет два pure public seams с независимыми версиями
`GOAL_EVALUATION_FORMULA_VERSION = "planner.goal-evaluation.v1"` и
`SCORE_COVERAGE_FORMULA_VERSION = "planner.score-coverage.v1"`:
`evaluateGoalProgress` вычисляет одну цель, а `calculateScoreCoverage`
агрегирует уже разделённую personal/shared секцию. Внутренний граф зависимостей
ровно `goal-evaluators → score-coverage + calendar-targets`;
`score-coverage` не импортирует evaluator, а внутренние файлы не импортируют
public barrel.

Модуль остаётся framework-free и self-contained: без planning/tracking,
БД/HTTP/Nest/Prisma, `Date`, `Intl`, `Temporal`, системных часов, `process`,
global objects и timers. Planning orchestration допускает к mapper только
refined `GoalConfigV1` и создаёт новый progress-owned
`GoalEvaluationSnapshotV1`. Его literal discriminator
`schemaVersion: "planner.goal-evaluation-snapshot.v1"` не совпадает с P03
schema, поэтому ни refined config целиком, ни nullable draft нельзя передать в
P05 без явной проекции. Mapper удаляет scope/repetition, labels, units,
deadlines и другие поля, не участвующие в формуле. P05 валидирует exact
low-level DTO, но не доказывает publishability и не очищает P03/P04 blockers.

`evaluateGoalProgress` принимает exact `CalendarTargetsInput` provenance и
парный successful P04 result вместе с его `formulaVersion`, snapshot,
authoritative current fact projection и явную canonical `asOfLocalDate`. P05
повторно вызывает P04 policy на provenance и требует exact structural equality
с supplied result; ineligible provenance и forged/truncated/inconsistent
result отвергаются, а формулы календаря не дублируются в P05. Actor,
persistence record IDs/термины, revisions, tombstones/history и timestamps в
DTO отсутствуют. `contributionId` — opaque domain identity текущего active
contribution для projection-wide dedupe, а не ID строки БД или revision.
Отсутствие fact row означает
вычисляемый `no_data`; пользователь не передаёт `no_data` и
`not_applicable`. Явный `not_done` является заполненным fixed unit с нулевым
achievement. `not_applicable` выводится только из calendar/as-of.

Exact public ledger P05:

```ts
type CanonicalExactRatio = {
  readonly numerator: string
  readonly denominator: string
}

type EvaluationMetric =
  | {
      readonly available: true
      readonly exact: CanonicalExactRatio
      readonly basisPoints: string
    }
  | {
      readonly available: false
      readonly exact: null
      readonly basisPoints: null
      readonly reason: 'informational' | 'no_applicable_units'
    }

type EvaluationMeasurementV1 =
  | { readonly kind: 'boolean' }
  | {
      readonly kind: 'quantity'
      readonly mode: 'targeted' | 'informational'
      readonly precision: 0 | 1 | 2 | 3
      readonly aggregation: 'add' | 'latest'
      readonly target: string | null
    }
  | {
      readonly kind: 'actual_time'
      readonly start: string
      readonly end: string
    }
  | {
      readonly kind: 'rating'
      readonly minimum: number
      readonly maximum: number
    }
  | { readonly kind: 'text' }
  | {
      readonly kind: 'checklist'
      readonly items: readonly [
        { readonly itemId: string },
        ...{ readonly itemId: string }[],
      ]
    }
  | {
      readonly kind: 'any_of'
      readonly variants: readonly [
        {
          readonly variantId: string
          readonly precision: 0 | 1 | 2 | 3
          readonly target: string
        },
        ...{
          readonly variantId: string
          readonly precision: 0 | 1 | 2 | 3
          readonly target: string
        }[],
      ]
    }

type EvaluationCheckpointSatisfactionV1 =
  | { readonly kind: 'boolean' }
  | { readonly kind: 'quantity'; readonly target: string }
  | {
      readonly kind: 'actual_time'
      readonly start: string
      readonly end: string
    }
  | { readonly kind: 'rating' }
  | { readonly kind: 'text' }
  | { readonly kind: 'checklist' }
  | { readonly kind: 'any_of' }

type GoalEvaluationSnapshotV1 = {
  readonly schemaVersion: 'planner.goal-evaluation-snapshot.v1'
  readonly measurement: EvaluationMeasurementV1
  readonly checkpoints: {
    readonly aggregation: 'independent' | 'all'
    readonly items: readonly [
      {
        readonly checkpointId: string
        readonly satisfaction: EvaluationCheckpointSatisfactionV1
      },
      ...{
        readonly checkpointId: string
        readonly satisfaction: EvaluationCheckpointSatisfactionV1
      }[],
    ]
  } | null
}

type GoalFactValueV1 =
  | { readonly kind: 'boolean'; readonly result: 'done' | 'not_done' }
  | { readonly kind: 'not_done' }
  | {
      readonly kind: 'quantity_add'
      readonly contributions: readonly [
        { readonly contributionId: string; readonly value: string },
        ...{ readonly contributionId: string; readonly value: string }[],
      ]
    }
  | { readonly kind: 'quantity_latest'; readonly value: string }
  | { readonly kind: 'actual_time'; readonly value: string }
  | { readonly kind: 'rating'; readonly value: number }
  | {
      readonly kind: 'text'
      readonly text: string
      readonly result: 'done' | 'not_done'
    }
  | {
      readonly kind: 'checklist'
      readonly items: readonly {
        readonly itemId: string
        readonly state: 'done' | 'not_done'
      }[]
    }
  | {
      readonly kind: 'any_of'
      readonly variants: readonly {
        readonly variantId: string
        readonly value: string
      }[]
    }

type GoalEvaluationFactV1 =
  | {
      readonly kind: 'fixed'
      readonly expectationDate: string
      readonly value: GoalFactValueV1
    }
  | {
      readonly kind: 'fixed_checkpoints'
      readonly expectationDate: string
      readonly checkpoints: readonly {
        readonly checkpointId: string
        readonly value: GoalFactValueV1
      }[]
    }
  | {
      readonly kind: 'quota_occurrence'
      readonly localDate: string
      readonly value: GoalFactValueV1
    }
  | {
      readonly kind: 'weekly_planned_task'
      readonly periodStart: string
      readonly periodEnd: string
      readonly result: 'done' | 'not_done'
    }

type SuccessfulEligibleCalendarResult = Extract<
  EligibleCalendarResult,
  { readonly eligible: true }
>

type EvaluateGoalProgressInput = {
  readonly snapshot: GoalEvaluationSnapshotV1
  readonly calendarInput: CalendarTargetsInput
  readonly calendar: SuccessfulEligibleCalendarResult
  readonly facts: readonly GoalEvaluationFactV1[]
  readonly asOfLocalDate: string
}

type ScoreCoverageContributionV1 = {
  readonly score: CanonicalExactRatio | null
  readonly coverage: {
    readonly filled: string
    readonly applicable: string
  }
}

type FlexiblePeriodEvaluationV1 = {
  readonly periodStart: string
  readonly periodEnd: string
  readonly periodTarget: string
  readonly actualEquivalentOccurrences: CanonicalExactRatio
  readonly creditedOccurrences: CanonicalExactRatio
  readonly overperformanceOccurrences: CanonicalExactRatio
}

type GoalProgressResult = {
  readonly formulaVersions: {
    readonly calendar: 'planner.calendar-targets.v1'
    readonly evaluation: 'planner.goal-evaluation.v1'
  }
  readonly progress: EvaluationMetric
  readonly score: EvaluationMetric
  readonly overperformance: EvaluationMetric
  readonly coverage: {
    readonly filled: string
    readonly applicable: string
  }
  readonly contribution: ScoreCoverageContributionV1
  readonly periods: readonly FlexiblePeriodEvaluationV1[]
}

type AggregateMetric =
  | {
      readonly available: true
      readonly exact: CanonicalExactRatio
      readonly basisPoints: string
    }
  | {
      readonly available: false
      readonly exact: null
      readonly basisPoints: null
      readonly reason: 'no_scored_goals' | 'no_fixed_units'
    }

type ScoreCoverageResult = {
  readonly formulaVersion: 'planner.score-coverage.v1'
  readonly monthScore: AggregateMetric
  readonly coverage: AggregateMetric
  readonly totals: {
    readonly scoredGoals: string
    readonly filled: string
    readonly applicable: string
  }
}

declare function evaluateGoalProgress(
  input: EvaluateGoalProgressInput,
): GoalProgressResult
declare function calculateScoreCoverage(input: {
  readonly contributions: readonly ScoreCoverageContributionV1[]
}): ScoreCoverageResult
```

Canonical ratio полностью сокращён независимо от размера принятого значения,
содержит nonnegative numerator и positive denominator без leading zeroes; zero
canonicalized как `0/1`. `basisPoints` — canonical
nonnegative integer string, где `100% = "10000"`, `83.33% = "8333"`, а
`130% = "13000"`. Exact rational сохраняется до последней границы метрики;
`round_half_up` вызывается один раз, поэтому среднее `1/2` и `1/6` даёт
`3333`, а не `3334`. Product decimals не проходят через binary float или
unbounded `BigInt(callerString)`. Отдельное decimal field не получает скрытый
length bound. Вместо approximation P05 применяет deterministic public
exact-work budget до дорогой allocation: не более `250000` canonical numeric
input digits, `10000` exact terms и `250000` projected output digits; одна
schoolbook multiplication допускает не более `25000000`, exact divmod — не
более `50000000` digit-work units. Equality/identity/linear normalization fast
paths учитываются до budgeted quadratic operation, поэтому один exact
`100000`-digit ratio остаётся допустим. Превышение возвращает typed value-free
`input_too_complex` на `/facts` либо `/contributions`; результат всегда exact
или rejected до materialization, никогда approximate и никогда wall-time
dependent. Raw canonical digit lengths начисляются до rational normalization;
один shared term ledger проверяет длины top-level и nested arrays до
`Set`/`Reflect.ownKeys`/descriptor traversal или `.map()`. Bounded string GCD и
полное сокращение используют тот же deterministic divmod budget: размер числа
никогда не переключает canonicalization в частичный режим.

Structural mismatch бросает `GoalEvaluationInputError` либо независимый
`ScoreCoverageInputError`. Их `issues` — frozen non-empty array exact
`{pointer, code, detail}`. Codes finite:
`invalid_type|invalid_value|unexpected_property|incompatible|input_too_complex`;
detail —
value-free literal union. Pointer принадлежит finite families `""`,
`/snapshot[/measurement|/checkpoints]`, `/calendarInput`, `/calendar`, `/facts`,
`/facts/{index}[/expectationDate|/localDate|/periodStart|/periodEnd|
/checkpointId|/value|/checkpoints]`, `/asOfLocalDate`, `/contributions` и
`/contributions/{index}[/score|/coverage]`. Exact shape отклоняет extras,
symbols, prototypes/accessors, sparse arrays, duplicate keys/IDs/dates,
measurement/calendar/component mismatch, facts вне P04 calendar либо позже
as-of. Measurement item/variant IDs и checkpoint IDs уникальны во всём
snapshot, не только внутри отдельных arrays. Ошибки, successful results и normal unavailable data detached и
recursively frozen.

As-of policy: fixed expectations становятся applicable при
`expectationDate <= asOfLocalDate`. Quota и weekly task period входит целиком
при `periodStart <= asOfLocalDate`; его сохранённый target не prorate-ится
повторно, но учитываются только eligible facts до as-of. Future period не
создаёт `no_data`. До первой applicable unit результат unavailable; после
месяца участвует весь месяц. Факт из будущего, за календарём или с неверной
period identity — incompatible input.

Fact projection является текущим effective state. `add` содержит
projection-wide unique opaque `contributionId/value` и суммируется exact;
`latest` содержит не более одного
актуального value и никогда не превращается в history sum. Decimal facts
canonical nonnegative и не превышают snapshot precision. Text non-whitespace,
rating safe integer внутри range, time canonical `HH:mm`, checklist/OR IDs
stable и unique. Actual-time endpoints inclusive; обычный range использует
`start <= value <= end`, overnight — `value >= start || value <= end`.

Fixed evaluation:

- Boolean: done ratio; missing/not-done — zero achievement.
- Targeted quantity: exact actual/target для каждой даты и exact mean дат;
  fixed progress uncapped. Informational quantity не имеет progress/score, но
  valid fixed measurement добавляет filled coverage unit. Informational quota
  не имеет ни score, ни coverage.
- Time засчитывается только внутри inclusive target; любое введённое valid
  время filled. Rating любой valid magnitude, включая minimum, satisfied и
  filled. Text filled только с nonempty text, achievement только `done`.
- Checklist: каждый обязательный item является progress и coverage unit;
  parent unit отсутствует. Any-of: maximum variant actual/target, не сумма;
  один parent coverage unit filled при измерении хотя бы одного variant либо
  explicit `not_done`.
- Non-flex score cap равен one, overperformance = raw progress − score.

Checkpoints возможны только в fixed projection. При `independent` raw parent
progress — exact mean child raw ratios, score — exact mean каждого child после
individual cap one; перевыполнение одного child не компенсирует другой.
Overperformance равен raw minus score. Для checklist child coverage units —
его items, для остальных — сам child на каждую дату. При `all` одна
parent-date unit satisfied только когда все children satisfied, а filled —
когда все children fully filled. Checklist child fully filled только при
state каждого item; any-of child filled при хотя бы одном измеренном variant
либо explicit not-done. Rating child satisfied любым valid value; quantity
при `actual >= target`, time внутри range, boolean/text при done, checklist при
всех items done, any-of при max ratio `>= 1`.

Flexible occurrence ratio всегда capped `[0,1]`. Для каждого entered period:
`actualEquivalent = sum(occurrenceRatio)`, `credited = min(actualEquivalent,
periodTarget)`, `over = actualEquivalent - credited`. Month progress делит
sum actual на sum targets, score — sum credited, overperformance — sum over.
Cap применяется отдельно к каждому period, поэтому surplus не закрывает debt
другой недели. Target-zero period не входит; zero total target означает
`no_applicable_units`. Quota не имеет coverage. Flexible rating occurrence
равен one при любом valid value. System daily `not_done` для quota не
синтезируется; валидный boolean/text `not_done` остаётся zero occurrence.

`weekly_planned_task` — одна scored week-level boolean unit, когда P04 period
entered. `done` даёт one, explicit `not_done` или отсутствие — zero. Этот тип
не создаёт fixed/day coverage units: его evaluation coverage всегда `0/0`.

Aggregate принимает только exact contributions одной уже разделённой секции.
Month score — equal-weight mean available capped goal scores; null score
исключается. Coverage — `sum(filled)/sum(applicable)`, а не mean goal
percentages. Zero denominators дают normal reasons `no_scored_goals` и
`no_fixed_units`. Outputs никогда не смешивают personal и shared сами.

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

### 11.3. P06 publication-preview boundary

P06 добавляет ровно один authenticated safe-read endpoint:
`GET /planning/drafts/publication-preview?targetMonth=YYYY-MM`. Controller
передаёт в exact `BuildPublicationPreviewQuery({ trustedUserId, targetMonth })`
только `CurrentPrincipal.userId` из проверенной session и сам не вызывает
workspace resolver; Origin и CSRF для GET не требуются. Query валидирует exact
input, вызывает `WorkspaceMemberResolver.resolveUser(trustedUserId)` ровно один
раз, читает `today('Asia/Yekaterinburg')` ровно один раз и получает весь editor
ровно одним существующим
`DraftGoalPersistencePort.findEditor` statement. P06 не вводит новый DB
read, schema, migration, transaction, write, command receipt или history.

Activation в preview выводится из exact target month и одной trusted
local date:

- current month: `mode: immediate`, `activeLocalDate: today`,
  `latePublication: day(today) > 1`;
- next month: `mode: scheduled`, `activeLocalDate: targetMonth-01`,
  `latePublication: false`;
- любой другой month: `mode: blocked`, `activeLocalDate: targetMonth-01`,
  `latePublication: false` и plan blocker `{ planGoalId: null,
  pointer: '/targetMonth', code: 'incompatible', detail: 'Target month is not
  current or next.' }`.

Оконные и calendar/config blockers возвращаются как `200` preview
data, а не как RFC Problem. Missing draft остаётся `404`, non-draft
`409`, malformed query `422`, authentication/authorization `401/403`,
dependency failure `503`. Empty goal list publishable и не порождает
искусственный blocker.

Для каждой цели projector сначала вызывает public
`validateGoalConfig`. Только refined `GoalConfigV1` проецируется в
`CalendarRepetitionV1`; `weekly_planned_task.taskText` остаётся display
metadata и не попадает в P04 input. `calculateEligibleCalendar` вызывается
ровно один раз на refined goal. Successful P04 result целиком становится
calculated target; ineligible result становится goal blocker и не создаёт
target. Invalid P03 config никогда не передаётся в P04. P06 не имеет facts,
поэтому не вызывает P05 `evaluateGoalProgress`/
`calculateScoreCoverage` и не синтезирует `no_data`, score или coverage.

Public response — exact recursively frozen detached
`planner.publication-preview.v1`: `planMonthId`, `spaceId`, `targetMonth`,
`status`, decimal-string `draftRevision`/`planMonthRevision`, activation,
focus, ordered full draft goals, calculated targets, aggregate blockers и
exact `formulaVersions` для calendar/evaluation/score-coverage. Owner остаётся
scope plus `ownerMemberId`; actor и profile names в preview отсутствуют.
Blockers сортируются: plan-level первым; затем goal-level по display order и
`planGoalId`; внутри одинаковой plan/goal позиции — по pointer, code и detail.
Это задаёт deterministic порядок и для нескольких blockers с обоими null
`planGoalId`. Они имеют finite P03/P04/window details и nullable `planGoalId`.

`previewHashVersion` равен `planner.publication-preview-hash.v1`.
`previewHash` — lowercase SHA-256 от `canonicalJsonStringify` всего exact
HTTP-like response, кроме самого `previewHash`: schema/hash versions, IDs,
string revisions, formula versions, activation, focus, ordered goals/config/
provenance, targets и blockers. Arrays и Unicode не нормализуются. Hash actor-
independent и возвращается даже при blockers. P07 внутри одной
transaction повторно строит exact projector после locked read, отклоняет
blockers и проверяет revision/hash/version; смена local date делает
старый preview stale.

После успешной projection P06 считает exact materialized row count: один
snapshot на goal, один flexible row на P04 period либо число fixed dates,
умноженное на locked число coverage components. Если сумма больше
`MAX_PUBLICATION_MATERIALIZED_ROWS = 10_000`, aggregate blockers получает один
стабильный `/goals` incompatible blocker до hash; per-goal blockers не
подменяются. Ровно `10_000` строк допустимы.

### 11.4. P07 atomic-publication boundary

`PublishMonth` принимает exact payload `{ planMonthId, previewSchemaVersion,
previewHashVersion, previewHash }`, command type
`planning.publish-month.v1`, mandatory positive draft `expectedRevision` и
возвращает только `DurableCommandResultRef<'planning.plan-publication.v1'>`.
Command ID и все IDs — canonical lowercase UUID; version соответствует
`^[a-z0-9][a-z0-9.-]{0,99}$`, hash — lowercase hex-64. Exact command snapshot
выполняется до первого `await`. Syntactically valid неизвестная version
доходит до transaction и становится `PUBLICATION_PREVIEW_CONFLICT`, а не
transport validation error.

Публичный frozen/detached `planner.published-snapshot.v1` содержит publication,
month/space/source revisions, confirmed preview schema и snapshot hash/version,
activation, copied focus, ordered goal snapshots с generated IDs/source
identities/metadata/config/provenance, ordered calculated targets с exact P04
calendars и все три formula versions. Все revisions снаружи — positive decimal
strings, даты — canonical local dates; Prisma rows, `bigint` и `Date` controller
не возвращает.

`GetPublishedSnapshotQuery({ trustedUserId, publicationId })` ровно один раз
разрешает пользователя и одним bounded snapshot read возвращает frozen
snapshot либо `null`; missing и foreign-space неразличимы.
`GetActiveMonthQuery({ trustedUserId })` ровно один раз разрешает пользователя,
один раз читает product local date и одним bounded read возвращает publication
только для current local month со status `published`, valid active pointer и
`activeLocalDate <= today`. Scheduled future, draft, grace, closed, absent и
будущая cancellation marker дают `null`; query ничего не активирует записью.

HTTP P07 фиксирован:

- authenticated session + Origin/CSRF `POST
  /planning/drafts/{planMonthId}/publish`, body ровно `{ commandId,
  expectedRevision, previewSchemaVersion, previewHashVersion, previewHash }`,
  success/replay `201` с string-serialized publication ref;
- session-only `GET /planning/publications/{publicationId}`;
- session-only `GET /planning/months/active`.

POST документирует `201,400,401,403,404,409,413,415,422,503`; GET endpoints —
`200,401,403,404,422,503`. Module-owned Problems:
`PUBLICATION_PREVIEW_CONFLICT` с current revision/schema/hash versions/hash и
`reload-publication-preview-and-retry`, `PLAN_PUBLICATION_BLOCKED` с exact
sorted P06 blockers, `PLAN_MONTH_ALREADY_PUBLISHED` с publication ID/revision и
`open-published-plan`, `PLAN_PUBLICATION_NOT_FOUND` и
`ACTIVE_PLAN_MONTH_NOT_FOUND`. Existing command/auth/draft/dependency problems
сохраняют precedence и shape.

PostgreSQL не реализует второй P04 calculator. Единственный semantic
`GoalConfigV1 -> EligibleCalendar` projector выполняется приложением после
month/draft lock и входит целиком в подтверждённый P06 hash. DB boundary
проверяет exact formula/schema versions, source config/revision/metadata,
calendar exact-key shape, target month/activation/time zone, соответствие
calendar family source repetition, month-bounded child dates, exact
calendar-to-materialized-child equality/completeness и связь с confirmed hash,
history, pointer и receipt. Согласованный malicious direct-SQL пакет с другими,
но type-correct P04 period targets лежит вне trusted application boundary;
дублировать calendar formulas в PL/pgSQL запрещено как divergent calculator.
Persistence materializes три child-набора set-based bounded inserts, а не
одним statement/await на строку. Deferred completeness запускается один раз от
publication header; immediate snapshot/child guards требуют, чтобы month всё
ещё был `draft` с `NULL` active pointer, поэтому append после publication
невозможен. Runtime transaction timeout остаётся `5_000 ms`; cap не служит
основанием его повышать.

### 11.5. P08 cancel/republish boundary

`CancelPublication` принимает exact payload `{ planMonthId, publicationId }`,
command type `planning.cancel-publication.v1`, mandatory positive lifecycle
`expectedRevision` и возвращает
`DurableCommandResultRef<'planning.plan-month.v1'>`. Missing и foreign
publication неразличимы. Finite conflicts различают stale lifecycle revision,
неактивную publication, начавшийся месяц и ненулевой `factsRevision`.

`RepublishMonth` принимает exact P07 publish payload и mandatory positive draft
revision, использует command type `planning.republish-month.v1` и result kind
`planning.plan-publication.v1`. Initial publish требует отсутствия publication
history; republish требует cancellation marker у latest revision. P08 migration
`20260811152000_cancel_republish` добавляет `facts_revision`, typed cancellation
history и deferred linkage month effect -> action -> change -> receipt. Старые
publication/snapshot/calendar rows остаются immutable и доступны по exact ID;
active query определяется только текущим month pointer.

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

### 15.2. P02 catalog HTTP contract

Authenticated surface:

```text
GET  /planning/catalog/goal-definitions?state=active|archived|all
GET  /planning/catalog/goal-definitions/{goalDefinitionId}
POST /planning/catalog/goal-definitions
POST /planning/catalog/goal-definitions/{goalDefinitionId}/versions
POST /planning/catalog/goal-definitions/{goalDefinitionId}/archive
POST /planning/catalog/goal-definitions/{goalDefinitionId}/restore
POST /planning/catalog/goal-definitions/{goalDefinitionId}/copy
```

GET list default — active; missing/foreign detail — 404. POST body принимает
canonical lowercase UUID `commandId`; CAS body принимает positive canonical
decimal-string `expectedRevision`. Application payload исключает envelope и
actor fields. Controller выводит actor только через public auth seam
`CurrentPrincipal.userId -> WorkspaceMemberResolver.resolveUser -> member`.
Create/version/copy возвращают 201, archive/restore — 200; response refs и view
bigints сериализуются losslessly. POST security conjunctive
`sessionCookie+csrfToken`, GET security — `sessionCookie`.

Global parser outcomes документируются как strict malformed/scalar JSON 400,
body above 1 MiB 413, unsupported media 415, field/extra-key validation 422.
Planning contribution добавляет finite codes
`PLANNING_AUTHORIZATION_DENIED` 403, `GOAL_DEFINITION_NOT_FOUND` 404,
`COMMAND_FINGERPRINT_CONFLICT` 409,
`GOAL_DEFINITION_REVISION_CONFLICT` 409 и
`GOAL_DEFINITION_STATE_CONFLICT` 409; dependency остаётся core 503. RFC 9457
body получает optional
`conflict: { currentRevision, currentState, nextAction:
'reload-goal-definition-and-retry' }` только для revision/state conflicts.
Fingerprint conflict не раскрывает prior fingerprint/payload. Validation
возвращает value-free `/body` или precise field pointer; unknown error остаётся
constant `INTERNAL_ERROR`.

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
- T01 Boolean/quantity replay, CAS, concurrent add/shared effect, failpoint
  rollback и direct-SQL effect constraints;
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
| `AC-03` | draft validation + preview unit/integration + atomic publish stale/blocker zero-write E2E |
| `AC-04`, `AC-05` | P04 formula fixtures + real-PG publication materialization/late-activation E2E |
| `AC-06…AC-08`, `AC-13…AC-21` | formula/type unit fixtures + typed persistence integration |
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

Версионированный контракт `planner.april-plan-seed.v1` живёт в
`planning/seed`, не обращается к БД и не запускает application commands. Он
содержит ровно 41 упорядоченную цель: 34 цели Участник Б, 4 цели Участник А и 3 shared.
Владельцы в исходных данных символические; `resolveAprilPlanSeed` принимает два
различных canonical member UUID, подставляет personal/shared scope, повторно
snapshot-ит конфигурацию и пропускает каждую цель через общий publish
validator. Результат и вложенные данные immutable. Стабильные component IDs
являются частью версии seed, а не генерируются при чтении.

`april-plan.provenance.json` независимо фиксирует для каждой цели source page,
нормализованный raw text, бумажный denominator и принятое решение. Сводки,
среднее настроение и мартовские даты отмечены отдельными non-goal entries.
Ручная сверка семи отрендеренных страниц и автоматический exact seed digest
зафиксированы в `docs/provenance/april-seed.md`. Создание draft, consumption
receipt и любая durable запись принадлежат P11; импорт P10 сам по себе не имеет
side effects.

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
