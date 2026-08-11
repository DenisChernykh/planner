# Planner

Закрытый планировщик месяца с web- и Telegram-интерфейсами. Репозиторий пока
содержит утверждённую продуктовую и backend-спецификацию; приложение будет
собрано по небольшим задачам из implementation plan.

## Документы

- [PRD](./PRD.md)
- [User Flows](./USER_FLOWS.md)
- [Screen Map](./SCREEN_MAP.md)
- [Backend Technical Design](./TECHNICAL_DESIGN.md)
- [Implementation Plan](./IMPLEMENTATION_PLAN.md)
- [Инструкции для ИИ-агента](./AGENTS.md)

Исходный бумажный план сохранён в [`monthly-plan-template`](./monthly-plan-template). Его
неоднозначности разрешены в стартовом seed как пользовательские данные, а не
константы кода.

Planner и `nest-js-starter` являются независимыми репозиториями. Перенос
foundation или reusable capabilities в любую сторону выполняется отдельной,
проверяемой задачей с provenance.

