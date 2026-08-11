# Planner Backend Pilot Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use
> `superpowers:subagent-driven-development` (recommended) or
> `superpowers:executing-plans` to implement this plan task-by-task. Steps use
> checkbox (`- [ ]`) syntax for tracking.

**Goal:** построить backend пилота закрытого планировщика, в котором два
участника проходят месяц без бумаги через web и Telegram, а закрытый месяц
даёт воспроизводимый отчёт.

**Architecture:** модульный NestJS-монолит с PostgreSQL как источником истины,
отдельными runtime-ролями `api`, `planner-worker`, `migrator` и Redis только для
opaque web sessions и краткоживущей OIDC ceremony. Web и Telegram вызывают
одни application commands; бизнес-правила сосредоточены в product modules, а
не в channel adapters.

**Tech Stack:** Node.js 24, pnpm 11.15.1, TypeScript, NestJS, PostgreSQL,
Prisma, Redis, Jest, OpenAPI, Docker Compose, Telegram OIDC и Bot API.

## Global Constraints

- `TECHNICAL_DESIGN.md` — технический baseline; PRD определяет формулы и
  acceptance criteria.
- Planner и `nest-js-starter` — независимые Git-репозитории. Одна задача не
  меняет оба репозитория.
- Ожидаемый source Starter Core: clean `stage` at
  `a0c8e8002af59536dea3c8209fe527bd033b2eca`. Если revision изменилась, задача
  останавливается до повторного аудита и обновления provenance.
- Node major — `24`; pnpm — `11.15.1`; зависимости фиксируются exact versions.
- Один task ID — один observable outcome, максимум одна основная migration и
  один Conventional Commit.
- Schema, OpenAPI, focused tests и документация входят в behavior task, который
  нуждается в них; они не становятся отдельными «техническими» задачами.
- Каждый behavior task проходит focused RED → GREEN. В конце milestone
  запускается `pnpm check:quick`; на финальном backend HEAD — `pnpm check`.
- PostgreSQL хранит product state, schedules, receipts, history и reports.
  BullMQ, queue Redis и transactional outbox не подключаются.
- Actor выводится из trusted channel context. Payload не принимает `actorId`.
- Все business dates используют `Asia/Yekaterinburg`; instants хранятся UTC.
  Tests используют fake clock и не читают реальный `now()`.
- Published snapshots и closed report revisions append-only и immutable.
- Telegram delivery не обещает exactly-once; ambiguous attempt не повторяется.
- Pilot не включает completed-v1 wizard, advanced analytics, correlations,
  free-text AI, публичную регистрацию и несколько пространств.
- Извлечение reusable mechanics обратно в Starter выполняется только отдельной
  задачей после Planner runtime evidence.

---

## 1. Как читать план: вертикали, epics и tasks

Вертикальная последовательность задаёт порядок появления работающих
возможностей. Epic группирует связанные задачи и может стать milestone или PR.
Epic не является единицей исполнения.

Task — минимальная единица работы ИИ-агента:

- один основной transaction boundary или один edge/read-model slice;
- focused tests и проверяемый пользовательский либо runtime outcome;
- отдельный commit;
- соседнюю задачу можно независимо отклонить, не откатывая эту.

Если во время preflight задача требует второй aggregate transaction и второй
channel adapter, агент фиксирует `SCOPE CONFLICT` и делит задачу до изменения
кода. Нельзя «заодно» реализовать весь epic.

```text
M0 Foundation
  → M1 Identity/workspace
  → M2 Planning/progress
  → M3 Tracking/worker
  → M4 Telegram/reminders/reporting
  → pilot acceptance
  → deployment gate
```

## 2. Git и execution protocol

1. Перед task: прочитать `AGENTS.md`, затронутые требования и task card.
2. Проверить branch, HEAD, upstream и dirty state.
3. Зафиксировать exact accepted predecessor HEAD. Создать branch
   `agent/<task-id>-<short-name>` именно от этого `main`.
4. Написать focused failing test или executable contract assertion.
5. Доказать RED ожидаемой причиной.
6. Реализовать только task scope.
7. Доказать GREEN narrow gate, затем указанный task gate.
8. Запустить независимый review task и одну consolidated fix wave при наличии
   замечаний.
9. Сделать один Conventional Commit, указанный в task card.
10. Coordinator переключается на `main`, проверяет, что HEAD всё ещё равен
    accepted predecessor, и выполняет `git merge --ff-only agent/<task>`.
11. Следующая задача стартует только от нового accepted `main`; rejected branch
    не интегрируется.
12. Не push/deploy и не создавать PR без отдельного publish шага.

Для каждого milestone последний task запускает `pnpm check:quick`. Полный
`pnpm check`, Docker smoke, hosted smoke и restore evidence не смешиваются:
каждый доказывает свою границу.

## 3. Locked public interface ledger

Имена ниже являются связующим контрактом задач. Их изменение требует правки
этого плана и зависимых task cards до реализации.

```ts
export type UserId = string;
export type SpaceId = string;
export type MemberId = string;
export type PlanMonthId = string;
export type PublicationId = string;
export type PlanGoalId = string;

export type ActorRef =
  | { kind: "member"; id: MemberId }
  | { kind: "system"; id: "planner-worker" };

export type ApplicationCommand<TPayload> = {
  commandId: string;
  trustedActor: ActorRef;
  expectedRevision?: bigint;
  payload: TPayload;
};

export type CommandType = string;

export interface CommandExecutor {
  execute<TPayload, TResult>(
    commandType: CommandType,
    command: ApplicationCommand<TPayload>,
    effect: () => Promise<TResult>,
  ): Promise<TResult>;
}

export type MemberContext = {
  spaceId: SpaceId;
  memberId: MemberId;
  userId: UserId;
};

export interface WorkspaceMemberResolver {
  resolveUser(userId: UserId): Promise<MemberContext>;
  resolveTelegramId(telegramId: bigint): Promise<MemberContext>;
}

export type ProductClock = {
  now(): Date;
  today(timeZone: "Asia/Yekaterinburg"): string;
};
```

External JSON представляет `bigint` как lossless decimal string. Internal
TypeScript и PostgreSQL используют соответственно `bigint` и `BIGINT`.
Adapters получают actor из verified channel context и только затем создают
`ApplicationCommand`; untrusted payload никогда не содержит `trustedActor`.
Receipt scope равен `(actorScope, commandType, commandId)`, где actorScope
детерминированно выводится из `trustedActor`. Canonical fingerprint покрывает
`commandType`, `expectedRevision` и payload; receipt хранит result reference,
aggregate revision and completion time. Replay lookup выполняется до permission
check and CAS.

---

## M0. Repository baseline и bounded Starter Core transfer

### B00 — Independent repository baseline

**Outcome:** самостоятельный Planner repository содержит утверждённые
спецификации, source DOCX, инструкции агента и этот task plan; временный Word
lock-файл исключён.

**Files:**

- Create: `.gitignore`
- Create: `AGENTS.md`
- Create: `README.md`
- Create: `IMPLEMENTATION_PLAN.md`
- Track: `PRD.md`, `USER_FLOWS.md`, `SCREEN_MAP.md`, `TECHNICAL_DESIGN.md`
- Track: `monthly-plan-template`

**Interfaces:** нет runtime interfaces; этот task создаёт Git и documentation
baseline для всех следующих задач.

- [x] Инициализировать `main` без общей истории со Starter.
- [x] Исключить `.DS_Store` и `~$*.docx`, не исключая source DOCX.
- [x] Проверить Markdown links, отсутствие старых auth-code требований и
  совпадение AC-наборов PRD/User Flows.
- [x] Создать первый commit `docs: establish planner specification baseline`.
- [x] Убедиться, что `git status --short` пуст после commit.

**Gate:** все Markdown fences сбалансированы; `AC-01…AC-24`, `AC-01b` и
`AC-SM-01` совпадают между PRD и User Flows.

### B01 — Private GitHub remote

**Outcome:** local `main` имеет private GitHub backup и tracking remote. Это
repository operation, а не product implementation.

**Protocol exception:** B01 выполняется только на clean `main`, без task branch.
Это явно разрешённый repository publish step; он не применяет обычный task
branch/fast-forward protocol.

**Files:** Git metadata only.

- [x] Убедиться, что host-capable `gh auth status` успешен для
  `DenisChernykh`.
- [x] Повторно проверить отсутствие `DenisChernykh/planner`.
- [ ] На clean `main` выполнить:

```bash
gh repo create DenisChernykh/planner --private --source=. --remote=origin --push
```

- [ ] Проверить `main...origin/main`, `git status -sb` и GitHub visibility
  `PRIVATE`.

