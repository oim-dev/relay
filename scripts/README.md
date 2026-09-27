# Разработка и инфраструктурные команды Relay

Здесь описаны подготовка монорепозитория, запуск текущих исходников и выбор проверок.
Установка опубликованного Relay описана в [пользовательском руководстве](../docs/guides/GETTING_STARTED.md),
а поставка самого Relay — в [процессе совместного выпуска](release/README.md).
Границы приложений и пакетов задаёт [архитектура](../docs/ARCHITECTURE.md).

## Окружение и зависимости

Используйте Node.js 24 — на нём выполняется текущий CI. Минимум корневого `engines`
— Node.js 22.13; это не утверждение о проверке всей разработки на Node.js 22.
Версию pnpm берите из `packageManager` корневого [package.json](../package.json)
(сейчас `pnpm@11.18.0`). Сначала подготовьте эту версию менеджера, затем из корня Relay:

```bash
node --version
pnpm --version
pnpm install --frozen-lockfile
```

Состав workspaces задаёт [pnpm-workspace.yaml](../pnpm-workspace.yaml), разрешённые
версии зависимостей — общий [pnpm-lock.yaml](../pnpm-lock.yaml). Запуск скриптов
не устанавливает зависимости автоматически. Ошибку frozen-lockfile исправляют
согласованным изменением манифеста и lockfile, а не отключением проверки в CI.

Внутренние зависимости объявляются через `workspace:*`; импорты используют exports
пакета. Условие `tasks-source` выбирает исходники там, где оно объявлено; обычные
exports ведут в `dist`. Поэтому успешный запуск через tsx не проверяет собранный пакет.
Общие настройки Node-пакетов принадлежат [typescript-config](../packages/typescript-config/README.md).
Порядок сборки задаёт [turbo.json](../turbo.json): зависимости строятся раньше
приложений, Server дополнительно собирает Web. Набор scripts различается у workspaces.

Для добавления зависимости выбирайте её потребителя, а не корень по умолчанию:

```bash
pnpm --filter <workspace> add <package>
pnpm --filter <workspace> add -D <package>
```

Выберите только нужную команду: runtime-зависимость или инструмент разработки.
Проверьте diff манифеста и lockfile, затем сборку и проверки потребителей.
Для упаковки важны именно production-зависимости: приватный runtime включается
в bundle, внешние зависимости остаются в npm-манифесте.

## Запуск из корня репозитория

```bash
pnpm run dev
```

Команда запускает Server и Web. Без `RELAY_CONFIG` выбирается
`apps/playground/relay.workspace.json`; подготовка и сохранность его данных описаны
в [Playground](../apps/playground/README.md). Явное окружение:

```bash
RELAY_CONFIG=apps/playground/relay.workspace.json pnpm run dev
```

Относительный `RELAY_CONFIG` разрешается относительно `INIT_CWD` или текущего каталога
до перехода в workspace. Для изолированного тестового проекта удобен абсолютный путь.
Не используйте пользовательские демоданные для непорученных проверок записи.

По умолчанию Web доступен на <http://127.0.0.1:5173>, Server —
<http://127.0.0.1:4700>, health — <http://127.0.0.1:4700/api/v1/health>.
Параметры процессов описаны у [Server](../apps/server/README.md)
и [Web](../apps/web/README.md). Для другого порта меняйте согласованно API и его клиент:

```bash
RELAY_PORT=3001 RELAY_API_URL=http://127.0.0.1:3001 RELAY_WEB_PORT=5174 pnpm run dev
```

Это альтернативный запуск, не второй сервер поверх уже работающего окружения.

| Команда                               | Действие                                                         |
| ------------------------------------- | ---------------------------------------------------------------- |
| `pnpm run dev:server`                 | Только Server с наблюдением за исходниками                       |
| `pnpm run dev:web`                    | Только Web; его dev-скрипт готовит SDK, API запускается отдельно |
| `pnpm --silent run dev:cli <args>`    | CLI из исходников с сохранением каталога вызова                  |
| `pnpm --silent run playground <args>` | CLI с явным конфигом Playground                                  |
| `pnpm run dev:mcp <args>`             | Сборка MCP и зависимостей, затем запуск точки входа через tsx    |
| `pnpm run start`                      | Сборка и запуск Server с Web                                     |
| `pnpm --silent run start:cli <args>`  | Собранный CLI; предварительно нужен `build:cli`                  |
| `pnpm run start:mcp <args>`           | Собранный MCP; предварительно нужен `build:mcp`                  |

Аргументы `pnpm run` передавайте сразу после имени script, без дополнительного `--`.
`--silent` убирает сообщения pnpm из машинного вывода CLI. MCP требует отдельно
запущенного Server и подключения клиента: подробности у [MCP](../apps/mcp/README.md).
`dev:app` — алиас `dev`, `dev:ui` — алиас `dev:web`.

