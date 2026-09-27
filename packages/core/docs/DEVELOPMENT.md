# Разработка и проверки Core

Core — библиотека, отдельного dev-сервера у пакета нет. Для изменения выберите
[прикладной сервис](ARCHITECTURE.md) и механизм [хранения](FORMAT.md), затем запускайте
проверки по риску. Команды ниже выполняются из корня репозитория.

## Подготовка и исполнение

Требования корневого `package.json`: Node.js `>=22.13`, pnpm `>=11.18.0`;
`packageManager` фиксирует `pnpm@11.18.0`.

```sh
pnpm install --frozen-lockfile
pnpm run build:core
pnpm --filter @relay/core run typecheck
pnpm run test:core
```

`build:core` через Turbo собирает также зависимости. Пакетный `build` очищает свой
`dist` и запускает TypeScript. `test:core` через Turbo зависит от сборки; сам пакетный
тест запускает `node --conditions=tasks-source --import tsx --test test/*.test.ts`.
Типизация Core включает исходники, тесты, scripts и `test/contract-compatibility.ts`.
Отдельного lint-скрипта у пакета нет.

Адресный запуск без всего набора:

```sh
node --conditions=tasks-source --import tsx --test packages/core/test/entity-store.test.ts
node --conditions=tasks-source --import tsx --test packages/core/test/product-relations.test.ts
```

Это запуск исходников, не проверка собранного потребителя. Для local-интерфейса есть
`pnpm --silent run dev:cli --help`; подключение к проекту описано у
[Project runtime](../../project-runtime/docs/CONFIGURATION.md).
Для проверки через HTTP используйте [запуск Server](../../../apps/server/docs/USAGE.md),
а не отдельный тестовый контроллер, обходящий Core. Рабочие базы не нужны для unit-тестов;
миграцию и отказоустойчивость исследуйте только на выделенных копиях/фикстурах.

## Наборы по механизму

Пути ниже относительны `packages/core/test`. Название теста само по себе не означает,
что он доказывает прежние гарантии: assertions должны соответствовать текущему контракту.

| Изменение                                                | Наборы                                                                                                                                                           |
| -------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Общая запись, WAL, индексы, конкурентные изменения       | `entity-store.test.ts`, `unified-workspace.test.ts`, `storage-initialization.test.ts`                                                                            |
| Формат 4, удаление автоматического аудита, совместимость | `inline-storage.test.ts`, `storage-v3-migration.test.ts`, `migration-unified-sources.test.ts`, `legacy-write-guard.test.ts`, `orphan-planning-migration.test.ts` |
| Каталог, адреса, обработчики                             | `entity-engine.test.ts`, `product-keys.test.ts`                                                                                                                  |
| Предметные отношения и документный workflow              | `product-relations.test.ts`, `document-links.test.ts`, `document-library.test.ts`                                                                                |
| Каскад, ссылки планов, резервы адресов                   | `entity-deletion.test.ts`, `product-cascade.test.ts`, `product-scenario-cascade.test.ts`                                                                         |
| Граф, полный контекст, страницы                          | `entity-graph.test.ts`, `graph-storage.test.ts`                                                                                                                  |
| Канбан, критерии и комментарии                           | `boards.test.ts`, `board-tasks.test.ts`, `board-targets.test.ts`, `task-acceptance.test.ts`, `task-comments.test.ts`, `task-receipt-scope.test.ts`               |
| Планирование и выпуск                                    | `planning.test.ts`                                                                                                                                               |
| Прогресс и состав реализаций                             | `progress.test.ts`, `implementation-progress.test.ts`, `project-requirement-progress.test.ts`                                                                    |
| Границы пакетов и схем                                   | `architecture.test.ts`, `contract-compatibility.ts` (typecheck)                                                                                                  |

При изменении транзакционной логики существенны не только успешная запись, но и отказ
между предметным шагом и отношениями, повторный recovery, несовместимая внешняя правка,
чтение без частичного результата и сохранение WAL при конфликте. Проверяйте точные
Markdown-строки с CRLF, пробелами и завершающим переводом строки.

Повтор запроса тестируется как новое исполнение, не как возврат прежнего результата.
После потери ответа тест должен читать фактическое состояние. Не возвращайте
идемпотентные квитанции ради восстановления старых ожиданий теста.

Для алгоритмических изменений есть `pnpm run bench:graph` и `pnpm run bench:storage`.
Это отдельные нагрузочные сценарии, не обязательная часть правки документации
и не доказательство сквозной приёмки.

## Межпакетный контракт

При изменении переносимых схем выполните проверки [Contracts](../../contracts/README.md).
В зависимости от подключённых путей добавляются:

```sh
pnpm run test:server
pnpm run test:cli
pnpm run test:mcp
```

Server runtime проверяет типы в `test/contract-types.ts` и фактические ответы/OpenAPI
в `test/openapi.test.ts`. Экспорт спецификации — `pnpm run openapi:export`;
обновление клиента и его проверки принадлежат
[REST SDK](../../rest-sdk/docs/DEVELOPMENT.md). Успешная типизация Core не заменяет
runtime-валидацию ответа и пользовательский сценарий.

## Проверка только документации

Форматируйте адресно изменённые Markdown-файлы, не весь репозиторий:

```sh
pnpm exec prettier --check packages/core/README.md 'packages/core/docs/*.md'
git diff --check -- packages/core/README.md packages/core/docs
node --input-type=module -e 'import { checkDocumentation } from "./apps/cli/scripts/lib/documentation.mjs"; console.log(await checkDocumentation(process.cwd(), ["packages/core/README.md", "packages/core/docs/ARCHITECTURE.md", "packages/core/docs/FORMAT.md", "packages/core/docs/DEVELOPMENT.md"]));'
```

Helper проверяет существование относительных целей и Markdown-якорей; адресная проверка
полезна при локальном изменении. Штатная полная проверка `pnpm run docs:check` проверяет
ссылки общей и локальной документации, а также собранного скилла. Проверка npm-упаковки
в неё не входит.
