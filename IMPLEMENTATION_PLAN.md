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
export type GoalDefinitionId = string;
export type GoalDefinitionVersionId = string;
export type GoalSeriesId = string;
export type GoalDefinitionState = "active" | "archived";
export type SeriesDecision = "continue" | "new";

export type GoalDefinitionVersionView = {
  goalDefinitionVersionId: GoalDefinitionVersionId;
  versionNumber: bigint;
  goalSeriesId: GoalSeriesId;
  seriesDecision: SeriesDecision;
  title: string;
  why: string;
  category: string;
};

export type GoalDefinitionSummary = {
  goalDefinitionId: GoalDefinitionId;
  state: GoalDefinitionState;
  revision: bigint;
  currentVersion: GoalDefinitionVersionView;
};

export type GoalDefinitionDetail = GoalDefinitionSummary & {
  versions: readonly GoalDefinitionVersionView[];
};

export type Weekday = "mon" | "tue" | "wed" | "thu" | "fri" | "sat" | "sun";

export type DraftGoalScopeV1 =
  | { readonly kind: "personal"; readonly ownerMemberId: MemberId | null }
  | { readonly kind: "shared" };

export type DraftGoalRepetitionV1 =
  | { readonly kind: "daily" }
  | { readonly kind: "weekdays"; readonly weekdays: readonly Weekday[] }
  | { readonly kind: "weekly"; readonly n: string | null }
  | { readonly kind: "monthly"; readonly n: string | null }
  | { readonly kind: "one_off"; readonly dueDate: string | null }
  | {
      readonly kind: "weekly_planned_task";
      readonly weekOrdinal: "1" | "2" | "3" | "4" | "5" | null;
      readonly taskText: string | null;
    };

export type DraftGoalMeasurementV1 =
  | { readonly kind: "boolean" }
  | {
      readonly kind: "quantity";
      readonly mode: "targeted" | "informational" | null;
      readonly unit: string | null;
      readonly precision: 0 | 1 | 2 | 3 | null;
      readonly aggregation: "add" | "latest" | null;
      readonly target: string | null;
    }
  | {
      readonly kind: "actual_time";
      readonly start: string | null;
      readonly end: string | null;
    }
  | {
      readonly kind: "rating";
      readonly minimum: number | null;
      readonly maximum: number | null;
    }
  | { readonly kind: "text" }
  | {
      readonly kind: "checklist";
      readonly items: readonly {
        readonly itemId: string | null;
        readonly label: string | null;
      }[];
    }
  | {
      readonly kind: "any_of";
      readonly variants: readonly {
        readonly variantId: string | null;
        readonly label: string | null;
        readonly unit: string | null;
        readonly precision: 0 | 1 | 2 | 3 | null;
        readonly target: string | null;
      }[];
    };

export type DraftGoalCheckpointSatisfactionV1 =
  | { readonly kind: "boolean" }
  | { readonly kind: "quantity"; readonly target: string | null }
  | {
      readonly kind: "actual_time";
      readonly start: string | null;
      readonly end: string | null;
    }
  | { readonly kind: "rating" }
  | { readonly kind: "text" }
  | { readonly kind: "checklist" }
  | { readonly kind: "any_of" };

export type DraftGoalConfigV1 = {
  readonly schemaVersion: 1;
  readonly scope: DraftGoalScopeV1;
  readonly repetition: DraftGoalRepetitionV1;
  readonly measurement: DraftGoalMeasurementV1;
  readonly checkpoints: {
    readonly aggregation: "independent" | "all" | null;
    readonly items: readonly {
      readonly checkpointId: string | null;
      readonly name: string | null;
      readonly deadline: string | null;
      readonly satisfaction: DraftGoalCheckpointSatisfactionV1;
    }[];
  } | null;
};

export type GoalScopeV1 =
  | { readonly kind: "personal"; readonly ownerMemberId: MemberId }
  | { readonly kind: "shared" };

export type GoalRepetitionV1 =
  | { readonly kind: "daily" }
  | {
      readonly kind: "weekdays";
      readonly weekdays: readonly [Weekday, ...Weekday[]];
    }
  | { readonly kind: "weekly"; readonly n: string }
  | { readonly kind: "monthly"; readonly n: string }
  | { readonly kind: "one_off"; readonly dueDate: string }
  | {
      readonly kind: "weekly_planned_task";
      readonly weekOrdinal: "1" | "2" | "3" | "4" | "5";
      readonly taskText: string;
    };

export type GoalMeasurementV1 =
  | { readonly kind: "boolean" }
  | {
      readonly kind: "quantity";
      readonly mode: "targeted";
      readonly unit: string;
      readonly precision: 0 | 1 | 2 | 3;
      readonly aggregation: "add" | "latest";
      readonly target: string;
    }
  | {
      readonly kind: "quantity";
      readonly mode: "informational";
      readonly unit: string;
      readonly precision: 0 | 1 | 2 | 3;
      readonly aggregation: "add" | "latest";
      readonly target: null;
    }
  | { readonly kind: "actual_time"; readonly start: string; readonly end: string }
  | { readonly kind: "rating"; readonly minimum: number; readonly maximum: number }
  | { readonly kind: "text" }
  | {
      readonly kind: "checklist";
      readonly items: readonly [
        { readonly itemId: string; readonly label: string },
        ...{ readonly itemId: string; readonly label: string }[],
      ];
    }
  | {
      readonly kind: "any_of";
      readonly variants: readonly [
        {
          readonly variantId: string;
          readonly label: string;
          readonly unit: string;
          readonly precision: 0 | 1 | 2 | 3;
          readonly target: string;
        },
        ...{
          readonly variantId: string;
          readonly label: string;
          readonly unit: string;
          readonly precision: 0 | 1 | 2 | 3;
          readonly target: string;
        }[],
      ];
    };

export type GoalCheckpointSatisfactionV1 =
  | { readonly kind: "boolean" }
  | { readonly kind: "quantity"; readonly target: string }
  | { readonly kind: "actual_time"; readonly start: string; readonly end: string }
  | { readonly kind: "rating" }
  | { readonly kind: "text" }
  | { readonly kind: "checklist" }
  | { readonly kind: "any_of" };

declare const goalConfigV1Brand: unique symbol;

export type GoalConfigV1 = {
  readonly schemaVersion: 1;
  readonly scope: GoalScopeV1;
  readonly repetition: GoalRepetitionV1;
  readonly measurement: GoalMeasurementV1;
  readonly checkpoints: {
    readonly aggregation: "independent" | "all";
    readonly items: readonly [
      {
        readonly checkpointId: string;
        readonly name: string;
        readonly deadline: string;
        readonly satisfaction: GoalCheckpointSatisfactionV1;
      },
      ...{
        readonly checkpointId: string;
        readonly name: string;
        readonly deadline: string;
        readonly satisfaction: GoalCheckpointSatisfactionV1;
      }[],
    ];
  } | null;
  /** Compile-time only; never serialized or installed as an object property. */
  readonly [goalConfigV1Brand]: true;
};

export type SourceProvenanceV1 = {
  readonly schemaVersion: 1;
  readonly sourceDocument: string;
  readonly sourcePage: number;
  readonly rawValue: string | null;
  readonly rawDenominator: string | null;
  readonly resolution: string;
};

export type PublishBlocker = {
  readonly planGoalId: PlanGoalId;
  readonly pointer: string;
  readonly code: "required" | "empty_collection" | "incompatible";
  readonly detail: string;
};

export type GoalConfigValidationResult =
  | {
      readonly publishable: true;
      readonly config: GoalConfigV1;
      readonly blockers: readonly [];
    }
  | {
      readonly publishable: false;
      readonly config: null;
      readonly blockers: readonly [PublishBlocker, ...PublishBlocker[]];
    };

export type CanonicalJsonValue =
  | null
  | boolean
  | string
  | number
  | readonly CanonicalJsonValue[]
  | CanonicalJsonObject;

export type CanonicalJsonObject = {
  readonly [key: string]: CanonicalJsonValue;
};

export type ActorRef =
  | { readonly kind: "member"; readonly id: MemberId }
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

export type CommandExecutionContext = {
  readonly occurredAt: Date;
};

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

export type MemberContext = {
  spaceId: SpaceId;
  memberId: MemberId;
  userId: UserId;
};

export interface WorkspaceMemberResolver {
  resolveUser(userId: UserId): Promise<MemberContext>;
  resolveTelegramId(telegramId: bigint): Promise<MemberContext>;
  resolveMember(memberId: MemberId): Promise<MemberContext>;
}

export type ProductClock = {
  now(): Date;
  today(timeZone: "Asia/Yekaterinburg"): string;
};

export type PublishMonthPayload = {
  readonly planMonthId: PlanMonthId;
  readonly previewSchemaVersion: string;
  readonly previewHashVersion: string;
  readonly previewHash: string;
};

export type PublishMonthApplicationCommand =
  ApplicationCommand<PublishMonthPayload>;

// commandType: planning.publish-month.v1
// mandatory expectedRevision: positive P03 draft revision
// result: DurableCommandResultRef<'planning.plan-publication.v1'>

export type RecordFactValueV1 =
  | { readonly kind: "boolean"; readonly result: "done" | "not_done" }
  | { readonly kind: "quantity"; readonly value: string };

