# Planner

Закрытый планировщик месяца с web- и Telegram-интерфейсами. Репозиторий пока
содержит утверждённую продуктовую и backend-спецификацию; приложение будет
собрано по небольшим задачам из implementation plan.

## Документы

- [PRD](./PRD.md)
- [User Flows](./USER_FLOWS.md)
- [Screen Map](./SCREEN_MAP.md)
- [Backend Technical Design](./TECHNICAL_DESIGN.md)
- [Frontend API Addendum](./FRONTEND_API_ADDENDUM.md)
- [Implementation Plan](./IMPLEMENTATION_PLAN.md)
- [Инструкции для ИИ-агента](./AGENTS.md)

Исходный бумажный план сохранён в [`monthly-plan-template`](./monthly-plan-template). Его
неоднозначности разрешены в стартовом seed как пользовательские данные, а не
константы кода.

Planner и `nest-js-starter` являются независимыми репозиториями. Перенос
foundation или reusable capabilities в любую сторону выполняется отдельной,
проверяемой задачей с provenance.

## Локальный Telegram ingress

Bot ingress является opt-in частью API process. По умолчанию
`TELEGRAM_INGRESS_MODE=disabled`. Для локального long polling задайте
`TELEGRAM_INGRESS_MODE=get_updates` и секрет `TELEGRAM_BOT_TOKEN`; production
режим остаётся заблокирован до отдельной deployment-задачи. Один process
использует PostgreSQL offset и принимает только private messages и callbacks.

Локальный `planner-worker` также использует `TELEGRAM_BOT_TOKEN` для отправки
напоминаний; Compose не запускает worker без этого секрета.

Authenticated web navigation к боту настраивается отдельно через optional
`TELEGRAM_BOT_URL=https://t.me/<username>`. Без него capability имеет status
`disabled`; unsafe/non-canonical значение возвращается как `misconfigured` и
не отражается в HTTP response.
