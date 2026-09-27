# @relay/rest-sdk

Приватный общий TypeScript REST-клиент Relay для браузера и Node.js.
Источник контракта — OpenAPI server-runtime; весь `src/` принадлежит генератору.
SDK не содержит бизнес-правил, конфигурации проекта или настроенного singleton-клиента.

- [Генерация, exports и применение](docs/DEVELOPMENT.md).
- [REST-справочник](../server-runtime/docs/API.md).
- [Конфигурация и политика HTTP-адаптера](../project-runtime/docs/CONFIGURATION.md).

Из корня репозитория:

```bash
pnpm --filter @relay/rest-sdk run generate
pnpm --filter @relay/rest-sdk run typecheck
pnpm --filter @relay/rest-sdk run build
```

`generate` экспортирует OpenAPI на временной базе без listener, затем заменяет `src/`.
`build` только компилирует сохранённые исходники в ESM и декларации `dist`:
генерация не является побочным эффектом сборки. Ручные правки и helpers в `src/` запрещены.
