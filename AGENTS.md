# Repository instructions

Объясняй изменения кода и Git на русском языке, если пользователь явно не
попросил другой язык.

## Источники истины

Перед изменением продукта прочитай затронутые разделы документов в таком
порядке:

1. `TECHNICAL_DESIGN.md` — технические границы и инварианты.
2. `PRD.md` — продуктовые правила, формулы и acceptance criteria.
3. `USER_FLOWS.md` — пользовательские сценарии.
4. `SCREEN_MAP.md` — поверхности и состояния интерфейсов.
5. `IMPLEMENTATION_PLAN.md` — порядок и размер исполняемых задач.

Если документы противоречат друг другу, не выбирай вариант молча. Сначала
синхронизируй контракты или останови задачу с точным описанием расхождения.

## Размер и границы задач

- Один запуск агента реализует один task ID из `IMPLEMENTATION_PLAN.md`, а не
  целый epic.
- Каждый task заканчивается узкой проверкой, review и отдельным commit.
- Не объединяй соседние задачи ради скорости, если их можно независимо принять
  или отклонить.
- После принятия task coordinator fast-forward-ит его commit в accepted `main`;
  следующая задача стартует только от этого exact HEAD.
- Изменение утверждённого контракта требует обновить технический документ,
  acceptance traceability и затронутые тесты в той же задаче.

## Planner и Starter

Planner и `/Users/denischernykh/projects/starters/nest-js-starter` — независимые
Git-репозитории. Между ними нет cherry-pick compatibility, автоматического
upstream, subtree, submodule или runtime dependency.

Любой перенос в любую сторону является отдельной задачей. Перед переносом:

1. Проверь source/target branch, revision, upstream и dirty state.
2. Прочитай инструкции обоих репозиториев.
3. Зафиксируй source paths, named consumer, failure model и provenance.
4. Переноси только совместимый контракт, не product vocabulary.
5. Запусти gates каждого изменённого репозитория.
6. Не повышай capability status до фактического merge в Starter.

## Архитектурные ограничения

- Сохраняй module-local hexagonal boundaries из `TECHNICAL_DESIGN.md`.
- Не вводи глобальный command bus, event sourcing, generic repository/service,
  global audit store или application-wide Redis abstraction.
- PostgreSQL — источник истины. Redis пилота используется только для opaque
  web-сессий и короткоживущей OIDC ceremony.
- BullMQ, queue Redis и transactional outbox не подключаются без нового
  доказанного failure model и изменения Technical Design.
- `progress` остаётся чистым модулем без БД, HTTP и чтения системных часов.
- `telegram-bot` остаётся edge adapter и вызывает те же application commands,
  что и web.
- Не обещай exactly-once для Telegram delivery.

## Node и pnpm

После переноса Starter foundation совместимость задают `.nvmrc`, `engines` и
`packageManager`: Node 24 и pnpm 11.15.1 на зафиксированном baseline.

- Перед изменением зависимостей или generated artifacts проверь
  `node --version` и `pnpm --version`.
- Используй plain `pnpm`.
- Dependency-changing commands запускай в host-capable окружении.
- Не обходи repository-owned `allowBuilds`, lockfile или migration policy.
- Во время работы запускай узкую проверку; перед завершением foundation slice —
  `pnpm check:quick`. Полный `pnpm check` нужен для integration/E2E gate.

## Безопасность и доказательства

- Actor всегда выводится из проверенной web session или Telegram `from.id`, а
  не принимается из payload.
- Не логируй tokens, raw Telegram IDs, username, phone, текстовые записи или
  содержимое OIDC/provider payload.
- Local tests не доказывают GitHub CI, OCI publication, deployment, Telegram
  smoke, backup restore или hosted behavior. Всегда называй границу evidence.
- Не создавай и не меняй production deployment configuration до отдельного
  pre-pilot deployment task. Named local-runtime tasks могут менять только
  local `docker-compose.yml` и local smoke assets.