### S01 — Starter toolchain transfer

**Depends on:** B01.

**Outcome:** installable empty backend skeleton использует проверенный
toolchain Starter, но ещё не содержит runtime и product modules.

**Files:**

- Create: `.nvmrc`, `package.json`, `pnpm-lock.yaml`, `pnpm-workspace.yaml`
- Create: `tsconfig.json`, `tsconfig.build.json`, `tsconfig.test.json`
- Create: `jest.unit.config.mjs`, `jest.integration.config.mjs`,
  `jest.e2e.config.mjs`
- Create: `eslint.config.mjs`, `.prettierrc.json`, `.prettierignore`
- Create: `.dependency-cruiser.cjs`, `nest-cli.json`, `prisma.config.ts`
- Create: `docs/provenance/starter-core.md`
- Test: `test/unit/toolchain/planner-skeleton.spec.ts`

**Source allowlist:** root toolchain/config files only from exact Starter SHA.
Runtime source, product modules, approval requests, password/email code,
BullMQ/outbox and generated files are excluded.

- [ ] Записать source repo, branch, full SHA, clean state, exact source/target
  paths, Planner build/test consumers, toolchain drift/install failure model,
  adaptations and intentional exclusions в provenance.
- [ ] Механически перенести только allowlisted toolchain files, адаптировать
  package metadata/scripts and exact dependencies, затем в host-capable
  environment проверить `node --version`, `pnpm --version` and run
  `pnpm install`. Это bootstrap exception: до него Jest command не существует.
- [ ] Добавить failing skeleton test, импортирующий отсутствующий
  `src/app-metadata.ts` и ожидающий `{ name: "planner", nodeMajor: 24 }`.
- [ ] Запустить `pnpm test:unit:run -- test/unit/toolchain/planner-skeleton.spec.ts`
  и получить RED именно из-за отсутствующего module.
- [ ] Создать `src/app-metadata.ts`, получить GREEN, затем запустить format and
  typecheck.
- [ ] Commit: `chore: transfer planner toolchain foundation`.

### S02 — Universal runtime Core transfer

**Depends on:** S01.

**Outcome:** пустой API и migrator поднимаются с PostgreSQL; работают liveness,
readiness и bounded shutdown. HTTP contracts и observability добавляются
следующей задачей, чтобы transfer не превратился в один большой diff.

**Files:**

- Create: `src/platform/config/**`, `src/platform/database/**`
- Create: `src/platform/http/bootstrap/**`, `src/platform/http/health/**`
- Create: `src/platform/lifecycle/**`
- Create: `src/shared/**`
- Create: `src/bootstrap/api/**`, `src/bootstrap/migrator/**`
- Create: `prisma/schema.prisma`
- Create: `prisma/migrations/20260811090000_planner_foundation/migration.sql`
- Create: `Dockerfile`, `docker-compose.yml`
- Modify: `docs/provenance/starter-core.md`
- Test: `test/integration/platform/foundation-runtime.integration.spec.ts`
- Test: `test/e2e/health/foundation-health.e2e-spec.ts`

**Interfaces:** produces `DatabaseTransactionPort`, health contributors and API
lifecycle used by every product module. Problem registry появляется в S03.

- [ ] Написать integration test: migrator создаёт schema, runtime role может
  выполнять DML, но не migrations; API readiness зависит от PostgreSQL.
- [ ] Доказать RED на пустом skeleton.
- [ ] Перенести только database/lifecycle/health paths и заменить Starter
  product composition минимальным Planner `ApiModule`.
- [ ] Append provenance: exact source SHA/paths, target paths, API/migrator
  consumers, database/lifecycle failure model, adaptations and exclusions.
- [ ] Исключить queue/outbox runtime, queue Redis и demo modules из Compose и
  dependencies.
- [ ] Проверить migration на fresh database, health E2E и graceful shutdown.
- [ ] Commit: `chore: transfer universal backend runtime`.

### S03 — HTTP contracts, observability and test clock

**Depends on:** S02.

**Outcome:** минимальный runtime получает RFC 9457 errors, request validation,
OpenAPI drift, safe logging/trace propagation и injectable fake clock без
product modules.

**Files:**

- Create: `src/platform/http/context/**`, `src/platform/http/docs/**`
- Create: `src/platform/http/errors/**`, `src/platform/http/policy/**`
- Create: `src/platform/logging/**`, `src/platform/observability/**`
- Create: `src/shared/application/product-clock.ts`
- Modify: `docs/provenance/starter-core.md`
- Test: `test/unit/platform/problem-details.spec.ts`
- Test: `test/e2e/platform/http-contracts.e2e-spec.ts`

**Produces:** HTTP problem registry, OpenAPI document builder, safe logger and
`ProductClock` adapter used by every temporal product test.

- [ ] Написать RED cases validation Problem Details, correlation ID, PII-safe
  serialization and fake-clock date in `Asia/Yekaterinburg`.
- [ ] Перенести selected HTTP/logging/observability paths and create system/
  fake `ProductClock` implementations.
- [ ] Append exact source/target paths, consumers, HTTP/telemetry failure model,
  adaptations and exclusions to provenance.
- [ ] Проверить bounded body/time limits, OpenAPI generation/drift and absence
  of raw secrets/IDs in captured logs.
- [ ] Запустить unit/E2E, architecture check and `pnpm check:quick`.
- [ ] Commit: `chore: transfer backend contract boundaries`.

### S04 — Local User and opaque session subset

**Depends on:** S03.

**Outcome:** pre-provisioned local User получает opaque browser session;
protected endpoint, revoke, CSRF/Origin и Redis-loss fail-closed работают без
password/email vertical.

**Files:**

- Create: `src/modules/auth/application/**`
- Create: `src/modules/auth/domain/**`
- Create: `src/modules/auth/infrastructure/redis-session.store.ts`
- Create: `src/modules/auth/presentation/**`
- Create: `src/modules/auth/composition/auth.module.ts`
- Modify: `docs/provenance/starter-core.md`
- Modify: `prisma/schema.prisma`
- Create: `prisma/migrations/20260811100000_local_user_session/migration.sql`
- Test: `test/integration/auth/opaque-session.integration.spec.ts`
- Test: `test/e2e/auth/protected-session.e2e-spec.ts`

**Produces:** `AuthenticatedPrincipal { userId: UserId; sessionId: string }`,
authentication guard and session issuer/revoker. Password, email, public signup
and approval-request code are absent.

- [ ] Написать RED tests для session issue/authenticate/revoke, CSRF/Origin и
  Redis unavailable.
- [ ] Перенести minimal User/session subset и адаптировать composition без
  password/email dependencies.
- [ ] Append exact source/target paths, session consumer, Redis-loss/security
  failure model, adaptations and exclusions to provenance.
- [ ] Проверить, что unknown/revoked session возвращает RFC 9457 response и не
  создаёт User.
- [ ] Запустить auth integration, HTTP E2E и `pnpm check:quick`.
- [ ] Commit: `feat: add local user session foundation`.

---

## M1. Telegram identity и pair workspace

### A01 — Pair workspace and provisioning

**Depends on:** S04.

**Outcome:** БД содержит одно закрытое пространство, ровно двух равноправных
members и pre-provisioned Telegram allowlist; третий участник и JIT signup
невозможны.

**Files:**

- Create: `src/modules/workspace/**`
- Create: `src/bootstrap/provision-pair/**`
- Modify: `prisma/schema.prisma`
- Create: `prisma/migrations/20260811110000_pair_workspace/migration.sql`
- Test: `test/integration/workspace/pair-provisioning.integration.spec.ts`

**Produces:** `WorkspaceMemberResolver` из interface ledger; оба member видят
весь plan, personal mutation отдельно проверяет owner.

- [ ] Написать RED constraints tests: duplicate Telegram ID, third membership,
  unknown ID и повтор provisioning с другим payload.
- [ ] Реализовать `space`, `membership`, `telegram_access_allowlist` и
  idempotent operator provisioning command.
- [ ] Проверить numeric Telegram ID как PostgreSQL `BIGINT`, TypeScript `bigint`
  и decimal string на CLI/JSON boundary.
- [ ] Запустить fresh/upgrade migration integration и `pnpm check:quick`.
- [ ] Commit: `feat: add closed pair workspace`.

### A02 — Telegram OIDC ceremony start

**Depends on:** A01.

**Outcome:** login start создаёт one-time server-side state/nonce/PKCE
transaction, redirects only to verified Telegram authorization endpoint and
never requests phone.

**Files:**

