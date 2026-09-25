# Продуктовый скилл Relay

Приватный ESM workspace-пакет `@relay/relay-skill` объединяет авторские источники в `src`
и технический сборщик в `scripts`. Содержание принадлежит `relay-docs`, механизм —
`relay-delivery`. Главный источник — `src/skill.md`, состав — `src/bundle.json`.

Из корня доступны алиасы `pnpm run skills:build`, `pnpm run skills:check`,
`pnpm run skills:test` и прямые пакетные команды:

```sh
pnpm --filter @relay/relay-skill run build
pnpm --filter @relay/relay-skill run check
pnpm --filter @relay/relay-skill run test
```

Из `packages/relay-skill` используйте `pnpm run build`, `pnpm run check`, `pnpm run test`.
Команды работают через исходники CLI с `tasks-source` и tsx, без предварительной
сборки приложений. Тест примеров использует конфигурацию TypeScript Server Runtime.

`build` готовит staging в `.artifacts`, публикует `skills/relay` и всегда обновляет
`apps/playground/.agents/skills/relay`. Оба выходных пути считаются от корня репозитория
независимо от cwd. `check` вычисляет ожидаемый пакет в памяти и только читает результаты
и ссылки: без записи, staging или предварительного `build`. Распространяемый `skills/relay`
обязателен; установленная копия Playground может отсутствовать на чистом checkout,
а если существует — также проверяется.

Turbo-задачи `build`, `check`, `test` имеют `dependsOn: []` и `cache: false`;
`lint`/`typecheck` не запускают `build`. Корневой `check` включает `skills:check` и
`agents:check`, а тесты обоих tooling-пакетов выполняет один раз через Turbo.
CI проверяет отслеживаемые выходы до сборки, чтобы она не скрывала расхождения.
CLI скилла не принимает агентские флаги `--root` и `--format`; библиотечный
`processBundle({ root, check })` позволяет работать с независимыми fixtures, включая пути с пробелами.

В manifest `files` относительны к `src`, а `documents`, `aliases`, `watch` — к корню
репозитория. Часть ссылок авторских материалов разрешается только в собранном пакете.
Метаданные `bundle-info.json` сохраняют схему версии 1, имя `relay` и хеши входов
без timestamp. Приватный workspace-пакет не входит в npm-выпуск CLI/Server/MCP.
