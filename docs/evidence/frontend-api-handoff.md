# F10 — published OpenAPI consumer handoff evidence

**Дата проверки:** 30 августа 2026 года, `Asia/Yekaterinburg`

**Scope:** только cross-repository contract handoff. Этот документ не является
browser, hosted deployment или production smoke evidence.

## 1. Принятая пара revisions

| Граница                | Exact revision                             | Наблюдаемое состояние                                                                                                                     |
| ---------------------- | ------------------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------- |
| Backend OpenAPI owner  | `ef76210ad66d442704417addfcf54e7f68cab65d` | `git ls-remote origin refs/heads/main` вернул exact SHA                                                                                   |
| Canonical artifact     | `docs/api/openapi.json`                    | committed bytes, SHA-256 `ed80c89d36296750da11f68f4597a732a8e4e08f82f2e81a6ba8369dd2a9a625`                                               |
| Frontend accepted base | `59e8c085a08baa9b155826d33e397e80fb0d18fc` | merge commit PR #1; tree accepted `main`, previous PR source-check успешен для `23dab01`                                                  |
| Frontend F10 consumer  | `5e300725b207398da088511eb59f4fd36168d29a` | clean detached gate; direct child accepted base; опубликован как ancestor live remote feature-ветки                                       |
| Frontend remote ref    | `2a287ea37c920dc38a53236f6eb934829fcd3dac` | `git ls-remote origin refs/heads/feat/m1-frontend-foundation`; содержит `5e30072` плюс отдельный последующий sidebar commit вне scope F10 |

Canonical backend revision — последний commit, изменивший committed OpenAPI.
Последующий F10 evidence commit не меняет API bytes и поэтому не заменяет этот
contract revision.

## 2. Воспроизводимый handoff

Frontend `openapi/source.json` закрепляет единственный immutable source:

- repository `https://github.com/DenisChernykh/planner`;
- revision `ef76210ad66d442704417addfcf54e7f68cab65d`;
- artifact path `docs/api/openapi.json`;
- checksum
  `ed80c89d36296750da11f68f4597a732a8e4e08f82f2e81a6ba8369dd2a9a625`.

Pin получен командой
`node scripts/openapi/pin-openapi.mjs ef76210ad66d442704417addfcf54e7f68cab65d`,
после чего выполнен `pnpm api:generate`. Generation создала 55 runtime response
contracts, 60 Problem codes и 6 Telegram OIDC result codes.

Backend-команда `pnpm frontend-api:verify` проверяет без ручного копирования:

1. что current backend OpenAPI совпадает с blob canonical commit и этот commit
   входит в local tracking ref `origin/main`;
2. что frontend worktree clean, manifest содержит exact repository/revision/path
   и checksum, а snapshot byte-for-byte равен backend artifact;
3. что F01–F09 представлены 11 exact method/path/operationId mappings в backend
   OpenAPI и frontend required-operations;
4. что frontend имеет `api:sync`, `api:generate`, `api:check`, `check`, а CI
   выполняет тот же `pnpm check`;
5. что generated contract source содержит тот же revision/checksum.

Для exact evidence verifier выполнен с explicit path к clean detached frontend
worktree `5e30072`. Фактический вывод:

```text
Frontend API handoff: verified
backendOpenApiRevision=ef76210ad66d442704417addfcf54e7f68cab65d
frontendHead=5e300725b207398da088511eb59f4fd36168d29a
sha256=ed80c89d36296750da11f68f4597a732a8e4e08f82f2e81a6ba8369dd2a9a625
requiredCapabilities=11
```

## 3. Capability traceability

| Card | Method и path                                        | operationId                                     |
| ---- | ---------------------------------------------------- | ----------------------------------------------- |
| F01  | `GET /workspace/current`                             | `WorkspaceController_current`                   |
| F02  | `GET /planning/months`                               | `PlanningMonthController_list`                  |
| F03  | `POST /planning/drafts/empty`                        | `PlanningDraftController_createEmpty`           |
| F04  | `POST /planning/drafts/from-publication`             | `PlanningDraftController_createFromPublication` |
| F05  | `POST /planning/drafts/{planMonthId}/focus`          | `PlanningDraftController_updateMonthFocus`      |
| F06  | `POST /planning/publications/{publicationId}/cancel` | `PlanningPublicationController_cancel`          |
| F06  | `POST /planning/drafts/{planMonthId}/republish`      | `PlanningDraftController_republish`             |
| F07  | `GET /tracking/facts/{factRecordId}/history`         | `FactMaintenanceController_getHistory`          |
| F07  | `GET /planning/months/{planMonthId}/history`         | `PlanningMonthController_history`               |
| F08  | `GET /auth/telegram/callback`                        | `completeTelegramOidcLogin`                     |
| F09  | `GET /telegram/navigation`                           | `getTelegramNavigation`                         |

Frontend staged contract содержит 57 required operations; independent review
сверил все 57 с canonical OpenAPI. Для F08 отдельно подтверждены только
`303/400/401/413/422`, `Set-Cookie` cardinality `1..2` и generated/public finite
enum из `success|cancelled|login_rejected|access_denied|dependency_unavailable|invalid_callback`.

## 4. Исполняемые проверки

### Frontend `5e30072`

- Node `v24.18.1`, pnpm `11.15.1`; repository contract — Node 24 и pnpm
  `11.15.1`.
- `pnpm check` — PASS на clean commit.
- OpenAPI snapshot/generated drift — clean; generation: 55 response contracts,
  60 Problem codes, 6 OIDC result codes.
- Prettier, ESLint и Steiger — PASS.
- Vitest: 23 test files, 207 tests — PASS.
- TypeScript build и Vite production build — PASS; 2280 modules transformed.

### Backend `ef76210` + F10 worktree

- `pnpm frontend-api:verify` — PASS.
- `pnpm check` — PASS.
- Prettier, OpenAPI drift/lint, ESLint, typechecks, architecture и compiled
  build — PASS; dependency-cruiser проверил 458 modules / 1962 dependencies.
- Unit: 56 suites / 634 tests — PASS.
- Contract: 4 suites / 112 tests — PASS.
- Integration: 34 suites / 292 tests — PASS.
- E2E: 33 suites / 131 tests — PASS.

Independent cross-repository read-only review exact пары `ef76210` + `5e30072`
завершён без findings и принял contract-часть F10.

## 5. Граница evidence

Подтверждено:

- backend OpenAPI revision `ef76210` опубликован в `origin/main`;
- frontend commit `5e30072` опубликован, а его clean detached checkout
  воспроизводимо содержит exact pin, snapshot, generated provenance и F08
  result enum;
- live ref `refs/heads/feat/m1-frontend-foundation` содержит `5e30072`;
  последующий `2a287ea` меняет только sidebar и не входит в F10 evidence;
- local frontend/backend gates и независимый contract review прошли.

Не подтверждено:

- GitHub source-check для `5e30072` не запускался: workflow работает на PR, а
  после merge PR #1 новая feature-ветка пока не имеет открытого PR;
- публикация commit, содержащего этот evidence-документ, проверяется отдельно и
  не выводится из локального `pnpm check`;
- не выполнялись browser acceptance на mobile/desktop, hosted HTTPS/proxy,
  Telegram OIDC/session/CSRF/bot smoke, deployment или production smoke.

Следовательно, F10 закрывает contract handoff, но не повышает hosted или browser
readiness.
