# Разработка Relay

Этот документ — практическая инструкция окружения. [Навигатор разработки](development/README.md)
связывает процессы и справочные материалы, [команда](development/AGENT-TEAM.md) —
приложения и пакеты с самодостаточными профилями исполнителей. [Корневой AGENTS.md](../AGENTS.md)
содержит общие правила для всех агентов; полная роль главного находится в
[профиле оркестратора](../packages/dev-agents/src/orchestrator.md).

Контракты и спецификации выбираются по задаче. Человеческий результат и машинная
корректность проверяются отдельно; документы обновляются при смысловом изменении
публичного поведения. Постоянные журналы агентов и обязательные досье не ведутся.

[Документация](README.md) → Разработка

## Содержание

- [Окружение](#окружение)
- [Запуск](#запуск)
- [Структура](#структура)
- [Команды](#команды)
- [Проверки](#проверки)
- [Документация и поставка](#документация-и-поставка)

## Окружение

Монорепозиторий использует Turborepo и pnpm workspaces. Для разработки рекомендуется
**Node.js 24** и **pnpm 11.18.0**; минимум репозитория — Node.js 22.13.
Пользовательский пакет поддерживает Node.js 22+.

```bash
corepack enable
pnpm install --frozen-lockfile
pnpm run dev
```

Состав workspaces задаёт `pnpm-workspace.yaml`, зависимости фиксирует общий lockfile.
Внутренние зависимости объявлены как `workspace:*`, импорты проходят через `exports`.
Установка выполняется явно; запуск скриптов не устанавливает зависимости автоматически.

Для агентской разработки установите четыре внешних скилла из `skills-lock.json`:

```bash
pnpm run skills:install
```

Команда использует закреплённый `npx skills@1.5.26` (Node.js 22.20+, рекомендуется 24).
Весь каталог проектных копий `.agents/skills` исключён из Git без исключений.
Исходники продуктового скилла находятся в `packages/relay-skill/src`, готовый пакет — в `skills/relay`.
Сборка: `pnpm run skills:build`; проверка актуальности: `pnpm run skills:check`.
Подробности — [устройство и установка скиллов](development/SKILLS.md).

## Запуск

- Vite: http://127.0.0.1:5173.
- API: http://127.0.0.1:4700/api/v1/health.
- Swagger: http://127.0.0.1:4700/api/docs.

`dev` запускает API и Web через Turbo; `dev:server` — только API. Без `RELAY_CONFIG`
оба используют `apps/playground/relay.workspace.json` с кофейней и P2P-арендой.
Два пустых демопроекта инициализируются командой `pnpm --filter @relay/playground run init`.
Для однопроектного режима кофейни явно передайте её конфиг через `RELAY_CONFIG`, как ниже;
подробности — в [README playground](../apps/playground/README.md).
Для проверки мутаций используйте отдельный временный проект с абсолютным `RELAY_CONFIG`.

```bash
pnpm run dev
RELAY_CONFIG=apps/playground/coffee-shop/.relay/config.json pnpm run dev
RELAY_PORT=3001 RELAY_API_URL=http://127.0.0.1:3001 RELAY_WEB_PORT=5174 pnpm run dev
```

Это независимые примеры запуска. `RELAY_ACTOR` определяет серверного автора.
Standalone-сервер по умолчанию использует `human` для дополнений из UI.
Рабочий продукт предназначен для оркестратора и субагентов на одном хосте.

CLI из исходников запускается отдельно, без Turbo-логов в stdout:

```bash
pnpm --silent run dev:cli --version
pnpm --silent run playground coffee-shop task list --limit 20 --format json
```

`playground` передаёт конфиг `apps/playground/relay.workspace.json`; запрос задач требует
запущенного workspace-сервера и возвращает одну страницу.
[Параметры выдачи и ограничения](reference/CLI.md).

`dev:cli` сохраняет рабочий каталог вызова. Условие `tasks-source` позволяет
CLI и backend использовать исходники библиотек через tsx. Web использует compiled
SDK; его dev-скрипт сначала собирает `@relay/rest-sdk`.

MCP запускается отдельным процессом, например:

```bash
pnpm run dev:mcp --server-url http://127.0.0.1:4700
```

`dev:mcp` сначала собирает зависимости, затем выполняет точку входа через tsx.
MCP обращается к уже запущенному Relay Server через SDK.
По умолчанию MCP слушает http://127.0.0.1:4710/mcp; `--config` принимает оба вида конфигов.

## Структура

| Workspace                                                         | Ответственность                                                      |
| ----------------------------------------------------------------- | -------------------------------------------------------------------- |
| [apps/cli](../apps/cli/README.md)                                 | Команды, выбор проекта, терминал и публикация                        |
| [apps/mcp](../apps/mcp/README.md)                                 | MCP-инструменты, общий Relay Server через HTTP и отдельный npm-пакет |
| [packages/project-runtime](../packages/project-runtime/README.md) | Реестр, разрешение конфигов, общий Backend для CLI/MCP               |
| [apps/server](../apps/server/README.md)                           | Standalone-точка входа и управление dev-процессом                    |
| [apps/web](../apps/web/README.md)                                 | React, Mantine, SWR, dnd-kit; профиль Unit Architecture              |
| [apps/playground](../apps/playground/README.md)                   | Демонстрационные данные и CLI-сценарии                               |
| [packages/core](../packages/core)                                 | Domain, application, файловое хранение и блокировки                  |
| [packages/contracts](../packages/contracts/README.md)             | Переносимые REST/SSE-контракты                                       |
| [packages/rest-sdk](../packages/rest-sdk/README.md)               | Сгенерированный ESM-клиент OpenAPI                                   |
| [packages/server-runtime](../packages/server-runtime/README.md)   | Общая NestJS/Fastify-реализация                                      |
| [packages/typescript-config](../packages/typescript-config)       | Общие строгие настройки Node-пакетов                                 |
| [packages/dev-agents](../packages/dev-agents/README.md)           | Профили и сборщик агентов разработки Relay                           |
| [packages/relay-skill](../packages/relay-skill/README.md)         | Источники и сборщик скилла для пользователей Relay                   |

Слои и инварианты описаны в [архитектуре](ARCHITECTURE.md).
Сервер использует Core, а не CLI. SDK используется CLI, MCP и web. Межпакетных
TypeScript project references и корневых алиасов исходников нет. Приложения и runtime-пакеты
собираются в свои `dist`; порядок задач задаёт Turbo.

`@relay/dev-agents` и `@relay/relay-skill` — private ESM workspace-пакеты с собственными
`build`, `check` и `test`. Источники и манифесты редактируются в их `src`, сборщики —
в соседних `scripts`. Первый пакет обслуживает разработку Relay, второй — продуктовые
инструкции для его пользователей. Нативные агентские конфигурации и `agents-lock.json`
остаются в корне, готовый скилл — в `skills/relay` и установленной копии Playground.
Корневой `AGENTS.md` — отдельный рукописный источник общих правил, не генерируемый выход.

## Команды

Из корня репозитория, аргументы скриптам — сразу после имени, без дополнительного `--`:

| Команда                                                              | Назначение                                                      |
| -------------------------------------------------------------------- | --------------------------------------------------------------- |
| `pnpm run dev` / `dev:app`                                           | API и web                                                       |
| `pnpm run dev:server`                                                | Backend с наблюдением за исходниками                            |
| `pnpm run dev:web` / `dev:ui`                                        | Vite; API запускается отдельно                                  |
| `pnpm --silent run dev:cli <args>`                                   | CLI из исходников                                               |
| `pnpm run dev:mcp <args>` / `start:mcp <args>`                       | Разработка / запуск собранного MCP                              |
| `pnpm run build:mcp` / `test:mcp`                                    | Сборка и интеграционные проверки MCP                            |
| `pnpm run package:check:mcp`                                         | Сборка независимого MCP npm-архива                              |
| `pnpm --silent run playground <args>`                                | CLI на демопроекте                                              |
| `pnpm run build`                                                     | Все workspaces                                                  |
| `pnpm run build:cli` / `build:server` / `build:web`                  | Выборочная сборка с зависимостями                               |
| `pnpm run build:core` / `build:contracts`                            | Сборка библиотек                                                |
| `pnpm start`                                                         | Сборка и запуск standalone-сервера с UI                         |
| `pnpm --silent run start:cli <args>`                                 | Собранный CLI после `build:cli`                                 |
| `pnpm run lint` / `typecheck`                                        | Проверки workspaces                                             |
| `pnpm test`                                                          | Все автоматизированные тесты с необходимыми сборками            |
| `pnpm run test:cli` / `test:server` / `test:core` / `test:contracts` | Выборочные тесты                                                |
| `pnpm run docs:check`                                                | Ссылки, файлы и якоря документации                              |
| `pnpm run agents:build` / `agents:check` / `agents:test`             | Задачи пакета `@relay/dev-agents` через `pnpm --filter`         |
| `pnpm run skills:build` / `skills:check` / `skills:test`             | Задачи пакета `@relay/relay-skill` через `pnpm --filter`        |
| `pnpm run format` / `format:check`                                   | Форматирование и его проверка                                   |
| `pnpm run check`                                                     | Документация, форматирование, lint, типы, сборки и тесты        |
| `pnpm run package:check`                                             | Три независимые npm-установки, local/workspace, API, Web и MCP  |
| `pnpm run clean`                                                     | Удаление результатов сборки workspaces с сохранением кеша Turbo |

Локальные инструменты доступны через `pnpm --filter <workspace> run <script>`.
Корневые команды компиляции через Turbo предварительно собирают необходимые зависимости.
Проверки генераторов `@relay/dev-agents` и `@relay/relay-skill` запускаются без `build`:
они обнаруживают расхождения, не восстанавливая выходы и не исправляя их молча.
Turbo-задачи генерации и проверки имеют `cache: false`, поскольку пишут или проверяют
выходы вне пакета; восстановление из кеша не должно обходить защиту владения выходами.
Установка внешних скиллов `pnpm run skills:install` остаётся отдельной командой.

## Проверки

Тесты расположены у владельцев: CLI — `apps/cli/test`, Core — `packages/core/test`,
API/SSE — `packages/server-runtime/test`, standalone/dev — `apps/server/test`.
MCP — `apps/mcp/test`, реестр и маршрутизация — `packages/project-runtime/test`.
Contracts проверяет совместимость типов с Core. CI запускает проверки на Node.js 22 и 24.

Для Web действуют знания [профиля frontend](../packages/dev-agents/src/frontend.md): Unit Architecture,
React Reference, генерация новых TSX, lint/typecheck/build и сценарии через изолированный
headless agent-browser. Автотесты frontend не добавляются по принятому решению.
Границы прежней приёмки — в [техническом покрытии](engineering/implementation/applications.md#границы-исторической-приёмки).

## Документация и поставка

Корневой `README.md` — витрина GitHub; README каждого публичного приложения входит в его npm-пакет. Пользовательская документация
принадлежит `docs`, README workspaces описывают их разработку.
Точные параметры должны соответствовать `CommandDefinition` и `--help`.
Проверка CLI сопоставляет справочник с зарегистрированными командами и параметрами.

`docs:check` разбирает Markdown и проверяет локальные ссылки, изображения и якоря,
включая заголовки с повторяющимися именами. Сеть для этой проверки не требуется.
При переносе страницы обновляйте внутренние ссылки и сохраняйте переход со старого адреса.

`package:check` готовит три независимых npm-архива: `@oim-dev/relay-cli`,
`@oim-dev/relay-server` и `@oim-dev/relay-mcp`, затем проверяет их установку через
`scripts/smoke-relay.mjs`. Упаковщик `scripts/package.mjs` создаёт staging в
`apps/<компонент>/.artifacts/package`, архивы — в `apps/<компонент>/.artifacts/npm`.

Каждый пакет содержит собранный JavaScript приложения и используемых workspace-библиотек,
манифест с внешними production-зависимостями и README соответствующего приложения.
Готовый Web (`dist/web`) входит только в Server. Состав документации задаёт `files`
в манифесте каждого приложения: объявленные CHANGELOG и документы должны попасть в `.tgz`.
Это проверяется по готовому архиву, а не только по манифесту. Ссылки npm-README ведут
на существующую ветку GitHub и не требуют соседнего checkout репозитория.

Команды `release:check`, `release:version`, `release:notes` и `release:publish` используют
общую цепочку `scripts/release/relay.mjs`. Публикуются подготовленные и проверенные `.tgz`
без повторной сборки.
[Добавление команды](development/EXTENDING.md) · [Релизный процесс](development/RELEASING.md).