- Create: `src/modules/auth/application/start-telegram-oidc-login.use-case.ts`
- Create: `src/modules/auth/application/telegram-oidc.ports.ts`
- Create: `src/modules/auth/infrastructure/redis-oidc-transaction.store.ts`
- Create: `src/modules/auth/infrastructure/telegram-oidc.provider.ts`
- Create: `src/modules/auth/presentation/telegram-oidc.controller.ts`
- Test: `test/contract/auth/telegram-oidc.contract.spec.ts`

**Produces:** `OidcTransactionStore` and `TelegramOidcProvider` consumed by A03.

- [ ] Написать RED contract cases for discovery/authorization endpoint, state,
  nonce, PKCE S256, TTL, exact scopes and provider outage.
- [ ] Реализовать one-time Redis transaction with TTL and atomic consume port.
- [ ] Проверить scopes `openid profile telegram:bot_access`, отсутствие `phone`
  and safe redirect allowlist.
- [ ] Запустить contract/OpenAPI drift and `pnpm check:quick`.
- [ ] Commit: `feat: start Telegram OIDC ceremony`.

### A03 — Telegram OIDC callback and identity binding

**Depends on:** A02.

**Outcome:** allowlisted participant completes verified callback and receives
local session; replay, invalid claims and identity collision fail closed.

**Files:**

- Create: `src/modules/auth/application/complete-telegram-oidc-login.use-case.ts`
- Modify: `src/modules/auth/infrastructure/telegram-oidc.provider.ts`
- Modify: `src/modules/auth/presentation/telegram-oidc.controller.ts`
- Modify: `prisma/schema.prisma`
- Create: `prisma/migrations/20260811120000_telegram_external_identity/migration.sql`
- Test: `test/e2e/auth/telegram-oidc.e2e-spec.ts`

**Produces:** unique `(issuer, subject)` plus numeric Telegram ID mapping to one
local User; uses S04 session issuer.

- [ ] Написать fake issuer/JWKS RED matrix success, cancel, consumed/replayed
  state, nonce/PKCE/signature/iss/aud/exp failure, outage, unknown ID and
  binding collision.
- [ ] Реализовать token exchange/JWKS validation, one-time consume and
  allowlist-to-local-user binding.
- [ ] Не использовать username/email for linking; negative cases create no
  User/external identity/session.
- [ ] Запустить E2E, migration integration, OpenAPI drift and `pnpm check:quick`.
- [ ] Commit: `feat: complete allowlisted Telegram OIDC login`.

---

## M2. Planning и deterministic progress

### P01 — Draft kernel and first durable command

**Depends on:** A01.

**Outcome:** `CreateEmptyDraft` и `UpdateMonthFocus` атомарно используют
actor-scoped receipt, fingerprint, receipt-before-CAS и finite action history.

**Files:**

- Create: `src/shared/application/application-command.ts`
- Create: `src/shared/application/command-receipt.port.ts`
- Create: `src/modules/planning/**`
- Modify: `prisma/schema.prisma`
- Create: `prisma/migrations/20260811130000_plan_draft_kernel/migration.sql`
- Test: `test/integration/planning/draft-command.integration.spec.ts`

**Produces:** locked `CommandExecutor`, `GetDraftQuery`, month revision and
shared receipt contract later adopted by tracking.

- [ ] Написать RED tests для first execution, exact replay, same-key/different-
  payload conflict, stale revision и concurrent same-month creation.
- [ ] Реализовать unique `(actorScope, commandType, commandId)`, canonical
  fingerprint and receipt lookup before permissions/CAS; effect, action history
  and completed result reference фиксировать одной transaction.
- [ ] Проверить system actor отдельно from member; adapters inject trustedActor,
  while untrusted HTTP/Telegram DTO contains no actor field.
- [ ] Запустить planning integration и `pnpm check:quick`.
- [ ] Commit: `feat: add idempotent plan draft kernel`.

### P02 — Catalog, versions and analytical series

**Depends on:** P01.

**Outcome:** reusable goal definitions имеют version/archive, analytical series
и explicit continuity decision. Typed goal editor добавляется отдельно в P03.

**Files:**

- Create: `src/modules/planning/application/catalog.commands.ts`
- Create: `src/modules/planning/presentation/planning.controller.ts`
- Modify: `prisma/schema.prisma`
- Create: `prisma/migrations/20260811140000_goal_catalog/migration.sql`
- Test: `test/integration/planning/catalog-draft.integration.spec.ts`

**Produces:** catalog definition/version identity, archive semantics and
`SeriesDecision = continue | new` consumed by P03.

- [ ] Написать RED cases create/version/archive/restore, same-name versions,
  series continuation and forced new series for semantic identity changes.
- [ ] Реализовать catalog repository/commands and finite action history через
  P01 command contract.
- [ ] Проверить archive без physical delete и immutable historical links.
- [ ] Запустить focused integration and OpenAPI drift.
- [ ] Commit: `feat: add versioned goal catalog`.

### P03 — Typed draft goals and publish validation

**Depends on:** P02.

**Outcome:** все discriminated goal configurations редактируются в draft,
имеют stable child IDs and exact publish-validation.

**Files:**

- Create: `src/modules/planning/domain/goal-config.ts`
- Create: `src/modules/planning/domain/goal-validation.ts`
- Create: `src/modules/planning/application/draft-goal.commands.ts`
- Modify: `src/modules/planning/presentation/planning.controller.ts`
- Test: `test/unit/planning/goal-validation.spec.ts`
- Test: `test/integration/planning/draft-goal.integration.spec.ts`

**Produces:** versioned `GoalConfig`, `sourceProvenance` and stable IDs for
checkpoints/items/OR variants; P04/P05 evaluate these exact types.

- [ ] Написать RED table tests всех types, frequencies, exact N, scope/owner,
  units, add/latest, checkpoints, checklist and OR.
- [ ] Реализовать add/copy/update/reorder draft goal commands with explicit
  series decision from P02.
- [ ] Добавить RFC 9457 validation errors and OpenAPI discriminators.
- [ ] Запустить unit/integration/OpenAPI drift and `pnpm check:quick`.
- [ ] Commit: `feat: add typed monthly goal drafts`.

### P04 — Calendar targets and period pace

**Depends on:** P03.

**Outcome:** framework-free `progress` вычисляет calendar eligibility, exact
period targets, proration and expected pace только из explicit inputs.

**Files:**

- Create: `src/modules/progress/calendar-targets.ts`
- Create: `src/modules/progress/index.ts`
- Test: `test/unit/progress/calendar-targets.spec.ts`

**Produces:** `calculatePeriodTarget`, `calculateExpectedPace` and eligible
calendar periods; no Nest, Prisma, HTTP or clock imports.

- [ ] Написать RED fixtures round_half_up, Monday-Sunday month-bounded weeks,
  late month, selected weekdays, one-off deadline and no debt carry.
- [ ] Реализовать minimal calendar/pacing functions with decimal-safe math.
- [ ] Доказать `3/week` with 5 active days = 2, with 3 days = 1 и
  late monthly target proportion.
- [ ] Запустить calendar unit tests and architecture check.
- [ ] Commit: `feat: calculate planner period targets`.

### P05 — Goal evaluators, score and coverage

**Depends on:** P03, P04.

**Outcome:** pure evaluators calculate fixed/flexible progress, score, coverage
and overperformance for every pilot goal type.

**Files:**

- Create: `src/modules/progress/goal-evaluators.ts`
- Create: `src/modules/progress/score-coverage.ts`
- Modify: `src/modules/progress/index.ts`
- Test: `test/unit/progress/goal-evaluators.spec.ts`
- Test: `test/unit/progress/score-coverage.spec.ts`

**Produces:** `evaluateGoalProgress` and `calculateScoreCoverage`; consumers
pass snapshot/facts/calendar/asOf explicitly.

- [ ] Написать RED fixtures Boolean, add/latest, cross-midnight time, rating,
  text, checklist, checkpoints, OR max, coverage, cap and overperformance.
- [ ] Реализовать evaluators without persistence or system clock imports.
- [ ] Доказать `100/50/130 → 83.33%`, separate overperformance and
  `not_applicable` exclusion.
- [ ] Запустить evaluator/score tests and architecture check.
- [ ] Commit: `feat: evaluate planner goal progress`.

### P06 — Publication preview

**Depends on:** P03, P04, P05.

**Outcome:** web получает revision-bound preview focus, owners, goal types,
frequencies, checkpoints/schedules, calculated period targets and blocking
validation errors before confirmation.

**Files:**