## Сборка и проверки

| Команда                                                                           | Что проверяет или создаёт                                                       |
| --------------------------------------------------------------------------------- | ------------------------------------------------------------------------------- |
| `pnpm run build`                                                                  | Общую версию выпуска и сборку workspaces                                        |
| `pnpm run build:cli` / `build:server` / `build:mcp` / `build:web`                 | Выбранное приложение с зависимостями                                            |
| `pnpm run build:core` / `build:contracts`                                         | Выбранную библиотеку                                                            |
| `pnpm run lint` / `typecheck` / `test`                                            | Соответствующие Turbo-задачи workspaces с необходимыми сборками                 |
| `pnpm run test:cli` / `test:mcp` / `test:server` / `test:core` / `test:contracts` | Адресные тесты; `test:server` включает server-runtime                           |
| `pnpm run lint:web` / `typecheck:web`                                             | Адресные проверки Web                                                           |
| `pnpm run format:check`                                                           | Форматирование без записи                                                       |
| `pnpm run docs:check`                                                             | Локальные ссылки, изображения и якоря Markdown, без запросов в сеть             |
| `pnpm run check`                                                                  | Версию, release-тесты, формат, agents/skills, документацию, lint, типы и тесты  |
| `pnpm run package:check`                                                          | Архивы трёх приложений и независимые установочные сценарии                      |
| `pnpm run clean`                                                                  | Очистку результатов сборки через scripts workspaces; не сброс данных Playground |

Для полной проверки сохранённых результатов генерации сначала выполните
`agents:check` и `skills:check`, затем `build` и `check`: сборка не должна скрывать drift.
Этот порядок использует [CI](../.github/workflows/ci.yml) на Node.js 24.
Проверка отдельной области не требует всех тяжёлых сценариев: выбирайте затронутых
потребителей и различайте типизацию, запуск исходников, собранный бинарник и npm-установку.

`pnpm run format` переписывает весь репозиторий. Для локальной правки используйте
адресные `pnpm exec prettier --check <path>` и, если требуется, `--write <path>`.
Завершайте проверкой `git diff --check`. Правила содержания и размещения страниц —
в [документации](../docs/DOCUMENTATION.md).

Для проверки выбранных Markdown без общего обхода доступен helper:

```bash
node --input-type=module -e 'import { checkDocumentation } from "./apps/cli/scripts/lib/documentation.mjs"; console.log(await checkDocumentation(process.cwd(), ["scripts/README.md", "scripts/release/README.md"]));'
```

Текущий общий обход `documentationFiles` охватывает `docs`, корневой README,
страницы приложений и пакетов, но не каталог `scripts`. Его страницы проверяйте
явным списком, пока охват общего checker не расширен.

## Генераторы и отдельные инструменты

Здесь только точки запуска; источники, формат выходов и восстановление принадлежат
документации соответствующих пакетов.

| Команды                                                         | Владелец                                                                                                                |
| --------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------- |
| `agents:build`, `agents:check`, `agents:test`                   | [Профили агентов разработки](../packages/dev-agents/README.md)                                                          |
| `skills:build`, `skills:check`, `skills:test`, `skills:install` | [Пользовательский скилл и его окружение](../packages/relay-skill/README.md)                                             |
| `pnpm --filter @relay/rest-sdk run generate`                    | [REST SDK](../packages/rest-sdk/README.md); сначала выполняется `openapi:export`                                        |
| `pnpm run openapi:export`                                       | [Экспорт OpenAPI](export-openapi.mts): временная база, inject без слушающего порта, результат `.artifacts/openapi.json` |
| `pnpm run bench:graph` / `bench:storage`                        | Отдельные измерения [Core](../packages/core/README.md), не обязательный шаг обычной проверки                            |

## Если команда не работает

- Нет зависимости или исполняемого инструмента: сверьте Node/pnpm и завершите
  `pnpm install --frozen-lockfile`, не рассчитывайте на автоустановку при запуске.
- Не найден `dist`: используйте корневую Turbo-сборку потребителя; прямой запуск
  `tsc` или бинарника не строит весь граф зависимостей.
- CLI не получает ответ: проверьте health, конфиг и режим Server; локальная команда
  и HTTP-клиент — разные сценарии. Не перезапускайте чужой процесс ради проверки.
- Генератор сообщает drift: исправьте источник и выполните процесс его владельца,
  не редактируйте готовый результат ради зелёного check.
- Упаковка или независимая установка падает: используйте диагностику
  [совместного выпуска](release/README.md), не публикуйте архив как способ проверить его.
