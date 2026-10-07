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
| Профиль, manifest, реестр переходов                      | `data-model-registry.test.ts`, `data-model-open.test.ts`, `historical-client.test.ts`                                                                            |
| Диагностика, план, backup, исполнение и сбои миграции    | `data-model-source.test.ts`, `data-model-executor.test.ts`, `data-model-backup.test.ts`, `data-model-crash.test.ts`                                              |
| Исторические переходы и замороженные базы                | `data-model-physical.test.ts`, `data-model-planning.test.ts`, `data-model-fixtures.test.ts`                                                                      |
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

## Следующая миграция данных

Механизм и действующие переходы описаны в [физическом хранении](FORMAT.md#миграция-и-обслуживание).
Любое несовместимое изменение постоянной схемы — новое или удалённое поле, иная форма
Markdown, новый, переименованный или упразднённый вид, перенос содержания между
владельцами — требует полного комплекта. Новая Zod-схема сама данные не мигрирует,
а подстановка default вместо перехода запрещена.

1. **Версия.** Повысьте `dataVersion` кодека владельца и добавьте в
   `storage/data-model/profiles.ts` новый замороженный профиль с полной картой владельцев;
   `CURRENT_DATA_MODEL` указывает на него. Прежние профили не меняются. Физический
   `schemaVersion` повышается только при изменении раскладки файлов, оболочки или WAL.
2. **Историческая схема.** До изменения текущей схемы скопируйте её дисковую форму в
   `storage/data-model/history/` строгим объектом без `.default()`, `.transform()`,
   `.catch()` и импорта изменяемых схем Contracts. В заголовке укажите SHA, команду
   `git show`, исходный файл и фикстуру; номер релиза — только если коммит помечен тегом.
3. **Переход.** Для изменения одной записи добавьте `record`-переход `N → N+1` с входной
   и выходной схемами; для объединения, разделения видов или изменения отношений —
   `snapshot`-переход. Зарегистрируйте его в `storage/data-model/transitions/index.ts`.
   ID стабилен (`[a-z0-9.-]`), новые технические ID — только `deterministicId`, время
   и авторы — из данных; неоднозначность — блокер с путём или ID. Движок, planner и
   обход не меняются: ветвлений по виду и semver в них быть не должно.
4. **Фикстура.** Сгенерируйте базу реальными операциями той версии, которая пишет старый
   формат, во временном worktree; положите её в `test/fixtures/data-migrations/` с
   `PROVENANCE.md`, `provenance.json` и независимым `oracle.json` по
   [правилам фикстур](../test/fixtures/data-migrations/README.md). Генерация старого
   входа текущими схемами совместимость не доказывает; существующие фикстуры не перегенерируются.
5. **Проверка цепочки.** Добавьте тест на фикстуре со сравнением с oracle, а не с выводом
   перехода, и проверьте цепочку от самого старого поддерживаемого входа до нового профиля,
   смешанные версии и `--dry-run` без изменения байтов. Запустите
   `data-model-registry.test.ts`, `data-model-fixtures.test.ts` и `pnpm run test:core`.
6. **Знания.** Обновите таблицы версий и правила перехода в [FORMAT](FORMAT.md), а
   при изменении наблюдаемого поведения — [предметный контракт](../../../docs/domain/STORAGE.md).

Целостность реестра проверяется автоматически. `productionTransitionRegistry()` строится
при первом обращении и отказывает `STORAGE_REGISTRY_INVALID` до работы с базой, а
`data-model-registry.test.ts` («Целостность поставки») требует, чтобы целевой профиль
совпадал с владельцами `workspaceStorageRegistry`: повышение `dataVersion` без профиля
и перехода падает в тестах. Выход последнего шага сверяется по JSON Schema с дисковой
схемой текущего кодека, поэтому тихое изменение текущей схемы без перехода тоже
обнаруживается. Синтетические профили и вид `note` для проверок движка находятся только
в `test/helpers/synthetic-data-model.ts`; фиктивных видов в производственный реестр
не добавляйте.

Сопровождение действующих переходов:

- Не меняйте опубликованный переход и его исторические схемы ради новой модели:
  новая модель получает собственный следующий шаг. Исправление дефекта перехода без
  изменения схем требует повышения `version` определения — оно меняет `registryDigest`
  и делает прежние отпечатки планов устаревшими.
- Незавершённый WAL миграции ссылается на `id@version` переходов. Переход, который
  может встретиться в WAL у пользователя, нельзя удалить или переименовать в той же поставке.
- Сужение поддержки старых раскладок или профилей — отдельное продуктовое решение
  с обновлением [STORAGE](../../../docs/domain/STORAGE.md), а не побочный эффект рефакторинга.
- Тесты переходов обязаны проходить на замороженных фикстурах; при изменении текущих
  кодеков сверка выходных схем укажет, где нужен новый шаг.

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