- Create: `src/modules/planning/application/build-publication-preview.query.ts`
- Modify: `src/modules/planning/presentation/planning.controller.ts`
- Test: `test/e2e/planning/publication-preview.e2e-spec.ts`

**Produces:** `PublicationPreview { draftRevision, previewHash, blockers,
calculatedTargets }`; P07 confirms exact revision/hash and recomputes validation.

- [ ] Написать RED E2E valid/invalid draft cases with focus, owners, exact N,
  checkpoints and prorated targets.
- [ ] Реализовать bounded preview query using P04/P05 without persistence
  mutation.
- [ ] Добавить OpenAPI contract and explicit blocking problem states.
- [ ] Запустить E2E/OpenAPI drift and `pnpm check:quick`.
- [ ] Commit: `feat: preview monthly plan publication`.

### P07 — Atomic publish and activation

**Depends on:** P06.

**Outcome:** confirmed preview одной transaction создаёт immutable publication,
focus/hash, goal snapshots, fixed expectations and flexible periods; late
publish prorates.

**Files:**

- Create: `src/modules/planning/application/publish-month.command.ts`
- Create: `src/modules/planning/domain/publication-builder.ts`
- Modify: `prisma/schema.prisma`
- Create: `prisma/migrations/20260811150000_plan_publication/migration.sql`
- Test: `test/integration/planning/publish-month.integration.spec.ts`
- Test: `test/e2e/planning/publish-month.e2e-spec.ts`

**Produces:** `GetPublishedSnapshotQuery`, `GetActiveMonthQuery` and immutable
publication revision referenced by facts/reports.

- [ ] Написать RED tests rollback on any generation error, stale preview,
  future/current activation, late dates and duplicate replay.
- [ ] Revalidate draftRevision/previewHash then materialize with P04 targets and
  system-derived `not_applicable` before `activeLocalDate`.
- [ ] Проверить one active publication per space/month and append-only snapshot.
- [ ] Запустить migration integration, publish E2E, OpenAPI and
  `pnpm check:quick`.
- [ ] Commit: `feat: publish immutable monthly plans`.

### P08 — Cancel and republish publication

**Depends on:** P07.

**Outcome:** cancel is allowed only before month start with no facts; republish
creates a new append-only publication revision and expectations.

**Files:**

- Create: `src/modules/planning/application/cancel-publication.command.ts`
- Create: `src/modules/planning/application/republish-month.command.ts`
- Test: `test/integration/planning/cancel-republish.integration.spec.ts`

- [ ] Написать RED cases started month, existing facts, replay, stale revision
  and republish failure rollback.
- [ ] Реализовать cancel active pointer without changing/deleting snapshots.
- [ ] Реализовать republish through the same P07 builder with next revision.
- [ ] Запустить focused integration and `pnpm check:quick`.
- [ ] Commit: `feat: cancel and republish future plans`.

### P09 — Copy month without facts

**Depends on:** P07.

**Outcome:** `CreateDraftFromPublication` copies focus/config/series/order/
provenance/weekly task text, but no facts, statuses, notes, reports,
notifications or progress.

**Files:**

- Create: `src/modules/planning/application/create-draft-from-publication.command.ts`
- Test: `test/integration/planning/copy-month.integration.spec.ts`
- Test: `test/e2e/planning/copy-month.e2e-spec.ts`

**Produces:** editable destination draft with unique space/month identity;
source publication remains byte-for-byte immutable.

- [ ] Написать RED fixture with records, corrections, weekly tasks and report
  refs.
- [ ] Реализовать idempotent atomic copy and destination conflict response.
- [ ] Сравнить source hash before/after and prove copied facts absent.
- [ ] Запустить focused integration/E2E.
- [ ] Commit: `feat: copy published month into clean draft`.

### P10 — Versioned April seed

**Depends on:** P03, P04, P05.

**Outcome:** seed data полностью покрывает source DOCX and passes generic
publish-validation without creating a draft or automatic publication.

**Files:**

- Create: `src/modules/planning/seed/april-plan.seed.ts`
- Create: `src/modules/planning/seed/april-plan.provenance.json`
- Test: `test/unit/planning/april-seed.spec.ts`

**Produces:** prefilled focus; meditation monthly Boolean N=16; exact N=2 for
both former ranges; all-channel checklists; collaborations `add` target 7;
shared important task; MemberB outreach; calendar-derived denominators.

- [ ] Написать RED assertions on every resolved source decision and provenance
  page/raw denominator.
- [ ] Реализовать versioned seed as data, not domain constants.
- [ ] Доказать generic validation and no 30–31 March expectations in seed
  materialization preview.
- [ ] Выполнить manual provenance checklist AC-SM-01 and save evidence note.
- [ ] Commit: `feat: add resolved April plan seed`.

### P11 — Create draft from April seed

**Depends on:** P01, P10.

**Outcome:** UF-02 template selection atomically creates a fully populated
editable draft once; replay is stable and existing draft/consumed seed conflicts
are explicit.

**Files:**

- Create: `src/modules/planning/application/create-draft-from-seed.command.ts`
- Modify: `src/modules/planning/presentation/planning.controller.ts`
- Modify: `prisma/schema.prisma`
- Create: `prisma/migrations/20260811155000_seed_consumption/migration.sql`
- Test: `test/integration/planning/create-draft-from-seed.integration.spec.ts`
- Test: `test/e2e/planning/create-draft-from-seed.e2e-spec.ts`

- [ ] Написать RED cases first selection, exact replay, existing destination
  draft, already-consumed seed and same-key/different-payload.
- [ ] Реализовать seed consumption, draft/focus/goals/order/provenance in one
  transaction using P01/P03 contracts.
- [ ] Add HTTP/OpenAPI selection route and verify no automatic publish.
- [ ] Запустить migration integration/E2E and `pnpm check:quick`.
- [ ] Commit: `feat: create April draft from seed`.

---

## M3. Tracking и первый product worker

### T01 — Record kernel: Boolean and quantity

**Depends on:** P04, P05, P07.

**Outcome:** Boolean и quantity add/latest используют typed records,
append-only revisions/tombstones, tracking receipts, action groups и CAS.

**Files:**

- Create: `src/modules/tracking/**`
- Modify: `prisma/schema.prisma`
- Create: `prisma/migrations/20260811160000_tracking_record_kernel/migration.sql`
- Test: `test/integration/tracking/boolean-quantity.integration.spec.ts`
- Test: `test/e2e/tracking/record-command.e2e-spec.ts`

**Produces:** `RecordFactCommand`, `GetFactStateQuery`; reuses P01 command
contract without importing planning internals.

- [ ] Написать RED cases: water 400+800, steps 2000→7000, Boolean replay,
  concurrent add, same-key/different-payload и shared single effect.
- [ ] Реализовать contribution identity for add и single logical value with
  revisions for latest/Boolean.
- [ ] Сохранять effect, receipt and action history атомарно.
- [ ] Запустить integration/E2E и `pnpm check:quick`.
- [ ] Commit: `feat: record boolean and quantity facts`.

### T02 — Time, rating and checkpoints

**Depends on:** T01.

**Outcome:** actual time привязан к explicit expectation date; rating является
measurement; named checkpoints имеют independent facts and one parent score.

**Files:**

- Create: `src/modules/tracking/application/record-time.command.ts`
- Create: `src/modules/tracking/application/record-rating.command.ts`
- Create: `src/modules/tracking/application/record-checkpoint.command.ts`
- Test: `test/integration/tracking/time-rating-checkpoint.integration.spec.ts`

- [ ] Написать RED cases cross-midnight range, prior expectation date, rating
  min/max и incomplete/all checkpoints.
- [ ] Реализовать typed values/revisions and P05 evaluator wiring.
- [ ] Доказать, что low rating не failure, а checkpoint completion влияет на
  coverage/score.
- [ ] Запустить focused integration и `pnpm check:quick`.
- [ ] Commit: `feat: record time rating and checkpoints`.

### T03 — Text and checklist facts

**Depends on:** T01, T02.

**Outcome:** text+result and checklist item revisions сохраняются типизированно;
каждый required checklist item является coverage unit без extra parent unit.

**Files:**

- Create: `src/modules/tracking/application/record-text.command.ts`
- Create: `src/modules/tracking/application/record-checklist-item.command.ts`
- Test: `test/integration/tracking/text-checklist.integration.spec.ts`

- [ ] Написать RED cases non-empty text+result, done/not_done correction,
  checklist partial completion and required-item coverage units.
- [ ] Реализовать stable component references and typed revisions.
- [ ] Проверить parent without extra expectation/coverage unit.
- [ ] Запустить focused integration и `pnpm check:quick`.
- [ ] Commit: `feat: record text and checklist facts`.

