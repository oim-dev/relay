# @relay/project-runtime

Приватный Node.js-пакет конфигурации, реестра проектов и общих адаптеров CLI/MCP.
Принимает явные параметры; env, аргументы, форматирование и жизненный цикл приложений
остаются у потребителей. Автоматического запуска API здесь нет.

- [Конфигурация, режимы и подключение](docs/CONFIGURATION.md) — пользовательский контракт.
- [REST API](../server-runtime/docs/API.md) — транспортный справочник.
- [Применение SDK](../rest-sdk/docs/DEVELOPMENT.md) — технический клиент и его границы.

## Модули и адаптеры

- `config` — поиск и чтение конфигурации без создания базы, выбор проекта, пути и URL.
- `registry` — создание и атомарное изменение реестра под межпроцессной блокировкой.
- `backend/types` — `Backend`, типизированный через методы сервисов Core.
- `backend/local` — прямые экземпляры сервисов Core для локального CLI.
- `backend/http` — адаптация SDK к Backend, проверка ответов, проектное подключение.
- `backend/server` — отдельный клиент серверного реестра, без выбранного проекта.

Backend охватывает продукт, сущности, граф, доски и задачи, критерии и комментарии,
планы, релизы, прогресс и validation. Это не полный перечень REST: прямых методов
settings и удаления сущностей в Backend нет. Имя проекта и `documentSections`
изменяются через generic `entities.update`; изменение slug и REST-удаление этим
не становятся доступными. Покрытие интерфейсов — в [матрице](../../docs/CAPABILITIES.md).

Экспорты `@relay/project-runtime/config`, `registry`, `backend/types`, `backend/local`,
`backend/http`, `backend/server` выбирают ESM и декларации из `dist`; условие
`tasks-source` предоставляет TypeScript. Адаптеры не копируют бизнес-правила Core.

## Разработка

Из корня репозитория, с актуальными сборками зависимостей:

```bash
pnpm --filter @relay/project-runtime run build
pnpm --filter @relay/project-runtime run typecheck
pnpm --filter @relay/project-runtime run test
```

`build` очищает `dist` и запускает TypeScript. Собственного lint-скрипта нет.
При изменении Backend сверяйте local и HTTP вместе; `test/config.test.ts` не покрывает
весь HTTP-адаптер. Для затронутых потребителей дополнительно нужны `pnpm run test:cli`
и `pnpm run test:mcp`; потеря ответа записи проверяется без предположения о дедупликации.