export type RecordFactPayload = {
  readonly publicationId: PublicationId;
  readonly planGoalSnapshotId: string;
  readonly localDate: string;
  readonly value: RecordFactValueV1;
};

export type RecordFactApplicationCommand = ApplicationCommand<RecordFactPayload>;

// commandType: tracking.record-fact.v1
// result: DurableCommandResultRef<'tracking.fact-record.v1'>
// expectedRevision: absent for create/add; positive current fact revision for
// Boolean/latest update; add rejects expectedRevision.
```

External JSON представляет `bigint` как lossless decimal string. Internal
TypeScript и PostgreSQL используют соответственно `bigint` и `BIGINT`.
Adapters получают actor из verified channel context и только затем создают
`ApplicationCommand`; untrusted payload никогда не содержит `trustedActor`.
Receipt scope равен `(actorScope, commandType, commandId)`, где actorScope
детерминированно выводится из `trustedActor`. Canonical fingerprint покрывает
`commandType`, `expectedRevision` и payload; receipt хранит result reference,
aggregate revision and completion time. Replay lookup выполняется до permission
check and CAS. Durable mutation result ограничен immutable typed aggregate ref;
произвольного `TResult`, result JSONB, global command bus или generic audit
store нет.

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
- [x] На clean `main` выполнить:

```bash
gh repo create DenisChernykh/planner --private --source=. --remote=origin --push
```

- [x] Проверить `main...origin/main`, `git status -sb` и GitHub visibility
  `PRIVATE`.

### S01 — Starter toolchain transfer

**Depends on:** B01.

**Outcome:** installable empty backend skeleton использует проверенный
toolchain Starter, но ещё не содержит runtime и product modules.

**Files:**

- Modify: `.gitignore`
- Create: `.nvmrc`, `package.json`, `pnpm-lock.yaml`, `pnpm-workspace.yaml`
- Create: `tsconfig.base.json`, `tsconfig.json`, `tsconfig.build.json`,
  `tsconfig.test.json`
- Create: `jest.unit.config.mjs`, `jest.integration.config.mjs`,
  `jest.e2e.config.mjs`
- Create: `eslint.config.mjs`, `.prettierrc.json`, `.prettierignore`
- Create: `.dependency-cruiser.cjs`, `nest-cli.json`, `prisma.config.ts`
- Create: `docs/provenance/starter-core.md`
- Test: `test/unit/toolchain/planner-skeleton.spec.ts`

**Source allowlist:** root toolchain/config files only from exact Starter SHA.
Runtime source, product modules, approval requests, password/email code,
BullMQ/outbox and generated files are excluded.

- [x] Записать source repo, branch, full SHA, clean state, exact source/target
  paths, Planner build/test consumers, toolchain drift/install failure model,
  adaptations and intentional exclusions в provenance.
- [x] Механически перенести только allowlisted toolchain files, адаптировать
  package metadata/scripts and exact dependencies, затем в host-capable
  environment проверить `node --version`, `pnpm --version` and run
  `pnpm install`. Это bootstrap exception: до него Jest command не существует.
- [x] Добавить failing skeleton test, импортирующий отсутствующий
  `src/app-metadata.ts` и ожидающий `{ name: "planner", nodeMajor: 24 }`.
- [x] Запустить `pnpm test:unit:run -- test/unit/toolchain/planner-skeleton.spec.ts`
  и получить RED именно из-за отсутствующего module.
- [x] Создать `src/app-metadata.ts`, получить GREEN, затем запустить format and
  typecheck.
- [x] Commit: `chore: transfer planner toolchain foundation`.

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
- Test: `test/e2e/health/foundation-health.e2e.spec.ts`

**Interfaces:** produces `DatabaseTransactionPort`, health contributors and API
lifecycle used by every product module. Problem registry появляется в S03.

**Locked runtime oracle:** unprefixed `/health/live` — process-only
`200 { "status": "ok" }`; `/health/startup` — irreversible latch from
`503 { "status": "starting" }` to `200 { "status": "ok" }` after PostgreSQL
startup; `/health/ready` — `200` only for ready lifecycle plus available
PostgreSQL and `503` during startup, drain or database outage. `SIGTERM` and
`SIGINT` begin drain before listener close, wait at most `6_000 ms` for active
requests and share a hard `10_000 ms` shutdown watchdog. The migrator remains a
one-shot `prisma migrate deploy` process; API never applies migrations.

- [x] Написать integration test: migrator создаёт schema, runtime role может
  выполнять DML над test-owned probe, но не migrations или DDL; production
  migration не создаёт probe table без runtime consumer. API readiness зависит
  от PostgreSQL.
- [x] Доказать RED на пустом skeleton.
- [x] Перенести только database/lifecycle/health paths и заменить Starter
  product composition минимальным Planner `ApiModule`.
- [x] Append provenance: exact source SHA/paths, target paths, API/migrator
  consumers, database/lifecycle failure model, adaptations and exclusions.
- [x] Исключить queue/outbox runtime, queue Redis и demo modules из Compose и
  dependencies.
- [x] Проверить migration на fresh database, health E2E и graceful shutdown.
- [x] Commit: `chore: transfer universal backend runtime`.

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
- Modify: API/config/bootstrap composition, `src/bootstrap/contracts/**`,
  `src/bootstrap/observability/**`, `scripts/openapi/**`,
  `docs/api/openapi.json`, `package.json` and only directly required config
  files; `docs/provenance/starter-core.md`
- Test: `test/unit/platform/problem-details.spec.ts`
- Test: `test/e2e/platform/http-contracts.e2e.spec.ts`

**Produces:** HTTP problem registry, OpenAPI document builder, safe logger and
`ProductClock` adapter used by every temporal product test.

**Locked S03 contract:** Problem Details use
`application/problem+json`, namespace `https://planner.invalid/problems/<slug>`
and `urn:request:<requestId>` with fields `type`, `title`, `status`, `detail`,
`instance`, `code`, `requestId`; validation alone adds sorted/deduplicated
value-free RFC 6901 `errors`. The only core definitions are
`MALFORMED_REQUEST` 400, `NOT_FOUND` 404, `CONFLICT` 409,
`PAYLOAD_TOO_LARGE` 413, `UNSUPPORTED_MEDIA_TYPE` 415,
`VALIDATION_FAILED` 422, `RATE_LIMIT_EXCEEDED` 429, `INTERNAL_ERROR` 500 and
`DEPENDENCY_UNAVAILABLE` 503. Validation is transform-on, implicit-conversion-
off, whitelist/forbidNonWhitelisted/forbidUnknownValues-on; duplicate or
unregistered definitions fail startup and unknown failures are constant safe
`INTERNAL_ERROR`.

`X-Request-ID` accepts exactly one canonical UUID or uppercase ULID, otherwise
uses `randomUUID()`, echoes the selected value on every response and propagates
only correlation-safe fields. JSON and URL-encoded bodies are bounded to
`1_048_576` bytes; request/headers/keep-alive timeouts are `30_000`, `10_000`
and `5_000 ms`, without changing S02 `6_000/10_000 ms` shutdown bounds. Access
records contain only route template, uppercase method, status, duration and
correlation; logger/exporter/collector failures lose telemetry only. Trace is
allowlist-only, with events/links and Redis instrumentation excluded.

OpenAPI generation is deterministic and offline at `docs/api/openapi.json`:
only `openapi:generate` writes; `openapi:drift` is non-writing byte drift;
`openapi:lint` validates; runtime never regenerates. Test-only Nest
module/controller/DTO is permitted only in this S03 E2E file for validation and
must not enter production composition or generated OpenAPI. `ProductClock` is
the exact Planner-only contract `{ now(): Date; today(timeZone:
"Asia/Yekaterinburg"): string }`; only system adapter reads `new Date()`.

- [x] Написать RED cases validation Problem Details, correlation ID, PII-safe
  serialization and fake-clock date in `Asia/Yekaterinburg`.
- [x] Перенести selected HTTP/logging/observability paths and create system/
  fake `ProductClock` implementations.
- [x] Append exact source/target paths, consumers, HTTP/telemetry failure model,
  adaptations and exclusions to provenance.
- [x] Проверить bounded body/time limits, OpenAPI generation/drift and absence
  of raw secrets/IDs in captured logs.
- [x] Запустить unit/E2E, architecture check and `pnpm check:quick`.
- [x] Commit: `chore: transfer backend contract boundaries`.

### S04 — Local User and opaque session subset

**Depends on:** S03.

**Outcome:** pre-provisioned local User получает opaque browser session;
protected endpoint, revoke, CSRF/Origin и Redis-loss fail-closed работают без
password/email vertical.

**Files:**

- Create: `src/modules/auth/application/**`
- Create: `src/modules/auth/domain/**`
- Create: `src/modules/auth/infrastructure/**`
- Create: `src/modules/auth/presentation/**`
- Create: `src/modules/auth/composition/**`
- Create: `src/modules/auth/index.ts`
- Create: `src/platform/redis/**`
- Modify: `src/platform/config/runtime-*.ts`
- Modify: `src/bootstrap/api/api.module.ts`
- Modify: `src/bootstrap/api/configure-api.ts`
- Modify: `src/bootstrap/api/api-runtime.ts`
- Modify: `src/bootstrap/api/graceful-shutdown.ts`
- Modify: `src/bootstrap/contracts/openapi-runtime-config.ts`
- Modify: `src/platform/http/health/**`
- Modify: `src/platform/http/docs/**`
- Modify: `docs/api/openapi.json`
- Modify: `docker-compose.yml`
- Modify: `docs/provenance/starter-core.md`
- Modify: `prisma/schema.prisma`
- Create: `prisma/migrations/20260811100000_local_user_session/migration.sql`
- Test: `test/unit/auth/session-foundation.spec.ts`
- Test: `test/integration/auth/opaque-session.integration.spec.ts`
- Test: `test/e2e/auth/protected-session.e2e.spec.ts`
- Modify: `test/integration/platform/foundation-runtime.integration.spec.ts`
  only to expect the accepted S04 migration and minimal `users` table.
- Create/Modify: `test/**/support/**` and the S02 health E2E only where needed
  for the required auth Redis runtime.

**Produces:** `AuthenticatedPrincipal { userId: UserId; sessionId: string }`,
authentication guard and session issuer/revoker. Password, email, public signup
and approval-request code are absent.

`User` contains only UUID plus created/updated timestamps. The internal issuer
has A03 as its first production consumer, verifies an existing pre-provisioned
User and never creates/upserts one; S04 exposes no HTTP endpoint accepting a
`userId`. Each issue creates an independent session. Production routes are
`GET /auth/me`, `GET /auth/csrf` and `POST /auth/logout`.

Raw tokens are 32 random bytes/canonical base64url, public session IDs are 16
independent random bytes and Redis stores only an HMAC digest. Session TTLs are
7-day idle/30-day absolute with 5-minute touch throttling. Cookie policy is
`planner-session` outside production and `__Host-planner-session` in production,
`HttpOnly`, `SameSite=Lax`, `Path=/`, no `Domain`, and production `Secure`.
Unsafe methods require JSON, an exact configured Origin/Referer origin and a
constant-time session-bound CSRF token.

Auth adds module-owned `AUTHENTICATION_REQUIRED` 401 and
`AUTHORIZATION_DENIED` 403 without changing the S03 core catalog. Unknown,
malformed, expired, revoked or missing-User sessions return the former; bad
Origin/CSRF returns the latter; dependency failures reuse
`DEPENDENCY_UNAVAILABLE` 503. Auth Redis is a required startup/readiness
dependency with `2_000/2_000/2_500/1_000 ms` connect/command/health/shutdown
bounds. Redis loss makes readiness and session operations fail closed while
liveness/startup stay available after the startup latch; PostgreSQL is never
mutated by session failure. Queue Redis and Redis instrumentation stay absent.

- [x] Написать RED tests для session issue/authenticate/revoke, CSRF/Origin и
  Redis unavailable.
- [x] Перенести minimal User/session subset и адаптировать composition без
  password/email dependencies.
- [x] Append exact source/target paths, session consumer, Redis-loss/security
  failure model, adaptations and exclusions to provenance.
- [x] Проверить, что unknown/revoked session возвращает RFC 9457 response и не
  создаёт User.
- [x] Запустить auth integration, HTTP E2E и `pnpm check:quick`.
- [x] Commit: `feat: add local user session foundation`.

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
- Create/Modify: auth-owned local User operator provisioning seam under
  `src/modules/auth/{application,infrastructure,composition}/**` and its public
  module exports
- Create/Modify: PostgreSQL-only command projection under
  `src/platform/config/**`
- Modify: `package.json` with `provision:pair` (no dependency change)
- Modify: `prisma/schema.prisma`
- Create: `prisma/migrations/20260811110000_pair_workspace/migration.sql`
- Test: `test/unit/workspace/pair-provisioning-cli.spec.ts`
- Test: `test/integration/workspace/pair-provisioning.integration.spec.ts`
- Modify: `test/integration/platform/foundation-runtime.integration.spec.ts`
  only to expect the accepted A01 migration/tables.

**Produces:** `WorkspaceMemberResolver` из interface ledger. В A01 оба member
разрешаются в один `spaceId` без role; read-all plan и personal-owner policy
проверяются downstream после появления planning/personal mutations.

**Locked A01 contract:** `pnpm provision:pair` — PostgreSQL-only operator
command без HTTP/Redis/OIDC. Он читает из `stdin` один JSON до `16_384` bytes с
exact shape `{ members: [{ userId, telegramId }, { userId, telegramId }] }`.
`userId` — distinct lowercase canonical UUID; `telegramId` — distinct canonical
positive signed-`BIGINT` decimal string and never JSON number. Input order does
not matter; the `userId → telegramId` mapping does.

Inside one transaction-scoped PostgreSQL advisory lock the auth-owned seam
creates only missing explicit Users, then workspace creates one generated Space,
two generated Membership and two allowlist rows. Existing matching Users are
preserved. Same/reversed mapping returns the original IDs without writes;
changed mapping or partial state throws `PairProvisioningConflictError`;
concurrent equal/different runs cannot produce a mixed pair. Error/crash rolls
back Users and workspace rows together.

DB constraints enforce one singleton Space, membership technical slots `1|2`,
unique `(space_id, slot)`, `(space_id, user_id)` and `user_id`, unique BIGINT
Telegram ID and allowlist `user_id` referencing a member. Slot grants no rights
and carries no persona. CLI output contains only `status`, `spaceId`,
`memberId/userId`; raw Telegram IDs never reach stdout/stderr/logs. Exit codes
are `0` created/existing, `2` invalid input, `3` conflict and `1` dependency or
unexpected failure. Unknown resolver lookup throws safe
`WorkspaceMemberNotFoundError`; database failure is distinct
`WorkspaceDependencyUnavailableError`; neither path writes.

- [x] Написать RED constraints tests: duplicate Telegram ID, third membership,
  unknown ID и повтор provisioning с другим payload.
- [x] Реализовать `space`, `membership`, `telegram_access_allowlist` и
  idempotent operator provisioning command.
- [x] Проверить numeric Telegram ID как PostgreSQL `BIGINT`, TypeScript `bigint`
  и decimal string на CLI/JSON boundary.
- [x] Запустить fresh/upgrade migration integration и `pnpm check:quick`.
- [x] Commit: `feat: add closed pair workspace`.

### A02 — Telegram OIDC ceremony start

**Depends on:** A01.

**Outcome:** login start создаёт one-time server-side state/nonce/PKCE
transaction, redirects only to verified Telegram authorization endpoint and
never requests phone.

**Files:**

- Create: `src/modules/auth/application/start-telegram-oidc-login.use-case.ts`
- Create: `src/modules/auth/application/telegram-oidc.ports.ts`
- Create: `src/modules/auth/infrastructure/redis-oidc-transaction.store.ts`
- Create: `src/modules/auth/infrastructure/oidc-transaction.codec.ts`
- Create: `src/modules/auth/infrastructure/telegram-oidc.provider.ts`
- Create: `src/modules/auth/presentation/oidc-state-cookie.adapter.ts`
- Create: `src/modules/auth/presentation/telegram-oidc.controller.ts`
- Modify: auth public barrels, crypto adapter and
  `src/modules/auth/composition/auth.module.ts`
- Modify: auth runtime config/schema/service/defaults, API/OpenAPI config
  fixtures and local `docker-compose.yml`
- Create: `jest.contract.config.mjs`; Modify: `package.json` test scripts
- Create: `.redocly.lint-ignore.yaml` with one exact
  `operation-2xx-response` pointer
  `#/paths/~1auth~1telegram~1start/get/responses` for redirect-only Telegram
  start; keep the rule globally `error` in `redocly.yaml`
- Modify: `docs/api/openapi.json` and affected unit/E2E contract fixtures
- Test: `test/contract/auth/telegram-oidc.contract.spec.ts`
- Test: `test/integration/auth/oidc-transaction.integration.spec.ts`
- Test: `test/e2e/auth/telegram-oidc-start.e2e.spec.ts`

**Produces:** `OidcTransactionStore` and `TelegramOidcProvider` consumed by A03.

**Locked A02 contract:** public `GET /auth/telegram/start` returns bodyless `302`
with `Cache-Control: no-store`, `Pragma: no-cache`,
`Referrer-Policy: no-referrer` and request ID. Any query field, including
`returnTo`, parser-accepted JSON object/array and non-JSON text wire body return
existing `VALIDATION_FAILED` `422` before provider/Redis. Strict JSON scalar or
malformed JSON retains global `MALFORMED_REQUEST` `400`; valid JSON above
`1_048_576 bytes` retains global `PAYLOAD_TOO_LARGE` `413`; both parser errors
occur before controller dispatch. Caller input cannot choose callback or
post-login redirect. Fixed Telegram
discovery is fetched exactly once per start with no redirects, `2_000 ms`
timeout and inclusive `16_384-byte` streaming body limit (`16_385` is rejected),
then exact issuer, authorization endpoint, `code`, `S256` and required scopes
are verified before Redis create. There is no
automatic provider/Redis retry other than bounded `SET NX` collision handling.
Provider metadata is not a readiness dependency.

`TELEGRAM_OIDC_CLIENT_ID` is a canonical positive decimal string;
`TELEGRAM_OIDC_CALLBACK_URL` has exact path `/auth/telegram/callback`; separate
`AUTH_OIDC_STATE_KEY_SECRET` is canonical 32-byte base64url and differs from
session/CSRF secrets. Production callback is HTTPS; development/test may use
HTTPS or HTTP on literal loopback IP `127.0.0.1`/`[::1]`; `localhost` is
rejected as non-canonical. The fixed return target is `/`.

State, nonce and verifier are independent 32-byte CSPRNG values accepted only
after decode/re-encode canonical validation as 43-character unpadded base64url.
Challenge is S256, receives the same validation and the full authorization URL
is constructed before Redis create. Authorization query is exactly
`client_id`, `redirect_uri`, `response_type=code`,
`scope=openid profile telegram:bot_access`, `state`, `nonce`, `code_challenge`
and `code_challenge_method=S256`; `phone` is absent. A full tuple is retried at
most three times for duplicate entropy or `SET NX` collision.

Redis key uses HMAC-SHA256 state and stores no raw state. Record is exactly
`{ schema: 1, issuer: "https://oauth.telegram.org", clientId, nonce,
codeVerifier, callbackUrl, returnTo: "/" }`; encode validates and exact-projects
these seven fields, while decode requires clientId/callbackUrl equal to current
runtime config. TTL is `300_000 ms`; create is `SET NX PX`, consume is atomic
`GETDEL`. Corrupt records are deleted and fail closed. Start also sets raw
state in a browser-binding
HttpOnly, SameSite=Lax, Path=/ cookie (`planner-oidc-state` outside production,
`__Host-planner-oidc-state` with Secure in production), Max-Age `300`. A new
start replaces that browser's cookie. A03 must constant-time compare query state
to this cookie before consume; mismatch neither consumes nor clears a different
valid cookie, while a matched terminal callback consumes once and clears it.

Provider/Redis failure maps to safe `DEPENDENCY_UNAVAILABLE` `503` with no
cookie/redirect/PostgreSQL write. Secrets, OIDC values, provider payload and
authorization Location are never logged. A02 excludes callback/token/JWKS,
identity/allowlist/User/session work. Anonymous start cardinality/discovery
rate limiting is an accepted local closed-pilot residual risk and a separate
required pre-public-deployment ingress contract; this task only bounds record
lifetime and does not import password-flow limiting.

- [x] Написать RED contract cases for discovery/authorization endpoint, state,
  browser binding, nonce, RFC 7636 PKCE S256 vector, TTL, exact scopes and
  provider outage.
- [x] Реализовать one-time Redis transaction with TTL and atomic consume port.
- [x] Проверить scopes `openid profile telegram:bot_access`, отсутствие `phone`
  and safe redirect allowlist; доказать HMAC key, collision/replay and corrupt
  record behavior с real Redis.
- [x] Подключить исполняемый contract Jest layer и проверить public 302/cookie,
  parser-owned 400/413, endpoint-owned 422, safe 503, readiness isolation and
  exact OpenAPI contract E2E.
- [x] Запустить contract/integration/E2E, OpenAPI drift and
  `pnpm check:quick`.
- [x] Commit: `feat: start Telegram OIDC ceremony`.

### A03 — Telegram OIDC callback and identity binding

**Depends on:** A02.

**Outcome:** allowlisted participant completes verified callback and receives
local session; replay, invalid claims and identity collision fail closed.

**Files:**

- Create: `src/modules/auth/application/complete-telegram-oidc-login.use-case.ts`
- Create: `src/modules/auth/application/telegram-identity-binding.port.ts`
- Modify: `src/modules/auth/infrastructure/telegram-oidc.provider.ts`
- Create: `src/modules/auth/infrastructure/prisma-telegram-identity-binder.ts`
- Modify: `src/modules/auth/presentation/telegram-oidc.controller.ts`
- Modify: auth Problems/contribution/module and runtime config
- Modify: `prisma/schema.prisma`
- Create: `prisma/migrations/20260811120000_telegram_external_identity/migration.sql`
- Modify: `package.json`, `pnpm-lock.yaml`, OpenAPI artifact/config and local
  Compose fixture
- Test: `test/contract/auth/telegram-oidc-callback.contract.spec.ts`
- Test: `test/integration/auth/telegram-external-identity.integration.spec.ts`
- Test: `test/e2e/auth/telegram-oidc-callback.e2e.spec.ts`

**Produces:** unique `(issuer, subject)` plus numeric Telegram ID mapping to one
local User; uses S04 session issuer. `jose@6.2.3` verifies a freshly fetched,
strictly bounded local JWKS; no generic federation or UserInfo client is added.

**Locked A03 contract:** public `GET /auth/telegram/callback` has no
caller-selected redirect. Parser-owned JSON scalar/malformed body remains `400`,
body above 1 MiB remains `413`, and parser-admitted object/array/text body is
`422` before ceremony I/O. Exactly one canonical state must constant-time match
the browser cookie before Redis; mismatch is `OIDC_LOGIN_REJECTED` `401` with
zero consume/clear. After match, `GETDEL` happens exactly once before remaining
query classification and state cookie is cleared in `finally`. Exact code,
OAuth error and invalid candidates follow the phase/order, field bounds and
safe redaction contract in `TECHNICAL_DESIGN.md` section 6.1.

Callback provider I/O is discovery → token → JWKS once each, fixed Telegram
URLs, no redirect/retry/cache/UserInfo, `2_000 ms` and inclusive `16_384-byte`
JSON body bounds. Token POST uses exact Basic/form contract. Pilot accepts only
RS256 and local JWKS with bounded/unique strong RSA keys. JWT pins issuer,
scalar audience, optional azp, subject, exp/iat window, nonce, numeric Telegram
ID `1..2^52-1` and optional OIDC hashes. `TELEGRAM_OIDC_CLIENT_SECRET` is an
API-only validated secret. Raw callback/provider/profile values are neither
stored nor logged.

Auth owns an atomic Prisma binding adapter which reads only the exact allowlist
projection. One transaction under fixed A03 advisory lock creates or verifies
immutable `telegram_external_identities`; composite FK proves user/provider ID
belong to the same allowlist row. Unknown verified ID or any subject/ID/user
collision is `OIDC_ACCESS_DENIED` `403` with rollback. Binding commit precedes
S04 Redis session issue: Redis failure returns `503` without session cookie but
keeps the valid binding for idempotent recovery. Success is bodyless `303 /`
with two cookies and exact no-store/no-cache/no-referrer headers. OpenAPI lists
only `303/400/401/403/413/422/503`; Redocly receives one additional exact
callback-only 2xx-ignore pointer while the global rule stays `error`.

- [x] Написать fake issuer/JWKS RED matrix success, cancel, consumed/replayed
  state, parser/query order, nonce/PKCE/header/JWK/signature/claims/time/ID
  bounds, outage, unknown ID, redaction and binding collision.
- [x] Реализовать token exchange/JWKS validation, one-time consume and
  atomic allowlist-to-local-user binding с exact provider/session ordering.
- [x] Доказать real-PostgreSQL migration/constraints/idempotency/concurrency и
  real PostgreSQL+Redis callback/session recovery. Не использовать
  username/email/profile for linking; pre-binding negatives create no
  User/external identity/session.
- [x] Запустить full unit/contract/integration/E2E, Prisma/OpenAPI/Compose,
  architecture/build, `pnpm check:quick` и scope/secret/lock audit.
- [x] Commit: `feat: complete allowlisted Telegram OIDC login`.

---

## M2. Planning и deterministic progress

### P01 — Draft kernel and first durable command

**Depends on:** A01.

**Outcome:** `CreateEmptyDraft` и `UpdateMonthFocus` атомарно используют
actor-scoped receipt, fingerprint, receipt-before-CAS и finite action history.

**Files:**

- Create: `src/shared/application/application-command.ts`
- Create: `src/shared/application/command-receipt.port.ts`
- Create: `src/shared/application/command-fingerprint.ts`
- Create: `src/shared/application/durable-command.executor.ts`
- Create/Modify: neutral receipt adapter and export under
  `src/platform/database/**`
- Modify: workspace member resolver public port and Prisma adapter
- Create: `src/modules/planning/**`
- Modify: `prisma/schema.prisma`
- Create: `prisma/migrations/20260811130000_plan_draft_kernel/migration.sql`
- Test: `test/unit/shared/application/command-fingerprint.spec.ts`
- Test: `test/unit/shared/application/command-executor.spec.ts`
- Test: `test/integration/planning/draft-command.integration.spec.ts`
- Modify: exact migration/table inventory in
  `test/integration/platform/foundation-runtime.integration.spec.ts`

**Produces:** locked `CommandExecutor`, `GetDraftQuery`, month revision and
shared receipt contract later adopted by tracking.

- [x] Написать три approved RED suites: canonical fingerprint matrix; executor
  ordering/replay/rollback; real-PostgreSQL draft commands and query.
- [x] Реализовать receipt key exact `(actorScope, commandType, commandId)`, где
  member scope — `member:<canonical-lowercase-member-uuid>`, system scope —
  `system:planner-worker`; fingerprint v1 покрывает только `commandType`,
  nullable/positive-decimal `expectedRevision` и exact-projected payload.
- [x] В одной PostgreSQL transaction взять
  `pg_advisory_xact_lock(hashtextextended(keyJson, 8503113703))`, выполнить
  receipt conflict/replay до clock/permission/CAS, прочитать clock ровно один
  раз для fresh command, затем атомарно сохранить effect, finite planning
  history и typed completed receipt.
- [x] Реализовать `CreateEmptyDraft` с обязательным exact focus и canonical
  `YYYY-MM`, lifecycle/draft revision `1n`; `UpdateMonthFocus` с positive
  draft-only expected revision; `GetDraftQuery` без receipt. Actor разрешается
  server-side через `resolveMember`; payload exact-rejects actor/member/user/
  space и любые extra fields. Оба member имеют равные draft configuration
  rights; system actor P01 fail closed.
- [x] Добавить только P01 tables: `plan_months`, `plan_drafts`, neutral
  `command_receipts`, `planning_action_groups` и
  `planning_month_focus_changes`; receipt/history immutable, action-to-receipt
  FK deferred, arbitrary JSON отсутствует.
- [x] Запустить planning integration и `pnpm check:quick`.
- [x] Commit: `feat: add idempotent plan draft kernel`.

### P02 — Catalog, versions and analytical series

**Depends on:** P01.

**Outcome:** reusable goal definitions имеют version/archive, analytical series
и explicit continuity decision. Typed goal editor добавляется отдельно в P03.

**Files:**

- Create: planning catalog application/domain/persistence/composition public
  files and expand `createPlanningApplication`
- Create: `src/modules/planning/presentation/planning.controller.ts`
- Modify: public auth current-principal export, bounded platform Problem
  contract/filter/DTO, API module and deterministic OpenAPI artifact
- Modify: `prisma/schema.prisma` and exact migration/table inventory
- Create: `prisma/migrations/20260811140000_goal_catalog/migration.sql`
- Test: `test/unit/planning/catalog-contract.spec.ts`
- Test: `test/integration/planning/goal-catalog.integration.spec.ts`
- Test: `test/e2e/planning/goal-catalog.e2e.spec.ts`
- Modify: exact HTTP/OpenAPI oracles

**Produces:** exact metadata envelope `title|why|category`, immutable catalog
versions, definition revision/state, explicit `SeriesDecision = continue | new`
and reusable analytical-series identity consumed by P03. P02 never infers
semantic compatibility, and its metadata-only version is not attachable or
publishable until P03 adds typed config.

- [x] Написать approved unit/integration/E2E RED suites before production code:
  exact one-read snapshots and payload/result projections; metadata
  bounds/byte preservation; real-PostgreSQL create/version/archive/restore/copy,
  replay/races/rollback/constraints; authenticated HTTP, RFC 9457 and exact
  OpenAPI.
- [x] Реализовать exact five command types; every mutation returns only
  `DurableCommandResultRef<'planning.goal-definition.v1'>`, а copy проверяет
  source expected revision и возвращает новый definition at revision `1n`.
- [x] Реализовать member-authorized `ListGoalDefinitionsQuery` с
  `active|archived|all`, default `active`, deterministic created-at/ID order и
  `GetGoalDefinitionQuery` с descending versions; foreign identity неотличима
  от not found, queries не пишут receipt/history.
- [x] Добавить одной migration четыре P02 tables, immutable version/series/
  catalog-detail history, database continuity and archive/delete guards, а
  `planning_action_groups` расширить без ослабления P01 invariants.
- [x] Добавить семь authenticated `/planning/catalog/goal-definitions` routes,
  lossless decimal-string bigint JSON, session/CSRF security, finite RFC 9457
  planning problems с conflict extension только для revision/state conflicts и
  deterministic OpenAPI artifact.
- [x] Доказать archive/restore без physical delete, copy без изменения source,
  immutable historical links, replay-before-state/CAS и отсутствие P03 typed
  config/draft/publication paths.
- [x] Запустить focused unit/integration/E2E, Prisma/OpenAPI gates, затем format,
  lint, source/test typecheck, architecture, build, full unit/contract/
  integration/E2E и fresh `pnpm check:quick`.
- [x] Commit: `feat: add versioned goal catalog`.

### P03 — Typed draft goals and publish validation

**Depends on:** P02.

**Outcome:** все discriminated goal configurations редактируются в draft,
имеют stable child IDs and exact publish-validation.

**Files:**

- Create: `src/modules/planning/domain/goal-config.ts`
- Create: `src/modules/planning/domain/goal-validation.ts`
- Create: P03 application types, commands, query and persistence port
- Create: Prisma draft-goal persistence, composition wiring, DTO/response and
  bounded HTTP controller surfaces
- Modify: `prisma/schema.prisma`, planning exports/application/composition,
  finite Problem registry and deterministic OpenAPI artifact
- Create: `prisma/migrations/20260811150000_typed_draft_goals/migration.sql`
- Create: `src/modules/planning/application/draft-goal.commands.ts`
- Modify: `src/modules/planning/presentation/planning.controller.ts`
- Test: `test/unit/planning/goal-validation.spec.ts`
- Test: `test/integration/planning/draft-goal.integration.spec.ts`
- Test: `test/e2e/planning/draft-goal.e2e.spec.ts`
- Modify: exact migration/table, P01/P02 regression and HTTP/OpenAPI inventories

**Produces:** structurally valid editable `DraftGoalConfigV1`, narrowed
publishable `GoalConfigV1`, exact optional `SourceProvenanceV1`, stable
server-owned UUIDs for checkpoints/items/OR variants and immutable config
revisions. P04/P05 consume these exact types. Semantic comparison is
server-owned: repetition, `N`, targets, dates, order, labels and provenance
continue the current series; scope/owner, measurement kind, quantity mode/unit/
precision/aggregation, checkpoint aggregation/composition/satisfaction schema,
checklist set and OR set force a new definition-owned series. Caller never
sends actor/member/user/space/series IDs or a series decision.

P03 draft commands are exactly `planning.add-draft-goal.v1`,
`planning.update-draft-goal.v1`, `planning.remove-draft-goal.v1` and
`planning.reorder-draft-goals.v1`; all require positive draft
`expectedRevision`, use result kind `planning.plan-draft.v1`, aggregate by plan
month and increase only `plan_drafts.revision`. There is no P03 draft-copy
command: catalog copy is P02 followed by add; month/template copy remains P09.
Remove detaches/tombstones the attachment without physical deletion. Reorder
accepts the full exact permutation of active draft-goal IDs.

Add pins the active current same-space P02 catalog version and its series.
Update may pin another version of the same definition. Its catalog series wins
only when it differs from the previous source version's catalog series; a
newer `continue` version on the same catalog series therefore preserves any
custom effective series already allocated by P03. Otherwise a hard typed-axis
change allocates a new series in the same transaction, while compatible change
reuses the current effective series.
The immutable draft-goal revision stores source catalog version separately from
effective series. Stable child IDs are generated for absent/null add IDs;
update preserves existing IDs and generates only omitted/null new children,
rejecting forged, duplicate or cross-component reuse.
Public publish refinement заново валидирует exact stored shape, требует уже
заполненные server child IDs до brand и возвращает detached recursively frozen
branded clone; генерация новых ID остаётся только mutation boundary.

Structural/type/format/extra-field failures are zero-write RFC 9457 `422`.
Null/empty required leaves are structurally storable and become deterministic
publish blockers, returned as data rather than Problems. Input is exact-shape
plain data, read once before the first await; output is an exact recursively
frozen clone. String bytes and declared array order are preserved; weekdays
must already be unique Monday order. Canonical nonnegative decimals forbid
sign, exponent and leading zeroes, and scale may not exceed precision. Required
text/unit/label fields are non-whitespace and bounded to 500 code points;
provenance document/resolution to 500 and raw fields to 2,000. Targeted and OR/
checkpoint quantity targets are positive when complete; checkpoint scale не
превышает precision parent quantity measurement. Time is canonical
`HH:mm`, allows overnight and rejects equal endpoints; rating bounds are safe
integers with minimum below maximum.

The pure validator returns a discriminated `GoalConfigValidationResult`:
publishable branch contains the only normally constructible opaque/branded
`GoalConfigV1` and an empty blocker tuple; incomplete branch contains null
config and a non-empty blocker tuple. The private compile-time brand is never a
serialized field. Planning orchestration invoking P04/P05 accepts only this
refined config and projects it into each low-level progress seam's complete
exact structural DTO. Low-level progress functions validate their own DTO but
do not prove whole-goal publishability, clear P03 blockers or accept unchecked
nullable `DraftGoalConfigV1` as orchestration input.

`weekly_planned_task` is repetition with nullable ordinal `1..5` and nullable
task text, requires boolean measurement, permits personal/shared scope and never
has daily checkpoints. Checkpoints are allowed only for daily repetition;
their satisfaction discriminator must match the parent measurement kind,
quantity/time keep their own target/range, and checklist/OR use the parent
composition without nesting.

Checklist items, OR variants and checkpoints are each bounded to 100; one draft
and reorder payload are bounded to 200 active goals. Exceeding a bound is
structural `422`. P03 validates a `one_off` date's canonical syntax and
completeness only; target-month/calendar eligibility remains P04.

Persistence uses mutable `plan_draft_goals`, immutable
`plan_draft_goal_revisions` with versioned JSON config/provenance and stable
child IDs inside JSON, and one finite typed `planning_draft_goal_changes`
history detail per action. Cross-space composite FKs, a deferrable current-
revision FK, no-DELETE/detach and immutable revision/history guards apply.
There is a partial unique active `(plan_month_id, goal_definition_id)`; remove
tombstones the root, and a later add creates a fresh plan-goal/revision/child-ID
identity rather than reviving it. A deferred invariant owns the 200-row maximum
and dense active display order `0..count-1`. Typed remove/reorder history stores
full exact `before_order`/`after_order` arrays tied to the parent month: reorder
is a full same-set permutation and remove is exactly the previous set without
the tombstoned goal. Detail связывает current/adjacent config revision IDs,
exact parent draft transition, completed receipt aggregate/revision и final
effect. Duplicate active definition prechecked under draft lock maps to `422`,
while the partial unique index remains a backstop.
Every mutation remains inside the existing durable-command transaction:
receipt replay/conflict, member authorization, draft/month same-space/status/
CAS lock, catalog/config/series effect, finite history, draft `+1`, completed
receipt. The P02 orphan-series invariant counts series referenced by either a
catalog version or draft-goal revision.

P03 adds `GetDraftEditorQuery`, without widening P01 `GetDraftQuery`. It returns
the draft plus ordered active goals, catalog metadata/source version/effective
series, config/provenance, per-goal blockers and aggregate blockers; external
bigint values are canonical decimal strings. HTTP is exactly authenticated GET
`/planning/drafts?targetMonth=YYYY-MM`, add `POST
/planning/drafts/{planMonthId}/goals` (`201`), update/remove `POST
/planning/drafts/{planMonthId}/goals/{planGoalId}/update|remove` (`200`) and
reorder `POST /planning/drafts/{planMonthId}/goals/reorder` (`200`). Mutations
require conjunctive session, Origin and CSRF. OpenAPI documents exact nested
`oneOf` discriminators with `additionalProperties: false`; planning-owned
contribution устанавливается generic platform seam. Add/update/stored schemas
различают null-only/nullable/required UUID child-ID contracts.

Finite P03 Problems add draft/goal/version not-found `404`, not-editable and
draft-revision conflict `409` (the latter has its dedicated exact extension),
plus structural `422`; existing auth/parser/fingerprint/dependency Problems
remain. Publish validation is a framework-free pure function returning every
safe issue `{ planGoalId, pointer, code, detail }`, ordered by display order,
goal ID, pointer and code. Calendar targets (P04), evaluation (P05), preview/hash
(P06) and publication/snapshots/lifecycle (P07) are excluded.

- [x] Написать live unit/integration/E2E RED oracles всех union branches,
  blockers, semantic axes, stable IDs, PostgreSQL replay/CAS/races/rollback/
  constraints/history and exact HTTP/OpenAPI security/status/discriminators.
- [x] Реализовать exact add/update/remove/reorder mutations and separate draft
  editor query without P04+ behavior.
- [x] Доказать accepted P01/P02 regressions, migration/table inventories and
  P02 orphan-series rule over catalog-or-draft references.
- [x] После independent review повторить focused/static gates и запустить
  `pnpm check:quick`; pre-review focused/static gates уже GREEN.
- [x] Commit: `feat: add typed monthly goal drafts`.

### P04 — Calendar targets and period pace

**Depends on:** P03.

**Outcome:** framework-free `progress` вычисляет calendar eligibility, exact
period targets, proration and expected pace только из explicit inputs.

**Files:**

- Modify: `TECHNICAL_DESIGN.md`
- Modify: `PRD.md`
- Modify: `IMPLEMENTATION_PLAN.md`
- Modify: `.dependency-cruiser.cjs`
- Modify: `eslint.config.mjs`
- Create: `src/modules/progress/calendar-targets.ts`
- Create: `src/modules/progress/index.ts`
- Test: `test/unit/progress/calendar-targets.spec.ts`

**Produces:** exact versioned `calculateEligibleCalendar`,
`calculatePeriodTarget`, `calculateExpectedPace`, progress-owned repetition
input and detached recursively frozen fixed/quota/weekly-task calendar output;
no planning/product/platform/shared/framework, Nest, Prisma, HTTP, `Date`,
`Intl` or clock imports.

- [x] Синхронизировать P04 public shapes, finite input/calendar issues,
  activation/ordinal boundaries and exact formula version in canonical docs.
- [x] Написать literal RED fixtures exact half-up/bounds/huge decimal,
  manual Gregorian dates, Monday-Sunday month-bounded weeks, late month,
  selected weekdays, one-off, weekly planned task, pace, freeze and no debt.
- [x] Реализовать minimal calendar/pacing functions without binary float,
  unbounded decimal conversion, system time or cross-module imports.
- [x] Доказать `3/week` with 5 active days = 2, with 3 days = 1, late monthly
  target `5`, four/five/six-segment months and target-month edge years.
- [x] Запустить focused calendar unit/type/lint/format, mutation-resistant
  architecture rule/check and independent review before broad gates.
- [x] Commit: `feat: calculate planner period targets`.

### P05 — Goal evaluators, score and coverage

**Depends on:** P03, P04.

**Outcome:** pure evaluators calculate fixed/flexible progress, score, coverage
and overperformance for every pilot goal type.

**Files:**

- Modify: `TECHNICAL_DESIGN.md`
- Modify: `PRD.md`
- Modify: `IMPLEMENTATION_PLAN.md`
- Create: `src/modules/progress/goal-evaluators.ts`
- Create: `src/modules/progress/score-coverage.ts`
- Modify: `src/modules/progress/index.ts`
- Test: `test/unit/progress/goal-evaluators.spec.ts`
- Test: `test/unit/progress/score-coverage.spec.ts`

**Produces:** versioned `evaluateGoalProgress` and `calculateScoreCoverage`;
consumers pass a progress-owned exact snapshot, exact `CalendarTargetsInput`
provenance paired with its successful P04 calendar/version, authoritative
current facts and canonical `asOfLocalDate`. P05 recalculates P04 and requires
structural equality, so a forged/truncated/inconsistent successful DTO is not
trusted. Planning must explicitly project refined `GoalConfigV1`; P05 does not
import planning or accept the P03 config/draft directly.

Public constants are exact
`GOAL_EVALUATION_FORMULA_VERSION = "planner.goal-evaluation.v1"` and
`SCORE_COVERAGE_FORMULA_VERSION = "planner.score-coverage.v1"`. Snapshot
discriminator is exact
`schemaVersion: "planner.goal-evaluation-snapshot.v1"`. Goal output preserves
P04 calendar version and exposes exact ratio plus one-boundary half-up
`basisPoints`, where `100%="10000"`; unavailable goal reasons are
`informational|no_applicable_units`. Aggregate unavailable reasons are
`no_scored_goals|no_fixed_units`.

P05 owns complete exact measurement/checkpoint and normalized fact unions from
Technical Design §11.2. Facts are current effective state without actor,
persistence identity/terms, revision history or timestamps. Exact validation
rejects extra/accessor/prototype/sparse/duplicate/mismatched/future or
out-of-calendar data with frozen value-free finite issues. Absence computes
`no_data`; `not_applicable` only comes from calendar/as-of; output and errors
are detached recursively frozen.

Fixed score semantics, independent/all checkpoints, informational quantity,
weekly planned task, flexible per-period cap/no-debt and coverage units are
locked by PRD §§12.4–12.7 and TD §11.2. Independent child score caps each child
before exact mean. Weekly planned task is scored once after period start but
contributes `0/0` coverage. Aggregate score is equal-weight available goal
score; aggregate coverage sums counts.

Exact math stays rational through aggregation. Product decimals never use
binary float or unbounded `BigInt` conversion of caller strings; no silent new
per-field decimal bound. Deterministic exact-work budget is `250000` numeric
input digits, `10000` terms, `250000` output digits, `25000000`
multiplication and `50000000` divmod digit-work units; over-budget input is
typed `input_too_complex`, never approximation or a wall-time timeout. Opaque
`contributionId` is projection-wide unique domain current-state identity, not
a DB/revision ID. Internal graph is `goal-evaluators → score-coverage +
calendar-targets`; score-coverage is independent and internals never import the
barrel. Existing dependency-cruiser/ESLint P04 guards are sufficient and are
not changed without a failing architecture oracle.

Raw numeric digits are charged before normalization; one shared term ledger
rejects top-level and nested oversized arrays before key/descriptor traversal
or mapping. Accepted ratios are fully reduced by bounded string GCD regardless
of digit length, or rejected by the same deterministic budget. Measurement
item/variant IDs and checkpoint IDs are unique across the complete snapshot.

- [x] Синхронизировать P05 exact public DTO, finite errors, as-of, versions and
  every formula/coverage branch in canonical docs before RED.
- [x] Написать оба approved unit specs before production и доказать literal RED
  на отсутствующих modules/exports.
- [x] Доказать Boolean `1/3` + coverage `2/3`, add/latest including `.1+.2`,
  inclusive overnight time, rating bounds, text, checklist `2/4` + `3/4`
  coverage, OR max, independent/all checkpoints, informational branches,
  weekly task and flexible target-zero/no-debt.
- [x] Доказать child mean `1/2 + 1/6 → 3333`, independent `130/50 →
  progress 90, score 75, over 15`, month `100/50/130 → 8333`, coverage
  `1/1 + 0/9 → 1000`, exact half-up and huge-decimal no-drift.
- [x] Доказать authentic P04 provenance/result pairing, full ratio reduction,
  early shared work preflight, snapshot-wide identity and nested
  exact/freeze/mutation/accessor matrices; затем P04 regression,
  source/test typecheck, focused lint/format, architecture and full unit before
  independent review.
- [x] Commit: `feat: evaluate planner goal progress`.

### P06 — Publication preview

**Depends on:** P03, P04, P05.

**Outcome:** web получает revision-bound preview focus, owners, goal types,
frequencies, checkpoints/schedules, calculated period targets and blocking
validation errors before confirmation.

**Files:**

- Modify: `TECHNICAL_DESIGN.md`
- Modify: `PRD.md`
- Modify: `USER_FLOWS.md`
- Modify: `SCREEN_MAP.md`
- Modify: `IMPLEMENTATION_PLAN.md`
- Create: `src/modules/planning/application/build-publication-preview.query.ts`
- Create: `src/modules/planning/application/publication-preview.ts`
- Modify: `src/modules/planning/application/index.ts`
- Modify: `src/modules/planning/application/planning-application.ts`
- Modify: `src/modules/planning/application/planning-errors.ts`
- Modify: `src/modules/planning/composition/create-planning-application.ts`
- Create: `src/modules/planning/presentation/publication-preview.response.ts`
- Modify: `src/modules/planning/presentation/planning.controller.ts`
- Modify: `src/modules/planning/presentation/planning-openapi.contribution.ts`
- Modify: `docs/api/openapi.json`
- Test: `test/unit/planning/publication-preview.spec.ts`
- Test: `test/e2e/planning/publication-preview.e2e.spec.ts`
- Modify: `test/e2e/planning/draft-goal.e2e.spec.ts`
- Modify: `test/e2e/platform/http-contracts.e2e.spec.ts`

**Produces:** exact frozen `planner.publication-preview.v1` projection with
actor-independent `planner.publication-preview-hash.v1`, current/next/blocked
activation, ordered full draft goals, entire eligible P04 calendars, finite
P03/P04/window blockers and all three formula versions. It reuses exactly one
existing editor read, has no write or new persistence seam and never invokes
P05 evaluation without facts. P07 confirms exact revision/hash/version and
recomputes the same projector inside its transaction.

- [x] Написать RED unit/query and real PG+Redis E2E oracles: current/next/
  blocked activation, monthly late and weekly targets, P03 skip-P04,
  one-off/ordinal blockers, stable/change hash matrix, exact/freeze/accessor,
  both-member actor-free parity, cookie-only GET, `200` invalid/blocked,
  `404/409/422`, no-write rows/xmin/count and deterministic repeat.
- [x] Реализовать pure reusable projector/hash plus bounded query: one clock read,
  one `resolveUser`, zero controller resolver calls, one existing editor
  statement, public P03 refinement before exactly one P04 call per refined
  goal, no P05 evaluation and no persistence mutation.
- [x] Добавить exact OpenAPI path/query/security/status/response schemas and
  explicit RFC Problems only for request/auth/not-found/not-editable/dependency;
  config/calendar/window blockers remain `200` data.
- [x] После independent review запустить E2E/OpenAPI drift and
  `pnpm check:quick`; pre-review focused/static gates GREEN.
- [x] Commit: `feat: preview monthly plan publication`.

### P07 — Atomic publish and activation

**Depends on:** P06.

**Outcome:** confirmed preview одной transaction создаёт immutable publication,
focus/hash, goal snapshots, fixed expectations and flexible periods; late
publish prorates.

**Files:**

- Modify: `TECHNICAL_DESIGN.md`
- Modify: `PRD.md`
- Modify: `USER_FLOWS.md`
- Modify: `SCREEN_MAP.md`
- Modify: `IMPLEMENTATION_PLAN.md`
- Modify: `.superpowers/sdd/IMPLEMENTATION_PLAN/task-P07-brief.md`
- Modify: `.superpowers/sdd/IMPLEMENTATION_PLAN/task-P07-report.md`
- Create: `src/modules/planning/application/publish-month.command.ts`
- Create: `src/modules/planning/application/get-published-snapshot.query.ts`
- Create: `src/modules/planning/application/get-active-month.query.ts`
- Create: `src/modules/planning/application/publication-persistence.port.ts`
- Create: `src/modules/planning/application/publication.types.ts`
- Create: `src/modules/planning/application/publication.validation.ts`
- Modify: `src/modules/planning/application/publication-preview.ts`
- Create: `src/modules/planning/domain/publication-builder.ts`
- Create: `src/modules/planning/domain/publication.ts`
- Create: `src/modules/planning/infrastructure/prisma-publication.persistence.ts`
- Modify: `src/modules/planning/application/index.ts`
- Modify: `src/modules/planning/application/planning-application.ts`
- Modify: `src/modules/planning/application/planning-errors.ts`
- Modify: `src/modules/planning/composition/create-planning-application.ts`
- Modify: `src/modules/planning/composition/planning.module.ts`
- Modify: `src/modules/planning/infrastructure/prisma-plan-draft.persistence.ts`
- Modify: `src/modules/planning/presentation/planning.controller.ts`
- Create: `src/modules/planning/presentation/publication.dto.ts`
- Create: `src/modules/planning/presentation/publication.response.ts`
- Modify: `src/modules/planning/presentation/planning-problem.definitions.ts`
- Modify: `src/modules/planning/composition/planning-http-problem.contribution.ts`
- Modify: `src/modules/planning/presentation/planning-openapi.contribution.ts`
- Modify: `src/platform/http/errors/problem.contracts.ts`
- Modify: `src/platform/http/errors/http-problem.registry.ts`
- Modify: `src/platform/http/errors/problem-exception.filter.ts`
- Modify: `src/platform/http/docs/problem-response.dto.ts`
- Modify: `src/platform/http/docs/api-problem-responses.decorator.ts`
- Modify: `docs/api/openapi.json`
- Modify: `prisma/schema.prisma`
- Create: `prisma/migrations/20260811151000_plan_publication/migration.sql`
- Modify: `src/generated/prisma/**`
- Test: `test/unit/planning/publication-builder.spec.ts`
- Modify: `test/unit/planning/publication-preview.spec.ts`
- Test: `test/unit/planning/publish-month.spec.ts`
- Modify: `test/unit/platform/problem-details.spec.ts`
- Test: `test/integration/planning/publish-month.integration.spec.ts`
- Modify: `test/integration/planning/draft-goal.integration.spec.ts`
- Modify: `test/integration/platform/foundation-runtime.integration.spec.ts`
- Test: `test/e2e/planning/publish-month.e2e.spec.ts`
- Modify: `test/e2e/planning/draft-goal.e2e.spec.ts`
- Modify: `test/e2e/planning/publication-preview.e2e.spec.ts`
- Modify: `test/e2e/platform/http-contracts.e2e.spec.ts`

**Produces:** exact `planning.publish-month.v1`,
`GetPublishedSnapshotQuery({trustedUserId,publicationId})`,
`GetActiveMonthQuery({trustedUserId})` and frozen
`planner.published-snapshot.v1`. POST is exactly
`/planning/drafts/{planMonthId}/publish`; GETs are exactly
`/planning/publications/{publicationId}` and `/planning/months/active`.
Publication result kind is `planning.plan-publication.v1`; confirmed P06 hash is
the publication snapshot hash without a second algorithm.

- [x] Написать literal RED unit, real-PG integration, live PG+Redis E2E и exact
  OpenAPI tests до production/schema: activation boundary, byte-exact snapshot,
  stale/blocker zero-write, component expansion, replay/fingerprint,
  publish/edit races, failpoint rollback, migration upgrade/inventory/direct
  SQL invariants, auth/CSRF/media/body/dependency recovery и GET stability.
- [x] В одной durable transaction: replay/fingerprint precedence, one clock,
  trusted member, month+draft lock, consistent editor read, one P06 rebuild,
  revision/schema/hash/blocker checks before first write, materialization,
  lifecycle pointer/+1, typed action/detail, receipt и deferred commit guards.
- [x] Создать пять immutable tables и deferred pointer/completeness/effect
  invariants; заменить P03 mixed month index отдельными partial draft/lifecycle
  indexes. Fixed stable key использует `UNIQUE NULLS NOT DISTINCT`.
- [x] Развернуть fixed components по locked rule; сохранить все quota periods,
  включая target `0`; не создавать physical `not_applicable` и fake
  preactivation weekly-task period.
- [x] Ограничить exact materialization суммой `10_000` snapshot/fixed/period
  rows: P06 plan blocker `/goals` до hash, P07 cap+1 zero-write; три child table
  писать set-based bounded statements и сохранить transaction timeout `5s`.
- [x] Закрыть review invariants: immutable month identity/lifecycle, mandatory
  publication->draft FK, independent fixed/calendar array validation,
  migration preflight locks и полный Prisma/pg_catalog inventory.
- [x] Реализовать exact finite Problems/OpenAPI и frozen bounded GET queries;
  foreign/missing publication concealed, active query read-only и исключает
  scheduled/non-current/nonpublished states; blockers passthrough сохраняет
  exact pointer/code/detail порядок и при двух null plan-level IDs.
- [x] До handoff запустить focused unit/integration/E2E, затронутые planning
  regressions, Prisma validate/generate, OpenAPI generate/drift/lint, format,
  lint, source/test typecheck, architecture и diff/scope audits. Broad final
  gates и Git принадлежат coordinator.
- [x] Commit: `feat: publish immutable monthly plans`.

### P08 — Cancel and republish publication

**Depends on:** P07.

**Outcome:** cancel is allowed only before month start with no facts; republish
creates a new append-only publication revision and expectations.

**Files:**

- Create: `src/modules/planning/application/cancel-publication.command.ts`
- Create: `src/modules/planning/application/republish-month.command.ts`
- Modify: `src/modules/planning/application/publication-persistence.port.ts`
- Modify: `src/modules/planning/infrastructure/prisma-publication.persistence.ts`
- Modify: `prisma/schema.prisma`
- Create: `prisma/migrations/20260811152000_cancel_republish/migration.sql`
- Test: `test/integration/planning/cancel-republish.integration.spec.ts`

**Produces:** exact `planning.cancel-publication.v1` returning
`planning.plan-month.v1`, exact `planning.republish-month.v1` returning
`planning.plan-publication.v1`, append-only cancellation marker and
`plan_months.facts_revision` guard reused by T01.

- [x] Написать RED cases started month, existing facts, replay, stale revision
  and republish failure rollback.
- [x] Реализовать cancel active pointer without changing/deleting snapshots.
- [x] Реализовать republish through the same P07 builder with next revision.
- [x] Запустить focused integration and `pnpm check:quick`.
- [x] Commit: `feat: cancel and republish future plans`.

### P09 — Copy month without facts

**Depends on:** P07.

**Outcome:** `CreateDraftFromPublication` copies focus/config/series/order/
provenance/weekly task text, but no facts, statuses, notes, reports,
notifications or progress.

**Files:**

- Create: `src/modules/planning/application/create-draft-from-publication.command.ts`
- Modify: `src/modules/planning/application/planning.types.ts`
- Modify: `src/modules/planning/application/planning-command.validation.ts`
- Modify: `src/modules/planning/application/plan-draft-persistence.port.ts`
- Modify: `src/modules/planning/application/planning-application.ts`
- Modify: `src/modules/planning/application/index.ts`
- Modify: `src/modules/planning/composition/create-planning-application.ts`
- Modify: `src/modules/planning/infrastructure/prisma-plan-draft.persistence.ts`
- Modify: `prisma/schema.prisma`
- Create: `prisma/migrations/20260811153000_copy_month/migration.sql`
- Test: `test/unit/planning/copy-month.spec.ts`
- Test: `test/integration/planning/copy-month.integration.spec.ts`
- Test: `test/e2e/planning/copy-month.e2e.spec.ts`
- Modify: `test/integration/planning/publish-month.integration.spec.ts`

**Produces:** exact `planning.create-draft-from-publication.v1`, editable
revision-1 destination with unique space/month identity and immutable typed
`draft_copied` audit. Source publication remains byte-for-byte immutable.
Facts/corrections/reports ещё отсутствуют в schema; populated-source regression
начинается в T01/E01, а P09 доказывает отсутствие derived publication children.

- [x] Написать RED exact-contract/authorization/unit fixture и real-PostgreSQL
  fixture с archived definition, provenance, stable components и weekly task.
- [x] Реализовать idempotent atomic bounded copy, safe destination conflict и
  rollback после каждой write phase.
- [x] Сравнить source digest/xmin before/after и доказать отсутствие
  publication children в destination.
- [x] Запустить focused unit/integration/application-E2E и P07/P08 regressions.
- [x] Commit: `feat: copy published month into clean draft`.

### P10 — Versioned April seed

**Depends on:** P03, P04, P05.

**Outcome:** seed data полностью покрывает source DOCX and passes generic
publish-validation without creating a draft or automatic publication.

**Files:**

- Create: `src/modules/planning/seed/april-plan.seed.ts`
- Create: `src/modules/planning/seed/april-plan.provenance.json`
- Create: `docs/provenance/april-seed.md`
- Modify: `TECHNICAL_DESIGN.md`
- Test: `test/unit/planning/april-seed.spec.ts`

**Produces:** prefilled focus; meditation monthly Boolean N=16; exact N=2 for
both former ranges; all-channel checklists; collaborations `add` target 7;
shared important task; MemberB outreach; calendar-derived denominators.

- [x] Написать RED assertions on every resolved source decision and provenance
  page/raw denominator.
- [x] Реализовать versioned seed as data, not domain constants.
- [x] Доказать generic validation and no 30–31 March expectations in seed
  materialization preview.
- [x] Выполнить manual provenance checklist AC-SM-01 and save evidence note.
- [x] Commit: `feat: add resolved April plan seed`.

### P11 — Create draft from April seed

**Depends on:** P01, P10.

**Outcome:** UF-02 template selection atomically creates a fully populated
editable draft once; replay is stable and existing draft/consumed seed conflicts
are explicit. Actor explicitly binds itself to `memberA|memberB`; membership slots
remain technical and the immutable consumption stores both persona mappings.

**Files:**

- Create: `src/modules/planning/application/create-draft-from-seed.command.ts`
- Modify: `src/modules/planning/presentation/planning.controller.ts`
- Modify: `prisma/schema.prisma`
- Create: `prisma/migrations/20260811155000_seed_consumption/migration.sql`
- Test: `test/integration/planning/create-draft-from-seed.integration.spec.ts`
- Test: `test/e2e/planning/create-draft-from-seed.e2e.spec.ts`

- [x] Написать RED cases first selection, exact replay, existing destination
  draft, already-consumed seed and same-key/different-payload.
- [x] Реализовать seed consumption, draft/focus/goals/order/provenance in one
  transaction using P01/P03 contracts.
- [x] Add HTTP/OpenAPI selection route and verify no automatic publish.
- [x] Запустить migration integration/E2E and `pnpm check:quick`.
- [x] Commit: `feat: create April draft from seed`.

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
- Test: `test/e2e/tracking/record-command.e2e.spec.ts`

**Produces:** `RecordFactCommand`, `GetFactStateQuery`; reuses P01 command
contract without importing planning internals.

- [x] Написать RED cases: water 400+800, steps 2000→7000, Boolean replay,
  concurrent add, same-key/different-payload и shared single effect.
- [x] Реализовать contribution identity for add и single logical value with
  revisions for latest/Boolean.
- [x] Сохранять effect, receipt and action history атомарно.
- [x] Запустить integration/E2E и `pnpm check:quick`.
- [x] Commit: `feat: record boolean and quantity facts`.

### T02 — Time, rating and checkpoints

**Depends on:** T01.

**Outcome:** actual time привязан к explicit expectation date; rating является
measurement; named checkpoints имеют independent facts and one parent score.

**Files:**

- Create: `src/modules/tracking/application/record-time.command.ts`
- Create: `src/modules/tracking/application/record-rating.command.ts`
- Create: `src/modules/tracking/application/record-checkpoint.command.ts`
- Test: `test/integration/tracking/time-rating-checkpoint.integration.spec.ts`

- [x] Написать RED cases cross-midnight range, prior expectation date, rating
  min/max и incomplete/all checkpoints.
- [x] Реализовать typed values/revisions and P05 evaluator wiring.
- [x] Доказать, что low rating не failure, а checkpoint completion влияет на
  coverage/score.
- [x] Запустить focused integration и `pnpm check:quick`.
- [x] Commit: `feat: record time rating and checkpoints`.

### T03 — Text and checklist facts

**Depends on:** T01, T02.

**Outcome:** text+result and checklist item revisions сохраняются типизированно;
каждый required checklist item является coverage unit без extra parent unit.

**Files:**

- Create: `src/modules/tracking/application/record-text.command.ts`
- Create: `src/modules/tracking/application/record-checklist-item.command.ts`
- Test: `test/integration/tracking/text-checklist.integration.spec.ts`

- [x] Написать RED cases non-empty text+result, done/not_done correction,
  checklist partial completion and required-item coverage units.
- [x] Реализовать stable component references and typed revisions.
- [x] Проверить parent without extra expectation/coverage unit.
- [x] Запустить focused integration и `pnpm check:quick`.
- [x] Commit: `feat: record text and checklist facts`.

### T04 — OR, informational and flexible composite facts

**Depends on:** T01, T02.

**Outcome:** OR variants, informational quantity and flexible composite
occurrences сохраняют independent components and deterministic per-date facts.

**Files:**

- Create: `src/modules/tracking/application/record-or-variant.command.ts`
- Create: `src/modules/tracking/application/record-composite-occurrence.command.ts`
- Test: `test/integration/tracking/or-composite.integration.spec.ts`

- [x] Написать RED cases OR max without sum, partial variant, informational no
  target/score/reminder and per-date composite components.
- [x] Реализовать stable variant references, typed revisions and composite
  occurrence identity bounded by publication/date.
- [x] Проверить max normalized fraction and recalculation after correction.
- [x] Запустить focused integration and `pnpm check:quick`.
- [x] Commit: `feat: record flexible composite facts`.

### T05 — Corrections and tombstones

**Depends on:** T03, T04.

**Outcome:** correction/delete/tombstone preserve original recorder, last
editor, reason and history; personal/shared mutation rights are enforced.

**Files:**

- Create: `src/modules/tracking/application/correct-record.command.ts`
- Create: `src/modules/tracking/application/delete-record.command.ts`
- Test: `test/integration/tracking/correction-delete.integration.spec.ts`

- [x] Написать RED authorization/history/CAS cases for owner personal mutation,
  shared correction reason and partner personal denial.
- [x] Реализовать correction/delete as new revision/tombstone, never destructive
  history deletion.
- [x] Проверить original/last actor and one factsRevision increment per command.
- [x] Запустить focused integration and `pnpm check:quick`.
- [x] Commit: `feat: correct and tombstone planner facts`.

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