### T04 — OR, informational and flexible composite facts

**Depends on:** T01, T02.

**Outcome:** OR variants, informational quantity and flexible composite
occurrences сохраняют independent components and deterministic per-date facts.

**Files:**

- Create: `src/modules/tracking/application/record-or-variant.command.ts`
- Create: `src/modules/tracking/application/record-composite-occurrence.command.ts`
- Test: `test/integration/tracking/or-composite.integration.spec.ts`

- [ ] Написать RED cases OR max without sum, partial variant, informational no
  target/score/reminder and per-date composite components.
- [ ] Реализовать stable variant references, typed revisions and composite
  occurrence identity bounded by publication/date.
- [ ] Проверить max normalized fraction and recalculation after correction.
- [ ] Запустить focused integration and `pnpm check:quick`.
- [ ] Commit: `feat: record flexible composite facts`.

### T05 — Corrections and tombstones

**Depends on:** T03, T04.

**Outcome:** correction/delete/tombstone preserve original recorder, last
editor, reason and history; personal/shared mutation rights are enforced.

**Files:**

- Create: `src/modules/tracking/application/correct-record.command.ts`
- Create: `src/modules/tracking/application/delete-record.command.ts`
- Test: `test/integration/tracking/correction-delete.integration.spec.ts`

- [ ] Написать RED authorization/history/CAS cases for owner personal mutation,
  shared correction reason and partner personal denial.
- [ ] Реализовать correction/delete as new revision/tombstone, never destructive
  history deletion.
- [ ] Проверить original/last actor and one factsRevision increment per command.
- [ ] Запустить focused integration and `pnpm check:quick`.
- [ ] Commit: `feat: correct and tombstone planner facts`.

### T06 — Undo last own action

**Depends on:** T05.

**Outcome:** member can compensate only the last own reversible action; undo
never reverses partner/system action or erases history.

**Files:**

- Create: `src/modules/tracking/application/undo-last-own-action.command.ts`
- Test: `test/integration/tracking/undo-own-action.integration.spec.ts`

- [ ] Написать RED cases own add/latest/correction, partner latest action,
  system action, replay and concurrent new action.
- [ ] Реализовать compensation as new action group/revision using receipt/CAS.
- [ ] Проверить factsRevision, result replay and audit chain.
- [ ] Запустить focused integration and `pnpm check:quick`.
- [ ] Commit: `feat: undo last own tracking action`.

### T07 — Today and Month read models

**Depends on:** T05.

**Outcome:** channel-neutral Today/Month queries expose applicable expectations,
facts, states and progress without persistence in edge adapters.

**Files:**

- Create: `src/modules/tracking/application/get-today.query.ts`
- Create: `src/modules/tracking/application/get-month.query.ts`
- Create: `src/modules/tracking/presentation/tracking-query.controller.ts`
- Test: `test/e2e/tracking/today-month.e2e-spec.ts`

- [ ] Написать RED personal/shared/no-plan/late-publish/no-data fixtures.
- [ ] Реализовать bounded queries from publication+facts+P05.
- [ ] Add OpenAPI response schemas and server-side member authorization.
- [ ] Запустить E2E/OpenAPI drift and `pnpm check:quick`.
- [ ] Commit: `feat: expose daily and monthly tracking reads`.

### T08 — Atomic CloseDay

**Depends on:** T05.

**Outcome:** preview token/revision и confirmation атомарно переводят только
unresolved fixed expectations в `not_done`; flexible and weekly planned tasks
не затрагиваются.

**Files:**

- Create: `src/modules/tracking/application/preview-close-day.query.ts`
- Create: `src/modules/tracking/application/close-day.command.ts`
- Test: `test/integration/tracking/close-day.integration.spec.ts`
- Test: `test/e2e/tracking/close-day.e2e-spec.ts`

- [ ] Написать RED cases cancel, replay, preview race, already closed,
  `no_data` versus `not_done` and flexible exclusion.
- [ ] Реализовать preview set hash/revision и one-transaction confirmation.
- [ ] Проверить idempotent result replay before CAS.
- [ ] Запустить focused integration/E2E.
- [ ] Commit: `feat: close unresolved daily expectations`.

### T09 — Weekly planned task user result

**Depends on:** T05.

**Outcome:** weekly task owner records or corrects explicit `done/not_done`;
result is revisioned, auditable and protected by receipt/CAS.

**Files:**

- Create: `src/modules/tracking/application/record-weekly-task-result.command.ts`
- Test: `test/integration/tracking/weekly-task-result.integration.spec.ts`

- [ ] Написать RED owner/partner, done/not_done correction, replay, stale week
  and already system-closed cases.
- [ ] Реализовать result as typed week-level fact/action history.
- [ ] Проверить one factsRevision increment and no daily expectation creation.
- [ ] Запустить focused integration and `pnpm check:quick`.
- [ ] Commit: `feat: record weekly planned task result`.

### T10 — Planner worker and CloseWeek

**Depends on:** S03, T09.

**Outcome:** отдельный `planner-worker` использует transferred REL-03 runner и
идемпотентно закрывает unresolved weekly planned tasks на Monday/month boundary.

**Files:**

- Create: `src/bootstrap/planner-worker/**`
- Create: `src/modules/planning/application/close-week.command.ts`
- Create: `src/modules/planning/infrastructure/due-lifecycle.repository.ts`
- Modify: `docker-compose.yml`
- Modify: `docs/provenance/starter-core.md`
- Test: `test/integration/planning/close-week-worker.integration.spec.ts`
- Test: `test/unit/bootstrap/planner-worker-lifecycle.spec.ts`

**Produces:** product-owned worker executable and REL-03 adoption evidence;
runner remains only a non-overlapping process-local trigger.

- [ ] Написать fake-clock RED cases Monday, month edge, restart, duplicate tick
  and two competing runners.
- [ ] Перенести `run-worker-application` and periodic runner source paths с
  provenance; append exact SHA/paths, CloseWeek consumer, shutdown/restart
  failure model, adaptations and exclusions; реализовать DB due ownership.
- [ ] Доказать, что CloseWeek сохраняет user result, закрывает unresolved task и
  не daily-fails flexible goals.
- [ ] Проверить graceful shutdown, readiness and `pnpm check:quick`.
- [ ] Commit: `feat: run weekly plan lifecycle worker`.

### H01 — Scalar fact HTTP adapter

**Depends on:** T01, T02, T07.

**Outcome:** web records Boolean, quantity, time, rating and checkpoints through
the same application commands used by Telegram.

**Files:**

- Create: `src/modules/tracking/presentation/scalar-fact.controller.ts`
- Create: `src/modules/tracking/presentation/scalar-fact.dto.ts`
- Test: `test/e2e/tracking/scalar-fact-http.e2e-spec.ts`

- [ ] Написать RED HTTP cases personal/shared auth, idempotency replay,
  fingerprint conflict, stale revision and each scalar type.
- [ ] Map verified member to `trustedActor`; never accept actor from DTO.
- [ ] Add OpenAPI/Problem Details contracts and prove parity with T01/T02.
- [ ] Запустить E2E/OpenAPI drift and `pnpm check:quick`.
- [ ] Commit: `feat: expose scalar fact commands over HTTP`.

### H02 — Composite fact HTTP adapter

**Depends on:** T03, T04, T07.

**Outcome:** web records text, checklist, OR and composite occurrences through
existing tracking commands.

**Files:**

- Create: `src/modules/tracking/presentation/composite-fact.controller.ts`
- Create: `src/modules/tracking/presentation/composite-fact.dto.ts`
- Test: `test/e2e/tracking/composite-fact-http.e2e-spec.ts`

- [ ] Написать RED HTTP table cases for every composite type, partial progress,
  validation, authorization and replay.
- [ ] Implement thin DTO/command mapping without evaluator duplication.
- [ ] Add OpenAPI discriminators and Problem Details.
- [ ] Запустить E2E/OpenAPI drift and `pnpm check:quick`.
- [ ] Commit: `feat: expose composite fact commands over HTTP`.

### H03 — Fact maintenance and closure HTTP adapter

**Depends on:** T05, T06, T08, T09.

**Outcome:** web corrects/deletes/undoes facts, previews/confirms CloseDay and
records weekly task results through application commands.

**Files:**

- Create: `src/modules/tracking/presentation/fact-maintenance.controller.ts`
- Test: `test/e2e/tracking/fact-maintenance-http.e2e-spec.ts`

- [ ] Написать RED HTTP cases reason, owner/shared rights, own undo, CloseDay
  preview race and weekly result correction.
- [ ] Implement trusted actor and command ID/revision mapping.
- [ ] Add OpenAPI/Problem Details and verify stale/conflict recovery payloads.
- [ ] Запустить E2E/OpenAPI drift and `pnpm check:quick`.
- [ ] Commit: `feat: maintain and close tracking over HTTP`.

---

## M4. Telegram pilot, reminders, reports and close

### G01 — Telegram ingress shell and Today

**Depends on:** A03, P07, T07.

**Outcome:** private-chat update normalization, allowlist, update dedupe,
versioned callbacks and local `getUpdates` expose menu/Today/progress/no-plan
states without product-rule duplication.

**Files:**

- Create: `src/modules/telegram-bot/**`
- Modify: `prisma/schema.prisma`
- Create: `prisma/migrations/20260811170000_telegram_ingress_state/migration.sql`
- Test: `test/contract/telegram/update-normalization.contract.spec.ts`
- Test: `test/e2e/telegram/today-menu.e2e-spec.ts`

**Produces:** normalized trusted Telegram principal and opaque callback schema;
production webhook/getUpdates choice remains deployment-gated.

- [ ] Написать RED cases private/group, unknown ID, duplicate update, stale
  schema and no active plan.
- [ ] Реализовать one active local `getUpdates` consumer with durable offset;
  map only through WorkspaceMemberResolver and public queries.
- [ ] Проверить absence of catalog/draft wizard and raw Telegram ID logs.
- [ ] Запустить contract/E2E and `pnpm check:quick`.
- [ ] Commit: `feat: add private Telegram Today interface`.

### G02 — Semantic action intent and basic mutations

**Depends on:** G01, H01, T01.

**Outcome:** semantic `actionIntentId` maps Boolean and quantity preview/confirm
to existing commands; repeated Confirm is harmless even with a new callback ID.

**Files:**

- Create: `src/modules/telegram-bot/application/action-intent.service.ts`
- Create: `src/modules/telegram-bot/application/basic-fact-command.mapper.ts`
- Create: `src/modules/telegram-bot/infrastructure/action-intent.repository.ts`
- Modify: `prisma/schema.prisma`
- Create: `prisma/migrations/20260811200000_telegram_action_intents/migration.sql`
- Test: `test/integration/telegram/action-intent.integration.spec.ts`
- Test: `test/e2e/telegram/pilot-mutations.e2e-spec.ts`

- [ ] Написать RED journey Boolean/quantity с двумя callback query IDs для
  одного Confirm, stale aggregate, expired intent and closed plan.
- [ ] Реализовать bounded per-action state and deterministic commandId from
  actionIntentId; transport update ID используется только для ingress dedupe.
- [ ] Проверить add/latest/Boolean через те же T01 commands, что HTTP.
- [ ] Запустить migration integration/E2E and `pnpm check:quick`.
- [ ] Commit: `feat: add idempotent Telegram fact actions`.

### G03 — Time, rating and checkpoint mappings

**Depends on:** G02, T02.

**Outcome:** time/rating/checkpoint input uses the same action-intent
confirmation and existing T02 commands.

**Files:**

- Create: `src/modules/telegram-bot/application/scalar-fact-command.mapper.ts`
- Test: `test/e2e/telegram/scalar-fact-actions.e2e-spec.ts`

- [ ] Написать RED table journey time/rating/checkpoint including validation,
  selected expectation date and correction-before-confirm.
- [ ] Реализовать thin mapping без копий goal validators/evaluators.
- [ ] Проверить versioned opaque callback and decimal-string bigint boundary.
- [ ] Запустить focused Telegram E2E and `pnpm check:quick`.
- [ ] Commit: `feat: map scalar facts from Telegram`.

### G04 — Text, checklist and OR mappings

**Depends on:** G03, H02, T03, T04.

**Outcome:** text/checklist/OR/composite input uses the same action-intent
confirmation and existing composite tracking commands.

**Files:**

- Create: `src/modules/telegram-bot/application/composite-fact-command.mapper.ts`
- Test: `test/e2e/telegram/composite-fact-actions.e2e-spec.ts`

- [ ] Написать RED table journey text/checklist/OR/composite including partial
  progress, validation and correction-before-confirm.
- [ ] Реализовать thin mapping without goal evaluators or persistence access.
- [ ] Проверить per-component opaque IDs and action expiry.
- [ ] Запустить focused Telegram E2E and `pnpm check:quick`.
- [ ] Commit: `feat: map composite facts from Telegram`.

### G05 — Telegram corrections and period closure

**Depends on:** G04, H03, T05, T06, T08, T09.

**Outcome:** correction/delete/undo, CloseDay and explicit weekly task result
вызывают существующие commands and expose stale/conflict recovery.

**Files:**

- Create: `src/modules/telegram-bot/application/tracking-action.mapper.ts`
- Test: `test/e2e/telegram/correction-close-actions.e2e-spec.ts`

- [ ] Написать RED journey correction reason, own undo, partner-action denial,
  CloseDay preview race and weekly task result.
- [ ] Реализовать mapping to T05/T06/T08/T09 public contracts.
- [ ] Проверить replay, expired actionIntent and closed-plan responses.
- [ ] Запустить focused Telegram E2E and `pnpm check:quick`.
- [ ] Commit: `feat: close and correct plans from Telegram`.

### N01 — Reminder schedules and due occurrences

**Depends on:** T10.

**Outcome:** personal three-slot settings, unique occurrence, reschedule/disable,
exact expiry and 30-second due scan работают без relevance or provider call.

**Files:**

- Create: `src/modules/reminders/**`
- Modify: `prisma/schema.prisma`
- Create: `prisma/migrations/20260811210000_reminder_schedule_occurrence/migration.sql`
- Test: `test/integration/reminders/due-occurrence.integration.spec.ts`

**Produces:** `SaveReminderScheduleCommand` and `ClaimDueOccurrences`;
occurrence key excludes schedule revision.

- [ ] Написать RED cases reschedule/disable, next-slot expiry, duplicate
  generation, lease/fencing and downtime expiry.
- [ ] Реализовать indexed due rows, bounded claim and occurrence state machine.
- [ ] Проверить unique `(recipient, localDate, slotKind)` independent of schedule
  revision and no catch-up after expiry.
- [ ] Запустить focused integration and `pnpm check:quick`.
- [ ] Commit: `feat: schedule planner reminder occurrences`.

### N02 — Reminder relevance and immutable intents

**Depends on:** P04, P05, T07, N01.

**Outcome:** last authoritative reread строит morning/day/evening content,
suppresses completed/past/inapplicable work and creates immutable intent only
for non-empty reminder.

**Files:**

- Create: `src/modules/reminders/application/build-reminder-intent.command.ts`
- Create: `src/modules/reminders/domain/reminder-relevance.ts`
- Modify: `prisma/schema.prisma`
- Create: `prisma/migrations/20260811220000_notification_intents/migration.sql`
- Test: `test/unit/reminders/relevance.spec.ts`
- Test: `test/integration/reminders/reminder-intent.integration.spec.ts`

**Produces:** immutable rendered intent with expiry/supersession and terminal
`suppressed` outcome before any provider call.

- [ ] Написать RED cases personal/shared completion, partial remainder,
  focus-only, no active plan, grace/reopen and new fact after initial claim.
- [ ] Реализовать pure relevance/content policy using P04/P05 and authoritative
  planning/tracking queries.
- [ ] Повторно проверять relevance максимально близко к first attempt; empty
  content marks occurrence suppressed atomically.
- [ ] Запустить unit/integration and `pnpm check:quick`.
- [ ] Commit: `feat: build relevant reminder intents`.

### N03 — Telegram outbound attempt ledger

**Depends on:** G01, N02.

**Outcome:** one bounded Telegram attempt поверх transferred INT-01 имеет
`prepared → dispatching → terminal` ledger, explicit outcomes and safe crash
recovery without blind retry.

**Files:**

- Create: `src/modules/reminders/infrastructure/telegram-outbound.transport.ts`
- Create: `src/modules/reminders/infrastructure/notification-attempt.repository.ts`
- Create: `src/modules/reminders/application/deliver-reminder.command.ts`
- Modify: `prisma/schema.prisma`
- Create: `prisma/migrations/20260811230000_notification_attempts/migration.sql`
- Modify: `docs/provenance/starter-core.md`
- Test: `test/contract/telegram/outbound-transport.contract.spec.ts`
- Test: `test/integration/reminders/delivery-recovery.integration.spec.ts`

**Produces:** `TelegramAttemptOutcome = accepted | retryable | terminal |
ambiguous`; no schedule/template/retry policy inside transport.

- [ ] Написать fake provider RED matrix accepted, 429/retry_after, 5xx,
  blocked/chat-not-found, timeout-after-possible-send and oversize response.
- [ ] Перенести INT-01 selected paths; append exact SHA/source/target paths,
  reminder consumer, timeout/ambiguous failure model, adaptations and
  exclusions to provenance; implement single attempt mapping.
- [ ] Проверить crash at each transition: orphaned prepared reclaim;
  dispatching becomes terminal ambiguous; fencing rejects stale outcome.
- [ ] Запустить contract/integration and `pnpm check:quick`.
- [ ] Commit: `feat: deliver reminders with bounded Telegram attempts`.

### N04 — Reminder settings and delivery status HTTP adapter

**Depends on:** N01, N03.

**Outcome:** each member configures three personal slots and reads
available/blocked/connection-lost delivery status in web without seeing the
partner's settings.

**Files:**

- Create: `src/modules/reminders/presentation/reminder-settings.controller.ts`
- Create: `src/modules/reminders/application/get-reminder-settings.query.ts`
- Create: `src/modules/reminders/application/get-delivery-status.query.ts`
- Test: `test/e2e/reminders/reminder-settings.e2e-spec.ts`

- [ ] Написать RED cases per-member authorization, optional slots,
  morning<day<evening, fixed timezone and blocked provider projection.
- [ ] Implement HTTP command/query mapping and warning read model from terminal
  N03 outcomes.
- [ ] Add OpenAPI/Problem Details and verify partner settings are not exposed.
- [ ] Запустить E2E/OpenAPI drift and `pnpm check:quick`.
- [ ] Commit: `feat: manage reminder settings over HTTP`.

### N05 — Reminder worker pipeline

**Depends on:** N01, N02, N03, T10.

**Outcome:** planner-worker tick executes claim → authoritative reread →
suppression or prepared intent → dispatch/retry/terminal with exact expiry and
crash recovery.

**Files:**

- Create: `src/modules/reminders/application/run-due-reminders.cycle.ts`
- Modify: `src/bootstrap/planner-worker/**`
- Test: `test/integration/reminders/reminder-worker-pipeline.integration.spec.ts`
- Test: `test/unit/bootstrap/reminder-worker-wiring.spec.ts`

- [ ] Написать fake-clock RED cases duplicate ticks, completion after claim,
  expiry, safe retry, orphaned prepared and orphaned dispatching.
- [ ] Compose N01/N02/N03 through public contracts under REL-03 non-overlapping
  runner; do not bypass repositories from bootstrap.
- [ ] Проверить restart/fencing, bounded batch and graceful shutdown.
- [ ] Запустить integration/wiring tests and `pnpm check:quick`.
- [ ] Commit: `feat: run due reminder delivery pipeline`.

### R01 — Pilot provisional report

**Depends on:** P05, T07.

**Outcome:** report calculator строит два personal и один shared section with
monthScore, goalScore, uncapped progress, fact/target, coverage and
overperformance. Series/read API добавляются отдельно в R02.

**Files:**

- Create: `src/modules/reporting/**`
- Test: `test/unit/reporting/pilot-report.spec.ts`
- Test: `test/integration/reporting/pilot-report.integration.spec.ts`

**Produces:** deterministic `CalculatePilotReport` result; payload intentionally
omits streak, weekday/category, forecast, comparisons and correlations.

- [ ] Написать RED fixture personal/shared separation and 100/50/130 = 83.33%.
- [ ] Реализовать deterministic calculator from immutable
  publication+facts+formulaVersion.
- [ ] Проверить no-data/not-applicable denominators and raw overperformance.
- [ ] Запустить unit/integration and `pnpm check:quick`.
- [ ] Commit: `feat: calculate pilot monthly results`.

### R02 — Pilot report series and HTTP read model

**Depends on:** R01.

**Outcome:** bounded active/grace query отдаёт core metrics plus heatmap,
cumulative quantity, actual time and rating trends through OpenAPI.

**Files:**

- Create: `src/modules/reporting/application/build-pilot-report.query.ts`
- Create: `src/modules/reporting/application/pilot-series.builder.ts`
- Create: `src/modules/reporting/presentation/reporting.controller.ts`
- Test: `test/e2e/reporting/provisional-report.e2e-spec.ts`

**Produces:** `BuildPilotReportQuery`; no completed-v1 analytics fields.

- [ ] Написать RED E2E fixture for heatmap/cumulative/time/rating and exact
  personal/shared separation.
- [ ] Реализовать bounded query and deterministic series mapper over R01.
- [ ] Добавить OpenAPI response and assert forbidden completed-v1 fields absent.
- [ ] Запустить E2E/OpenAPI drift and `pnpm check:quick`.
- [ ] Commit: `feat: expose pilot report series`.

### L01 — Grace and atomic CloseMonth

**Depends on:** R02, T08, T10.

**Outcome:** grace and scheduled CloseMonth atomically bind lifecycle to an
immutable report revision; close/correction race cannot produce mismatched
facts and report.

**Files:**

- Create: `src/modules/planning/application/close-month.command.ts`
- Modify: `src/bootstrap/planner-worker/**`
- Modify: `prisma/schema.prisma`
- Create: `prisma/migrations/20260812000000_report_revisions/migration.sql`
- Test: `test/unit/bootstrap/close-month-worker-wiring.spec.ts`
- Test: `test/integration/reporting/month-close.integration.spec.ts`
- Test: `test/e2e/reporting/close-month.e2e-spec.ts`

**Produces:** report revision with publication hash, factsRevision,
formulaVersion and payload checksum.

- [ ] Написать RED cases grace start, day-4 auto close, worker downtime catch-up
  and correction/close race.
- [ ] Реализовать lock/CAS → stable facts snapshot → report append → lifecycle
  transition in one transaction.
- [ ] Wire due CloseMonth into planner-worker and verify config lock plus record
  lock after ordinary grace.
- [ ] Запустить integration/E2E and `pnpm check:quick`.
- [ ] Commit: `feat: close monthly plans with immutable reports`.

### L02 — Reasoned reopen

**Depends on:** L01, N02, T05.

**Outcome:** authorized reopen records actor/reason/time, unlocks corrections
only and disables ordinary calendar auto-close without resuming old reminders.

**Files:**

- Create: `src/modules/planning/application/reopen-month.command.ts`
- Test: `test/integration/reporting/reopen-month.integration.spec.ts`
- Test: `test/e2e/reporting/reopen-month.e2e-spec.ts`

- [ ] Написать RED cases missing reason, unauthorized reopen, config mutation,
  old deadline tick and correction.
- [ ] Реализовать reopened lifecycle mode preserving all report revisions.
- [ ] Проверить no old reminder revival and no system auto-close.
- [ ] Запустить integration/E2E and `pnpm check:quick`.
- [ ] Commit: `feat: reopen closed monthly plans`.

### L03 — Explicit RecloseMonth

**Depends on:** L02, R01, T05.

**Outcome:** member explicitly recloses reopened month and appends a revised
immutable report from the new factsRevision without overwriting the original.

**Files:**

- Create: `src/modules/planning/application/reclose-month.command.ts`
- Test: `test/integration/reporting/reclose-month.integration.spec.ts`
- Test: `test/e2e/reporting/reclose-month.e2e-spec.ts`

- [ ] Написать RED cases not-reopened, stale revision, concurrent correction,
  replay and changed facts checksum.
- [ ] Reuse L01 transaction participant with status `revised` and member actor;
  worker cannot call RecloseMonth.
- [ ] Проверить preservation of original report and no notification revival.
- [ ] Запустить integration/E2E and `pnpm check:quick`.
- [ ] Commit: `feat: reclose revised monthly reports`.

### E01 — Full backend pilot acceptance

**Depends on:** A03, P08, P09, P11, H01, H02, H03, G05, N04, N05, L03.

**Outcome:** deterministic fresh-DB journey доказывает весь backend pilot и
traceability каждого pilot AC без live-provider claims.

**Files:**

- Create: `test/e2e/pilot/full-month-pilot.e2e-spec.ts`
- Create: `docs/evidence/backend-pilot-acceptance.md`
- Modify: `TECHNICAL_DESIGN.md` acceptance matrix only if verified test mapping
  differs from the approved mapping.

- [ ] Написать one fake-clock journey OIDC → April draft/publish → web and
  Telegram facts → reminders → CloseDay/CloseWeek → grace/close/reopen/report →
  next-month copy.
- [ ] Привязать AC-01/01b, AC-02…AC-11, AC-13/14, AC-16…AC-24 и AC-SM-01 к
  exact automated/manual evidence. AC-12/15 остаются completed-v1.
- [ ] Запустить fresh DB E2E, `pnpm check` and OpenAPI drift.
- [ ] Провести independent whole-feature review and one consolidated fix wave.
- [ ] Commit: `test: verify backend pilot acceptance journey`.

### O01 — Local runtime composition smoke

**Depends on:** E01.

**Outcome:** local composition доказывает runtime roles, readiness, restart and
bounded shutdown; data restore выделен в O02.

**Files:**

- Modify: `docker-compose.yml`
- Create: `docs/runbooks/planner-local-operations.md`
- Create: `scripts/smoke/planner-runtime-smoke.ts`
- Create: `docs/evidence/local-runtime-smoke.md`

- [ ] Проверить `api + planner-worker + migrator + PostgreSQL + auth Redis`,
  readiness, bounded shutdown and restart.
- [ ] Зафиксировать границу evidence: local smoke не доказывает HTTPS,
  BotFather settings, hosted OIDC/Telegram or production ingress.
- [ ] Запустить Docker smoke and `pnpm check`.
- [ ] Commit: `test: verify local planner runtime composition`.

### O02 — Separate-database restore drill

**Depends on:** O01.

**Outcome:** encrypted backup восстанавливается в отдельную PostgreSQL instance
and proves product/report recovery content; auth Redis may start empty.

**Files:**

- Create: `docs/runbooks/planner-backup-restore.md`
- Create: `scripts/smoke/planner-restore-smoke.ts`
- Create: `docs/evidence/local-restore-drill.md`

- [ ] Создать backup populated E01 database without copying auth Redis.
- [ ] Восстановить в отдельную instance, применить required migrations and
  verify identities, active publication, facts revisions, pending reminders
  and sample report checksum.
- [ ] Зафиксировать measured local elapsed time separately from production RPO
  ≤ 1 hour and RTO ≤ 4 hours objectives.
- [ ] Запустить restore smoke and final `pnpm check`.
- [ ] Commit: `docs: verify planner database restore`.

---

## 4. Dependency spine

```text
B00 → B01 → S01 → S02 → S03 → S04 → A01 → A02 → A03
A01 → P01 → P02 → P03 → P04 → P05 → P06 → P07 → P08/P09
P03 + P04 + P05 → P10; P01 + P10 → P11
P07 → T01 → T02 → T03/T04 → T05 → T06/T07/T08/T09 → T10
T01 + T02 + T07 → H01; T03 + T04 + T07 → H02
T05 + T06 + T08 + T09 → H03
A03 + P07 + T07 → G01; H01 → G02 → G03; H02 → G04; H03 → G05
T10 → N01; P04 + P05 + T07 + N01 → N02 → N03
N01 + N03 → N04; N01 + N02 + N03 + T10 → N05
P05 + T07 → R01 → R02 → L01 → L02 → L03
P08 + P09 + P11 + H01/H02/H03 + G05 + N04/N05 + L03 → E01
E01 → O01 → O02
```

Parallel execution допустим только для branches без общей schema/contract
границы. Prisma migrations, public interface ledger и OpenAPI ownership
сериализуются через dependency spine.

## 5. Milestone gates

| Milestone | Tasks | Gate | Observable outcome |
| --- | --- | --- | --- |
| M0 | B00–B01, S01–S04 | `pnpm check:quick` | независимый runnable backend foundation |
| M1 | A01–A03 | auth integration + OIDC E2E + quick gate | два allowlisted member входят в web |
| M2 | P01–P11 | planning integration + seed E2E + quick gate | April template, preview, copy and publish work |
| M3 | T01–T10, H01–H03 | tracking/worker/HTTP integration + quick gate | all facts and daily/weekly close work in web |
| M4 | G01–G05, N01–N05, R01–R02, L01–L03 | Telegram/reminder/report E2E + quick gate | весь pilot behavior работает локально |
| Acceptance | E01 | `pnpm check` | все pilot AC трассированы |
| Local ops | O01–O02 | Docker + restore smoke | local runtime/recovery evidence |

### 5.1. Acceptance owner map

| Acceptance | Owning tasks |
| --- | --- |
| AC-01, AC-01b | A01–A03 |
| AC-02 | P09 |
| AC-03 | P03, P06, P07 |
| AC-04, AC-05 | P04, P07 |
| AC-06 | T01, H01, G02 |
| AC-07, AC-16 | T02, H01, G03 |
| AC-08, AC-18 | T04, H02, G04 |
| AC-09 | T08, H03, G05 |
| AC-10 | N01–N05 |
| AC-11 | L01–L03 |
| AC-12 | completed v1; исключён из pilot tasks |
| AC-13, AC-14 | P05, R01 |
| AC-15 | completed v1; исключён из pilot tasks |
| AC-17 | T05–T06, H03, G05 |
| AC-19, AC-20 | T03, H02, G04 |
| AC-21 | T01, T04, R01 |
| AC-22, AC-SM-01 | P10–P11, E01 |
| AC-23 | P09, T09–T10 |
| AC-24 | T09–T10, H03, G05 |

## 6. Explicitly excluded from backend pilot

- `AC-12`: completed-v1 Telegram catalog/draft wizard CAS flow.
- `AC-15`: correlation sample-size behavior.
- Full Telegram catalog/draft editor and durable generic Back/Cancel/Resume
  wizard.
- Exposed streak, weekday/category, forecast, comparison and correlation
  analytics. Internal pace for reminder relevance remains pilot scope.
- AI/free-text parser, public signup, multi-space, native apps, wearables and
  medical recommendations.
- Frontend technical design and frontend implementation.
- Production hosting/provider, reverse proxy, DNS/TLS, production Telegram
  ingress and hosted smoke. They are launch-blocking deployment work, not local
  backend tasks.

## 7. Companion Starter tasks

Эти задачи не выполняются внутри Planner branches:

1. После merge существующего Starter PR #45 создать отдельный docs PR
   `docs/planner-capability-markers` с marker semantics `Expected from Planner`.
   Exact statuses: `REL-03` remains `Available`; `COM-02` and `GOV-02` remain
   `Validated candidate`; `ID-10` and `REL-05` become `Validated candidate`;
   new `COM-09` is `Validated candidate`; `INT-03` remains `Deferred` until a
   webhook ingress is selected. Marker never makes a capability `Available`.
2. После A03 отдельная задача может предложить upstream Telegram OIDC Reference.
3. После P01+T01+H01+G02 separate task may record cross-transport evidence for
   `REL-05`; neutral extraction still requires concurrent web/Telegram proof.
   После T05 — module-owned history evidence for `GOV-02`.
4. T10/N01/N05 give REL-03 adoption evidence, but no new Kit.
5. После N05 separate task evaluates full `COM-02` delivery mechanics; после
   N03 separate task evaluates `COM-09` Telegram single-attempt transport.

Каждая companion task повторно аудирует оба repos и получает собственный
review/commit/PR. Код Planner не ждёт extraction обратно в Starter.

## 8. Pre-pilot deployment gate

После O02, но до месяца без бумаги, отдельный deployment plan обязан выбрать и
доказать:

- provider/VPS, reverse proxy and release mechanism;
- production Compose/service definitions for `api`, `planner-worker`,
  `migrator`, PostgreSQL and auth Redis;
- production webhook или `getUpdates`, только один ingress mode;
- HTTPS, proxy trust, BotFather Allowed URLs, OIDC credentials/JWKS;
- production composition and worker lease/restart behavior;
- encrypted off-host backups, RPO ≤ 1 hour, RTO ≤ 4 hours and restore drill;
- hosted web login, Telegram command/reminder and observability smoke without
  PII leakage.

Backend pilot нельзя назвать launch-ready до прохождения этого gate, даже если
local `pnpm check` и Docker smoke зелёные.

## 9. Plan self-review

- Spec coverage: все pilot AC имеют owning task; completed-v1 AC-12/15 явно
  исключены.
- Task size: ни один behavior task не содержит одновременно два aggregate
  transactions и два channel adapters.
- Starter transfer: toolchain, runtime, HTTP contracts and session subset
  разделены; никакого wholesale copy.
- Type consistency: shared IDs, ActorRef, command envelope, member resolver and
  ProductClock определены один раз в interface ledger.
- Failure model: replay-before-CAS, immutable snapshots, report provenance,
  prepared/dispatching crash window and no blind Telegram retry имеют owning
  tests.
- Evidence boundary: local, CI, Docker, hosted and restore claims разделены.
- Placeholder scan: plan содержит явные решения и blockers; неопределённых
  implementation placeholders нет.
