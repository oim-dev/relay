# REST API Relay

Канонический справочник HTTP-интерфейса: как выбрать проект, вызвать действие,
прочитать результат и продолжить работу после ошибки. Предметные правила принадлежат
[Core и доменным контрактам](../../../docs/domain/README.md), покрытие интерфейсов —
[матрице возможностей](../../../docs/CAPABILITIES.md). Server не повторяет бизнес-логику
и не запускает агентов, проверки или развёртывание при сохранении данных.

## Содержание

- [Адреса и OpenAPI](#адреса-и-openapi)
- [Запрос и результат](#запрос-и-результат)
- [Сервер, проект и проверка](#сервер-проект-и-проверка)
- [Сущности и удаление](#общие-сущности-адреса-и-удаление)
- [Продукт и документы](#продукт-реализации-и-документы)
- [Доски и задачи](#доски-задачи-критерии-и-комментарии)
- [Планы](#планы-и-этапы) и [релизы](#релизы)
- [История работы агентов](#история-работы-агентов)
- [Прогресс](#прогресс)
- [Граф и контекст](#граф-и-контекст)
- [Страницы и полнота](#страницы-и-полнота)
- [SSE](#sse)
- [Ошибки и исправление](#ошибки-и-исправление)

## Адреса и OpenAPI

Сначала [запустите Server](../../../apps/server/docs/USAGE.md) и используйте его
фактический origin. Ниже пути указаны относительно `/api/v1`.

- Local: `/api/v1/<операция>` либо `/api/v1/projects/:project/<операция>`.
- Workspace: только `/api/v1/projects/:project/<операция>` для проектных действий,
  даже при одной регистрации. Короткий адрес не выбирает проект автоматически.
- `/health`, `/server`, `/projects` и операции регистрации остаются на корне `/api/v1`.
- `:project` — ID, ключ регистрации или slug, не отображаемое имя. Различия и
  закрепление клиента по ID описаны в [CONFIGURATION](../../project-runtime/docs/CONFIGURATION.md).
- `:reference` — ключ/алиас или постоянный ID сущности в выбранном проекте;
  `:stage`, `:criterionId`, `:entryId` — локальные адреса вложенных записей.
  Значения сегментов пути и query нужно URL-кодировать.

Swagger доступен по `/api/docs`, машинная OpenAPI 3.1 — по `/api/openapi.json`.
В Swagger выберите проект перед выполнением запросов. В спецификации scoped-копии
операций имеют суффикс `ForProject`; тело и предметный результат совпадают с local.
Имена схем в таблицах ниже позволяют найти точные поля, вложенные варианты и defaults
в `components.schemas` без второй ручной копии OpenAPI. Для установленной версии
используйте спецификацию именно её сервера.

## Запрос и результат

JSON-операции возвращают `{ "ok": true, "data": ... }`. Ошибка имеет форму:

```json
{
  "ok": false,
  "error": {
    "code": "REVISION_CONFLICT",
    "message": "Запись изменена другим участником",
    "exitCode": 4
  }
}
```

`exitCode` и `details` необязательны. Не считайте пустой список эквивалентом ошибки
чтения. POST предметных операций возвращает 200, а не обязательно 201.
SSE — отдельный поток, не JSON-конверт успешного ответа.

Для POST/PUT/PATCH нужен `Content-Type: application/json`; лимит тела — 1 МиБ.
API отдаётся с `Cache-Control: no-store`. Listener — loopback; разрешены локальные Host,
тот же Origin и явно разрешённые dev-origin. Произвольный cross-site доступ отклоняется.
Это не механизм пользовательской аутентификации. Неизвестный API не возвращает SPA HTML.

Основные Markdown-поля передаются **строками**, без преобразования в дисковые массивы.
Названия однострочные, краткие описания — обычный многострочный текст. Для обновления
отсутствующее поле, `null`, пустая строка и `[]` различаются: строгая схема конкретной
операции определяет допустимые значения. Не отправляйте целую карточку ответа как patch.

В схемах записи `actor` задаёт автора, иначе используется автор сервера; публикация
комментария имеет собственный обязательный контракт автора/роли. `ifRevision` —
прочитанная ревизия, `ifVersion` — версия соответствующего составного чтения, где она
предусмотрена. `requestId` служит только корреляции. Дедупликации, сохранённого ответа
для повторной отправки и постоянной истории запросов нет. **Автоматически повторять
записи нельзя.** При потере ответа сначала перечитайте состояние и связанные записи.
Для конфликта перечитайте и согласуйте ввод, а не подставляйте новую ревизию к старому телу.

## Сервер, проект и проверка

| Метод и путь                             | Действие и схема                                                                                       |
| ---------------------------------------- | ------------------------------------------------------------------------------------------------------ |
| `GET /health`                            | Доступность API (`HealthResponse`), не проверка всей базы                                              |
| `GET /server`                            | Режим, конфиг, defaultProject, регистрации (`ServerContextResponse`)                                   |
| `GET /server/capabilities`               | Возможности каталога без чтения проектных баз (`ServerCapabilities`)                                   |
| `GET /projects`                          | Тот же каталог регистраций с доступностью каждой базы                                                  |
| `GET /projects/page`                     | Серверная страница; `ProjectCatalogPageQuery` → `ProjectCatalogPage`                                   |
| `PUT /projects/:project`                 | Регистрация по **ключу реестра**: `RegisterProjectRequest` с `path`/`config`, необязательным `replace` |
| `DELETE /projects/:project`              | Удалить регистрацию по ключу, сохранить файлы базы                                                     |
| `PUT /projects/:project/registration`    | Регистрация с `RegisterProjectRequest` → `ProjectRegistrationReceipt`, без полного каталога            |
| `DELETE /projects/:project/registration` | Удаление регистрации → `ProjectUnregistrationReceipt`, без полного каталога                            |
| `GET /context`                           | `ContextResponse`: projectId, capability, конфиг, пути, автор                                          |
| `GET /context/settings`                  | Имя, slug и ревизия (`ProjectSettings`)                                                                |
| `PUT /context/settings`                  | Сохранить имя и slug с `ifRevision` (`SaveProjectSettings`)                                            |
| `GET /validation`                        | Проверить целостность выбранного проекта (`ValidationData`)                                            |

Регистрация и её удаление доступны в workspace. `/context` — подключение, не граф
и не подборка знаний продукта. Настройки не заменяют реестр. Разделы библиотеки
меняются через `POST /documents/sections` либо `entities.update` вида `project`,
не через `PUT /context/settings`.

`/server` и `/projects` возвращают весь каталог без выбора проекта и без серверной
пагинации, в том числе в local-режиме. Пути ответа относятся к серверу. `path` и
`config` регистрации также разрешаются на сервере: относительно его реестра, а при
передаче обоих `config` — относительно `path`. Клиентский каталог их не переопределяет.
Ответ проверяется runtime-схемой каталога, не только TypeScript-типом;
невалидный успешный ответ не означает пустой workspace. После неопределённого ответа
на регистрацию или удаление сначала прочитайте `/projects`.

### Серверные страницы и адресные квитанции

`GET /server/capabilities` (operationId `getServerCapabilities`) возвращает
`{capabilities: ["relay-project-catalog-v1"]}` внутри обычного конверта success.
Операция не читает каталог и не открывает проектные базы; поэтому discovery работает
до выбора проекта. Это перечень возможностей **серверного каталога**, не замена
проектного `/context`. Последний также объявляет capability каталога и предметные
`relay-product-queries-v1`, `relay-work-read-models-v1`, `relay-release-refs-v1`,
`relay-entity-search-v2`, `relay-work-history-v1`, `relay-work-history-graph-v2`.

`GET /projects/page` (`getProjectCatalogPage`) принимает offset (default 0), limit
(1–100, default 20) и optional version. Ответ: `catalog`, `total`, `nextOffset`,
`version`. В catalog сохранены режим Server, его configPath и defaultProject,
но projects содержит только выбранную страницу. Total включает недоступные регистрации;
null nextOffset означает конец. Для продолжения передайте исходную version и тот же
сервер. Guard проверяет весь текущий каталог: регистрации, доступность, идентичность
и отображаемые сведения. `VERSION_CONFLICT` (HTTP 409, exit 4) требует начать заново
без версии; исторического снимка нет. Без version читается текущее состояние.
Сервер проверяет весь каталог перед выделением страницы: уменьшается передаваемый
DTO, но стоимость чтения доступности не становится O(limit).

`PUT /projects/:project/registration` (`registerProjectCompact`) принимает прежний
RegisterProjectRequest. Ответ подтверждает сохранение одной регистрации:
`action: register`, `key`, серверный `configPath`, `entry` с сохранёнными path/config.
Это не полный каталог и не подтверждение текущей доступности базы; проверьте страницу
каталога или подключение к выбранному проекту.

`DELETE /projects/:project/registration` (`unregisterProjectCompact`) возвращает
`action: unregister`, `key`, серверный `configPath` и `removed`: true — удалено этой
операцией, false — регистрация уже отсутствовала. Файлы базы сохраняются.
В обоих адресах :project — **ключ регистрации**, не ID базы или slug; запись доступна
только в workspace. После неопределённого ответа сначала перечитайте каталог, не
повторяйте мутацию автоматически. Прежние PUT/DELETE без `/registration` продолжают
возвращать полный ServerContextResponse.

Все четыре маршрута остаются на корне `/api/v1`, без scoped-копий `ForProject`.
Для клиента они составляют возможность `relay-project-catalog-v1`; отсутствие её
в discovery не разрешает выдавать старый полный маршрут за серверную страницу.

### Доступность выбранной базы

Конфигурационные `GET /context` и `GET /context/settings`, включая scoped-адреса,
не создают отсутствующие legacy-каталоги данных и runtime. Они сохраняют актуальную
проекцию PROJECT, проверки совместимости и штатное восстановление обычного WAL;
незавершённая миграция не исполняется. Это гарантия самого запроса: запуск Server
и фоновые наблюдатели имеют отдельный жизненный цикл и могут подготовить каталоги
до запроса. Остальные предметные операции не переводятся в режим запрета записи.

Несовместимая или повреждённая база не становится пустым или отсутствующим проектом.
В каталоге (`GET /server`, `/projects` или `/projects/page`) она остаётся с
`available: false` и `error` вида `КОД: сообщение`. База, которой нужна миграция,
помечается так по manifest без обхода записей; legacy-база без `storage.json` этим
способом не помечается и получает код при первом проектном запросе. Выбор по ключу
реестра или постоянному ID возвращает причину Core (например, 409
`STORAGE_MIGRATION_REQUIRED`), не `VALIDATION_ERROR` или `PROJECT_NOT_FOUND`.
Ошибка совместимости имеет одинаковые 409 и `details` для чтения и мутаций; `details.next`
содержит команду вида `npx @oim-dev/relay-cli --local --config <config> storage …`.
Local-сервер на такой базе стартует, если текущая схема конфигурации читается, и отвечает
кодом на каждый проектный запрос; после внешнего обслуживания проект доступен без
перезапуска. Конфигурация вне текущей схемы останавливает запуск ошибкой с details.

## Общие сущности, адреса и удаление

Правила: [адреса и контекст](../../../docs/domain/CONTEXT.md),
[удаление](../../../docs/domain/STORAGE.md).

| Метод и путь                     | Действие; вход → данные ответа                                                       |
| -------------------------------- | ------------------------------------------------------------------------------------ |
| `GET /entities/types`            | Каталог видов и возможностей; `EntityPageQuery` → `EntityTypes`                      |
| `GET /entities/type`             | Поля, фильтры и схемы действий одного `kind`; `EntityTypeQuery` → `EntityTypeDetail` |
| `GET /entities`                  | Карточки и поиск; `EntitiesQuery` → `EntitiesPage`                                   |
| `GET /entities/get`              | Полное содержание; `EntityGetQuery` (`ref`, необязательный `kind`) → `EntityDetail`  |
| `GET /entities/resolve`          | Текущий ключ/алиас/ID → краткая карточка `EntitySummary`                             |
| `GET /entities/keys`             | Текущий ключ и алиасы; `EntityKeysQuery` → `EntityKeysPage`                          |
| `GET /entities/key-spaces`       | Пространства нумерации вида; `EntityKeySpacesQuery` → `EntityKeySpaces`              |
| `POST /entities`                 | Создать; `CreateEntity` → `EntitySaved`                                              |
| `POST /entities/update`          | Изменить; `UpdateEntity` → `EntitySaved`                                             |
| `POST /entities/rename`          | Изменить ключ без смены ID; `RenameEntity` → `EntitySaved`                           |
| `POST /entities/move-task`       | Перемещение задачи по публичным адресам; `MoveEntityTask` → `EntitySaved`            |
| `POST /entities/link-task`       | Предметная связь задач; `LinkEntityTask` → `EntitySaved`                             |
| `GET /entities/deletion-preview` | Полный каскад; `EntityDeletionQuery` → `EntityDeletionPreview`                       |
| `POST /entities/delete`          | Подтвердить каскад; `DeleteEntity` → `EntityDeleted`                                 |

Чтение поддерживает одиннадцать основных видов, но создание — только `product`,
`feature`, `scenario`, `application`, `implementation`, `task`, `document`.
Планы/релизы создаются предметными операциями ниже; произвольные доски — не generic create.
В create передаются `data.kind` и поля варианта, в update — `ref`, `ifRevision`,
`changes.kind` и только изменяемые поля; также метаданные запроса.
Для `project` update доступны `name` и `documentSections`, но не slug.

`EntitiesQuery` предлагает `kind`, `q`, `refs`, фильтры доски/приложения/фичи/сценария/
цели/родителя, состояния и активности. `refs` сериализуется повторяющимися query-ключами.
Пример полного чтения: `GET /entities/get?ref=FEATURE-1&kind=feature`.

`EntityDetail.metadata` — необязательный блок сохранённых `createdAt`, `createdBy`,
`updatedAt`, `updatedBy` из той же записи и ревизии. Если блок есть, обязательны все
четыре поля. Текущий Server возвращает его для документов и продуктовых видов;
у FI/SI это собственные метаданные реализации, не scope. Отсутствие блока
не означает отсутствие записи. Клиент принимает прежний ответ без блока, но не подставляет автора сервера
или текущее время. Краткая карточка `EntitySummary` этим блоком не дополняется.
Старый клиент со строгой схемой без `metadata` может отвергнуть новый ответ;
Server, SDK и потребители обновляются согласованно. Обратная совместимость здесь
означает только чтение старого ответа новым клиентом.

Общий поиск включает явные description/body/goal/version и адреса/названия владельца
и цели FI/SI, но не комментарии, критерии или вложенные этапы. `implementationTarget`
принимает feature (FI) или scenario (SI). Active/implementationTarget исключают
не-реализации, section/documentKind/pinned — не-документы даже без kind.
Optional `EntitySummary.updatedAt` — дата самой записи, `implementation` — её тип
FI/SI и компактные application/target. `sort=updated` ставит неизвестные даты последними.
Общий guard `entities-v2` требует начать прежние страницы заново, документный
`documents-v1` сохранён. `EntityDetail.savedStatus` отдельно раскрывает сохранённую
отметку реализации, не заменяя вычисляемую готовность. Полнотекстового индекса и
гарантии O(limit) чтения эта проекция не предоставляет.

При непустом q optional `EntitySummary.match` содержит одно подтверждённое основание
`{field,text,truncated}`. Text ограничен 240 единицами UTF-16 исходного поля вокруг
совпадения, без добавленного выделения; truncated относится только к этому фрагменту.
Предпочтение текущему ключу и названию не означает отсутствия совпадений в других
полях. Прежний document.excerpt сохраняется; отсутствие match не разрешает угадывать
основание. Поля и точная форма — в [Contracts](../../contracts/docs/API.md).

HTTP Backend требует capability `relay-entity-search-v2` при implementationTarget;
при q или sort=updated вне явного kind=document; при active/section без kind. Сам маршрут
`GET /entities` сохраняется; отсутствие capability даёт `SERVER_INCOMPATIBLE` до поиска,
не ответ прежней семантики и не local fallback. Optional-поля допускают чтение старого
ответа новым parser, но не обещают совместимости нового ответа со старым строгим parser.

Удаление требует `ref` и `kind` одного из шести удаляемых видов. Сначала прочитайте
`deleted`, `detached`, `relations`, `version`; затем передайте ту же цель,
`ifVersion` и `requestId`. Предпросмотр не усечён: максимум по 1000 удаляемых и сохраняемых
затронутых записей, иначе ошибка. Изменение состояния требует нового предпросмотра.
`PLANNING_REFERENCE_IN_USE` блокирует каскад при ссылках любого плана, включая закрытый.
Общий Backend предоставляет `deletion.preview` и `deletion.delete` с тем же полным
предпросмотром и исходной версией подтверждения. Подключение команд и инструментов
отмечено отдельно в [матрице возможностей](../../../docs/CAPABILITIES.md).

## Продукт, реализации и документы

Правила: [продукт](../../../docs/domain/PRODUCT.md),
[библиотека документов](../../../docs/domain/DOCUMENTS.md).

| Метод и путь                            | Действие; вход → данные ответа                                                                       |
| --------------------------------------- | ---------------------------------------------------------------------------------------------------- |
| `GET /product/state`                    | Полное согласованное состояние и готовность → `ProductState`                                         |
| `GET /product/overview`                 | Обзор: карта продукта и согласованный срез проекта → `ProductOverview`                               |
| `GET /product/overview/metrics/:metric` | Страница метрики оператора; `ProductOverviewMetricPageQuery` → `ProductOverviewMetricPage`           |
| `GET /product/validate`                 | Проверка без передачи текстов → `ProductValidation`                                                  |
| `GET /product/lint`                     | Адресуемые рекомендации; `ProductLintQuery` → `ProductLintPage`                                      |
| `GET /product/overview/map`             | Отдельная карта; `ProductOverviewMapQuery` → `ProductOverviewMapPage`                                |
| `GET /product/participation`            | Компактный состав; `ProductParticipationQuery` → `ProductParticipationPage`                          |
| `POST /product/participation`           | Атомарный выбор прежних и новых вкладов; `ProductParticipationReplace` → `ProductParticipationSaved` |
| `GET /product/implementation`           | Полный вклад по ref с savedStatus → `ProductImplementationDetail`                                    |
| `GET /product/records`                  | Поиск записей; `ProductListQuery` → `ProductList`                                                    |
| `GET /product/entities`                 | Карточки целей и реализаций; `ProductEntitiesQuery` → `ProductEntities`                              |
| `GET /product/entity`                   | Одна продуктовая сущность с полным содержанием по `ref` → `ProductEntity`                            |
| `GET /product/context`                  | Предметная подборка по `id`/`applicationId`; `ProductContextQuery` → `ProductContext`                |
| `POST /product/records`                 | Создать/изменить запись; `ProductMutation` → `ProductSaved`                                          |
| `POST /product/implementations`         | Изменить отдельную реализацию по её ревизии; `UpdateImplementation` → `ProductSaved`                 |

`ProductMutation` содержит `action=create|update`, вариант `fields`, идентификатор
обновляемой записи, проверку ревизии/версии согласно действию и метаданные запроса.
Варианты `fields.kind` охватывают паспорт, фичу, сценарий, приложение, состав `scope`,
отдельную реализацию `implementation`, совместимый `contract` и документ.
`implementation` в `POST /product/records` допускает только `action=create`: добавляет
одну реализацию, сохраняя остальные вклады приложения. Для изменения отдельной реализации
по её собственной ревизии используйте `POST /product/implementations`.
`GET /product/entity` читает также паспорт и документ, не только требования и реализации.
`scope` заменяет выбранный состав одного приложения,
а не отдельное диагностическое ребро; снятые реализации сохраняют адреса.
Совместимые ручные отметки `status` не переопределяют вычисляемую готовность.

Новые validate/lint/map/participation/implementation не меняют прежние full DTO.
Для HTTP Backend они требуют `relay-product-queries-v1` в `/context`: без объявления
возможности клиент возвращает `SERVER_INCOMPATIBLE`, не обходит маршрут полным state.
Формы, публичные адреса и технический scope описаны в
[Contracts](../../contracts/docs/API.md#продуктовые-чтения-и-замена-состава).
Карта принимает `version` исходного `snapshotVersion` обзора; participation — guard
своей страницы, а lint — продуктовую версию. Конфликт — `VERSION_CONFLICT`, HTTP 409,
exit 4; чтение начинают заново. Для замены состава нужны исходные revision и **version**
продукта, не snapshotVersion; после ответа перечитайте participation и новые реализации.
Ошибка или потеря ответа не разрешает автоматический повтор записи.

`GET /product/overview` (scoped: `GET /projects/:project/product/overview`,
operationId `getProductOverview` / `getProductOverviewForProject`) не принимает
query-параметров. Смысл показателей, подборок и версий задан в
[обзоре продукта](../../../docs/domain/PRODUCT.md#обзор-состояния-продукта).
Ответ `ProductOverview`:

- `productId`, `version`, `items`, `readiness` — прежняя карта. `items` содержит все
  записи продукта без полных текстов и без страниц; `version` — версия продуктового
  состава, которую не меняют задачи, планы и релизы;
- `snapshotVersion` — sha256 всех данных среза; не зависит от `generatedAt`;
- `generatedAt` — время формирования ответа;
- `snapshot` — `project`, `passport` (`state`: `missing`, `filled` или `no-summary`
  с `excerpt`), `knowledge`, `boards`, `tasks`, `attention`, `documents`, `plans`,
  `releases`, `operator`. Подборки имеют форму `{total, shown, hasMore, items}`,
  `items` — не более 5. `operator` — метрики оператора M-01…M-06 (очередь проверки,
  влияние блокеров, работа вне планов, доски, планы и подготовка выпуска).

Все части ответа читаются одним согласованным чтением Core без записи. Ошибка любого
источника возвращается ошибкой запроса, а не нулевыми счётчиками. Ответ не версионирует
продолжение: клиент, который листает `items` частями, сам сравнивает `snapshotVersion`
первого и повторного чтения. Local и scoped-путь возвращают одинаковый результат.

`ProductOverview` дополнен обязательными полями `snapshotVersion`, `generatedAt`, `snapshot`
и `snapshot.operator`. Для клиентов со строгой проверкой ответа это согласованное
несовместимое изменение: Server, CLI, MCP и Web выпускаются и обновляются одной версией
монорепозитория. Прежний клиент на новом сервере получает `INVALID_SERVER_RESPONSE`.
Если HTTP Backend CLI/MCP получает обзор прежнего сервера без `snapshot` или без
`snapshot.operator`, он возвращает `SERVER_INCOMPATIBLE` (exit 5) с просьбой обновить
и перезапустить Relay Server той же версии.

### Детализация метрик оператора

`GET /product/overview/metrics/:metric` (scoped:
`GET /projects/:project/product/overview/metrics/:metric`, operationId
`getProductOverviewMetric` / `getProductOverviewMetricForProject`) возвращает страницу
полной выборки той же классификации, что и подборки `snapshot.operator`. Сервер
объявляет её возможностью `relay-overview-metrics-v1` в `GET /context`; клиент проверяет
её до вызова и без неё сообщает `SERVER_INCOMPATIBLE`, а не 404 маршрута.

`:metric` — `ProductOverviewMetric`: `review-obligations-met`, `review-obligations-open`,
`blocker-impact`, `blocker-affected`, `unplanned-work`, `board-work`,
`open-plans-complete`, `ready-releases`, `plans-outside-releases`. Query
`ProductOverviewMetricPageQuery`:

- `limit` — 1…100, по умолчанию 20;
- `cursor` — `nextCursor` предыдущей страницы без изменений;
- `version` — `snapshotVersion` отображаемого обзора, чтобы первая страница не
  смешивалась с другим срезом;
- `blocker` — ID или ключ задачи-блокера: обязателен для `blocker-affected` и запрещён
  для остальных метрик.

Ответ `ProductOverviewMetricPage` — вариант по `metric` с полями `blocker` (адрес
блокера либо `null`), `snapshotVersion`, `generatedAt`, `total`, `items` в порядке
метрики и `nextCursor` (`null` в конце). Пустая выборка — обычный ответ с `total: 0`;
блокер, который больше ничего не задерживает, тоже даёт `total: 0`. В пустом проекте
`board-work` перечисляет системные доски с нулевой работой.

Продолжение защищено версией полного среза, а не продуктовой `version`. Курсор связан
с проектом, метрикой и блокером. Если между страницами изменились задачи, этапы, планы,
релизы, доски, документы или продукт либо `version` не совпадает с текущим срезом,
ответ — `VERSION_CONFLICT` (409, exit 4): перечитайте обзор и начните детализацию
с первой страницы. Ошибки: `UNKNOWN_METRIC` и `INVALID_ARGUMENT` (неуместный или
отсутствующий `blocker`) — 400, `VALIDATION_ERROR` для неверного query, `INVALID_CURSOR`
для чужого или повреждённого курсора — 400, `NOT_FOUND` для несуществующего блокера — 404.

Актуальность обзора поддерживается [SSE](#sse): событие только сообщает об изменении,
источником данных остаётся повторный `GET /product/overview`. Воспроизведения пропущенных
событий нет; после переподключения обзор перечитывают целиком.

Содержание документа создавайте/меняйте через generic
entities или `product/records`, читайте полное содержание через `entities/get`.
Для библиотеки используйте `GET /entities?kind=document` с `section`, `documentKind`,
`status`, `pinned`, `archived`, `q`, `sort`. `section=none` — без раздела.
Ответ может содержать `libraryCounts`, а не только видимую страницу.
Версия каталога документов имеет вид `documents-v1:<sha256>` и защищает текущие
корни индекса, без чтения всех тел документов. Старое продолжение с прежней версией
отклоняется с `ENTITIES_CHANGED`: начните каталог с первой страницы.

`documentStatus`, `pinned`, `sectionId` и `relations` меняются в данных документа.
Каждый элемент `relations` содержит `target: {kind,id}`, `type: references|documents`
и обязательное строковое поле `description` с Markdown-пояснением. Если пояснения нет,
передавайте `description: ""`: отсутствие свойства не проходит строгую REST-схему.
`target.kind: plan-stage` — сохранённая до миграции связь с прежним этапом плана, только для
чтения: OpenAPI-схема ввода содержит это значение, но новое прикрепление к этапу отклоняет Core.
`links`/`targets` — совместимые продуктовые области, не замена
адресным отношениям. Для снятия набора используйте явное очищение соответствующего поля.
Core согласует документ и связи одной операцией; второй POST графа не нужен.
Полная замена разделов остаётся доступной через массив `project.documentSections`.

### Страницы прикреплений и операции библиотеки

| Метод и путь                | OperationId; вход → данные ответа                                       |
| --------------------------- | ----------------------------------------------------------------------- |
| `GET /documents/links`      | `getDocumentLinks`; `DocumentLinksQuery` → `DocumentLinksPage`          |
| `GET /documents/sections`   | `getDocumentSections`; `DocumentSectionsQuery` → `DocumentSectionsPage` |
| `POST /documents/relations` | `changeDocumentRelation`; `DocumentRelationChange` → `EntitySaved`      |
| `POST /documents/sections`  | `changeDocumentSection`; `DocumentSectionChange` → `EntitySaved`        |

Все четыре операции имеют scoped-адрес `/projects/:project/documents/...` и operationId
с суффиксом `ForProject`. Возможность `relay-document-library-v1` объявляется в `/context`.
HTTP Backend проверяет её до предметного запроса; старый сервер даёт `SERVER_INCOMPATIBLE`,
без обхода через полное чтение и клиентскую перезапись массивов.

Чтения принимают `offset` (по умолчанию 0), `limit` (по умолчанию 40, максимум 100),
необязательную `version`; прикрепления также требуют `ref` документа. Результат содержит
`items`, `total`, `nextOffset`, `version`, исходную `revision` владельца. Версия — ID
владельца и его ревизия, не исторический снимок. Передавайте её при продолжении;
изменившийся владелец требует начать чтение заново (`VERSION_CONFLICT`, HTTP 409,
exitCode 2, совместимый с прежними командами библиотеки).
Прикрепления содержат источник `relations|links`, цель, тип и пояснение только видимой
страницы; `references` — уникальные цели этой страницы с `ref`, `key`, `title`.
Текст документа и пояснения невидимых прикреплений не передаются. Разделы содержат
`project`, `projectKey` и упорядоченные элементы `{id,name}`, без полной записи проекта.

Мутации требуют исходную `ifRevision`, `requestId` и допускают `actor`; повторов нет.
`relations` принимает `ref`, `target`, `source` и `action: link|unlink`. Для современного
источника `relations` необязательный `relation` по умолчанию равен `documents`;
при `link` отсутствие `description` сохраняет прежнее пояснение (для нового — пустое),
а `description: ""` явно очищает его. `unlink` не принимает пояснение. Прежний источник
`links` не принимает ни `relation`, ни `description`. Core согласует связи в одной записи.

Операция раздела принимает `action: create|update` с `id`, `name`, `move` с `id`,
`before` (ID следующего раздела либо `null` для конца), либо `remove` с `id`.
Непереданные разделы сохраняются; клиент не должен читать весь проект для этой записи.
Ревизия проверяется и при семантически неизменной операции; успешная запись увеличивает её.

## Доски, задачи, критерии и комментарии

Правила — в [контракте задач](../../../docs/domain/TASKS.md).
Для всех `:reference` здесь выбирается задача, кроме явно указанного slug доски.

| Метод и путь                                        | Действие; схема ввода → данные ответа                                    |
| --------------------------------------------------- | ------------------------------------------------------------------------ |
| `GET /boards`                                       | Каталог досок; `BoardsQuery` → `BoardsPage`                              |
| `GET /boards/:slug`                                 | Доска по slug → `BoardInfo`                                              |
| `GET /board-tasks`                                  | Поиск задач; `BoardTasksQuery` → `BoardTasksPage`                        |
| `GET /board-tasks/:reference`                       | Полная задача → `BoardTaskView`                                          |
| `GET /board-tasks/:reference/links`                 | Прямые/обратные связи; `BoardTasksQuery` → `BoardTaskLinksPage`          |
| `POST /board-tasks`                                 | Создать; `CreateBoardTask` → `BoardTaskSaved`                            |
| `POST /board-tasks/:reference/update`               | Содержание/продуктовые цели; `UpdateBoardTask` → `BoardTaskSaved`        |
| `POST /board-tasks/:reference/move`                 | Колонка, порядок, доска; `MoveBoardTask` → `BoardTaskSaved`              |
| `POST /board-tasks/:reference/links`                | Зависимость, related, родитель; `LinkBoardTask` → `BoardTaskSaved`       |
| `GET /board-tasks/:reference/criteria`              | Карточки критериев; `CriteriaQuery` → `CriteriaPage`                     |
| `GET /board-tasks/:reference/criteria/:criterionId` | Полный критерий → `CriterionView`                                        |
| `POST /board-tasks/:reference/criteria`             | Добавить/изменить/удалить/отметить; `ChangeCriterion` → `BoardTaskSaved` |
| `GET /board-tasks/:reference/comments`              | Лента карточек; `TaskCommentsQuery` → `TaskCommentsPage`                 |
| `GET /board-tasks/:reference/comments/:entryId`     | Полный комментарий → `TaskComment`                                       |
| `POST /board-tasks/:reference/comments`             | Публикация; `PublishTaskComment` → `TaskCommentSaved`                    |

Список не заменяет полный Markdown задачи, критерия или комментария. Критерии защищаются
ревизией задачи; отметка выполнения задаётся явно. Комментарий имеет собственные
автора/роль и не меняет ревизию содержания задачи. Редактирования/удаления опубликованного
комментария нет. После потери ответа повтор публикации может создать новое сообщение.
Для целей, зависимостей и родительства используйте предметные операции, не POST графа.

## История работы агентов

Переносимые поля и предметные операции определены в
[Contracts](../../contracts/docs/API.md#история-работы-агентов). Это явные ветки работы,
участия агентов и неизменяемые материалы checkpoints, не автоматический аудит команд.
Существующие CRUD-операции не добавляют записи истории. Активное участие не означает online.

Все адреса ниже имеют также префикс `/projects/:project`, а operationId — суффикс
`ForProject`. `/context` объявляет `relay-work-history-v1`. HTTP Backend проверяет
его перед **каждым методом** `workHistory`: без capability — `UNSUPPORTED` (exit 5),
без запроса к отсутствующему маршруту и без local/full-read fallback.

| Метод и путь                              | OperationId; вход → данные ответа                                           |
| ----------------------------------------- | --------------------------------------------------------------------------- |
| `GET /work-history/sessions`              | `listWorkSessions`; `WorkSessionsQuery` → `WorkSessionsPage`                |
| `GET /work-history/sessions/:ref`         | `getWorkSession` → `WorkSessionDetail`                                      |
| `GET /work-history/sessions/:ref/tree`    | `getWorkSessionTree`; `WorkHistoryPageQuery` → `WorkTreePage`               |
| `GET /work-history/sessions/:ref/history` | `getWorkSessionHistory`; `WorkHistoryQuery` → `WorkHistoryPage`             |
| `GET /work-history/history`               | `getWorkHistory`; `WorkHistoryQuery` → `WorkHistoryPage` всего проекта      |
| `GET /work-history/sessions/:ref/context` | `getWorkSessionContext`; `WorkHistoryPageQuery` → `WorkContext`             |
| `GET /work-history/checkpoints/:ref`      | `getWorkCheckpoint` → полный `WorkCheckpoint`                               |
| `GET /work-history/sessions/:ref/intents` | `getWorkSessionOpenIntents`; `WorkOpenIntentsQuery` → `WorkOpenIntentsPage` |
| `POST /work-history/sessions/start`       | `startWorkSession`; `WorkSessionStart`                                      |
| `POST /work-history/sessions/fork`        | `forkWorkSession`; `WorkSessionFork`                                        |
| `POST /work-history/sessions/attach`      | `attachWorkSession`; `WorkSessionAttach`                                    |
| `POST /work-history/sessions/pause`       | `pauseWorkSession`; `WorkSessionPause`                                      |
| `POST /work-history/sessions/resume`      | `resumeWorkSession`; `WorkSessionResume`                                    |
| `POST /work-history/sessions/takeover`    | `takeoverWorkSession`; `WorkSessionTakeover`                                |
| `POST /work-history/sessions/complete`    | `completeWorkSession`; `WorkSessionComplete`                                |
| `POST /work-history/sessions/cancel`      | `cancelWorkSession`; `WorkSessionCancel`                                    |
| `POST /work-history/checkpoints/open`     | `openWorkCheckpoint`; `WorkCheckpointOpen`                                  |
| `POST /work-history/checkpoints/save`     | `saveWorkCheckpoint`; `WorkCheckpointSave`                                  |
| `POST /work-history/checkpoints/complete` | `completeWorkCheckpoint`; `WorkCheckpointComplete`                          |
| `POST /work-history/checkpoints/cancel`   | `cancelWorkCheckpoint`; `WorkCheckpointCancel`                              |

Каждый POST принимает **весь объект ввода в JSON-теле** и возвращает `WorkHistoryMutation`
с HTTP 200. При fork поле `ref` адресует исходный **intent**, а `ifRevision` — его
родительскую ветку; ответ содержит обновлённого родителя и pending-ребёнка без run.
Остальные значения ref, CAS и runId определены соответствующей схемой. `actor` тела
приоритетнее автора вызова; это атрибуция, не авторизация. Мутации автоматически не
повторяются даже при потере ответа: сначала перечитайте ветку и историю.

Ключи `S-…`, `RUN-…`, `CP-…` содержат случайный token, не порядковый номер;
адреса в URL кодируются как обычные сегменты. Поля подключения `operator` и `git`
передаются клиентом и сохраняются в run. Сервер не читает собственный Git для определения
человека или рабочей ветки клиента. Отсутствующие сведения возвращаются как null;
наследование operator при attach без явного значения выполняет Core.

Query страниц: `offset=0`, `limit=20` по умолчанию, максимум 100, optional `version`.
Продолжение использует исходную version и те же фильтры; `VERSION_CONFLICT` (409)
требует начать заново. Это guard текущего состояния, не исторический снимок.
`total`, `nextOffset` и счётчики дерева относятся к полному выбранному составу.
Карточка, checkpoint и материалы выбранной страницы сохраняют полный Markdown.

Список и узлы дерева содержат `WorkSessionOverview`: собственные `counts`, компактное
последнее участие `latestRun` с operator/git (также у закрытой ветки), `acceptance`
с адресом первого явного принятия родителем либо null. Detail тоже возвращает
`latestRun` и `acceptance`. Поле списка `projectTotals` относится ко **всему проекту**,
независимо от фильтра; `total` — только к выбранным веткам.
Открытые намерения читаются отдельным `/sessions/:ref/intents`, без загрузки всей
истории. Query принимает `includeChildren` (default false) и обычные страницы;
items содержит только открытые intent с полным материалом. После result/cancel
намерение исчезает из этой выборки; progress не закрывает его.

В списке доступны `unfinished`, `status`, `parent`, `actor`, `q`. `parent=null`
в URL — буквальная строка для выбора только корней; отсутствие parent выбирает все
ветки. В Backend это `parent: null`. `unfinished=false` выбирает закрытые ветки,
`unfinished=true` — незакрытые. У истории `includeChildren=false` сохраняет только
выбранную ветку; `true` добавляет всех потомков. Boolean query принимают только
`true`/`false`, не `0`, `1` или truthy-строки. `order=asc|desc` и `kind` управляют
хронологией. Проектный `/history` не принимает ref: ветка выбирается путём.
Context содержит полную карточку и ограниченную страницу собственной истории;
продолжение выполняется тем же `/context` с исходной version.

Обычный [SSE](#sse) уведомляет об изменениях всех трёх коллекций, включая публикации
через local Backend/CLI. Событие не содержит результата записи и не заменяет повторное
чтение после переподключения.

### Граф истории и адресная точка

Отдельные read-only операции не меняют прежний Backend `workHistory` и его фильтры.
Схемы принадлежат `@relay/contracts/work-history-graph`; сервер проверяет весь ответ,
включая согласованность концов связей и таблиц авторских участий.

| Метод и путь                          | OperationId; вход → данные ответа                                                        |
| ------------------------------------- | ---------------------------------------------------------------------------------------- |
| `GET /work-history/graph`             | `getWorkHistoryGraph`; `WorkHistoryGraphQuery` → `WorkHistoryGraphPage`                  |
| `GET /work-history/graph/points/:ref` | `getWorkHistoryGraphPoint`; `WorkHistoryGraphPointQuery` → `WorkHistoryGraphPointDetail` |

Обе операции имеют scoped-копии `/projects/:project/...` с суффиксом `ForProject`.
Выбранный `/context` объявляет отдельную capability `relay-work-history-graph-v2`.
Потребитель проверяет её до чтения графа: отсутствие не разрешает заменять граф
старой историей или автоматически переходить к local. SDK сам не выполняет discovery.
Прежняя `relay-work-history-graph-v1` не объявляется: адресация линий через
`fromSessionId`/`toSessionId` и замыкание cancelled несовместимы с прежними рёбрами.
Версии страниц имеют префикс `work-graph-v2:`; старый guard требует начать чтение заново.

Без ref читается timeline всего проекта. Query допускает только optional `ref`
ветки, `includeChildren` (default true), `order` (default desc), `offset` (default 0),
`limit` (default 50, максимум 100) и optional `version`. Boolean — только буквальные
`true`/`false`. Фильтров q/status/actor здесь нет. При продолжении передайте исходную
version; `VERSION_CONFLICT` требует нового чтения, а не склейки разных состояний.

`items` содержит компактные точки без полных Markdown. `sequence` связывает узлы
`from`/`to` из items либо `boundaryNodes` и может пересекать окно страницы между
двумя границами before/after без видимого endpoint. Остальные связи используют видимую
точку создания/закрытия и линию родителя либо ось проекта:

- `fork: {fromSessionId, to}` — линия настоящего родителя → создание ребёнка на
  сохранённом времени **ребёнка**. `originCheckpointId` остаётся контекстом поручения,
  но давний intent не задаёт временную координату линии fork;
- `branch-end: {from, toSessionId}` — закрытие completed **или cancelled** ребёнка →
  линия настоящего родителя на времени закрытия, без ожидания explicit acceptance;
- `root-start: {from: null, to}` и `root-end: {from, to: null}` связывают настоящий
  корень с осью проекта; root-end возвращает как completed-, так и cancelled-корень.

`fromSessionId`/`toSessionId` разрешаются через `branches`, а не таблицу узлов.
Дочерний scope не становится корнем. Explicit acceptance сохраняет прежние предметные
правила и checkpoint, но **не является графовым ребром**. Замыкание линии не означает
принятия результата или успешного выполнения отменённой работы. Проекция производна:
никаких дополнительных событий, фиктивных точек родителя и записей при чтении нет.
`openEnds` содержит последние реальные точки всех незавершённых веток выбранной области,
включая ветки вне страницы, без выдуманных событий «сейчас» и без прибавки к total.
Компактные `branches`/`runs` обеспечивают контекст points, границ, линий родителей и открытых окончаний;
полные поручения, результаты, причины, checkpoint.body и остальные большие поля не передаются.

`:ref` точки — URL-кодированный производный node ID (`ID:created`, `ID:closed`,
`ID:started`, `ID:ended`, `ID:checkpoint`); для прежних ссылок принимаются CP-key,
сырой checkpoint ID и `work-checkpoint:ID`. Ответ содержит полные материалы **одной**
точки: session, авторский run, компактный previousRun и checkpoint либо null для lifecycle.
Авторство, operator/git относятся к сохранённому run этой точки, не к current/latest
ветки. Server не вычисляет атрибуцию из собственной Git-конфигурации.

## Планы и этапы

Правила — в [планировании](../../../docs/domain/PLANNING.md).

| Метод и путь                                | Действие; вход → данные ответа                                                                |
| ------------------------------------------- | --------------------------------------------------------------------------------------------- |
| `GET /plans`                                | Каталог с прогрессом; `PlansQuery` → `PlansPage`                                              |
| `GET /plans/compact`                        | Обзор без полных Markdown; `PlansCompactQuery` → `PlansCompactPage`                           |
| `GET /plans/task-candidates`                | Кандидаты для этапа и их принадлежность; `PlanningCandidatesQuery` → `PlanningCandidatesPage` |
| `GET /plans/task-memberships/:reference`    | Участие **задачи**; `PlanningPageQuery` → `PlanMemberships`                                   |
| `GET /plans/:reference`                     | Полный план и показатели → `PlanSummary`                                                      |
| `GET /plans/:reference/stages`              | Упорядоченные этапы; `PlanningPageQuery` → `StagesPage`                                       |
| `GET /plans/:reference/stages/:stage/tasks` | Актуальные задачи этапа; `PlanningPageQuery` → `PlanningTasksPage`                            |
| `POST /plans`                               | Создать черновик; `CreatePlan` → `PlanningSaved`                                              |
| `POST /plans/:reference/update`             | Изменить заданные поля; `UpdatePlan` → `PlanningSaved`                                        |
| `POST /plans/:reference/transition`         | Начать/завершить/отменить; `TransitionPlan` → `PlanningSaved`                                 |
| `POST /plans/:reference/stages`             | Создать/изменить/переместить/удалить пустой этап; `ChangePlanStage` → `PlanningSaved`         |
| `POST /plans/:reference/tasks`              | Добавить/исключить задачи; `ChangePlanTasks` → `PlanningSaved`                                |
| `POST /plans/:reference/transfer`           | Перенести задачу с причиной; `TransferPlanTask` → `PlanningSaved`                             |

Этап вложен в план и изменяется под его ревизией. Перенос проверяет ревизии обеих сторон.
`transition` поддерживает `start`, `complete`, `cancel`; завершение требует итога,
отмена — причины. Закрытый план нельзя возобновить, редактировать или удалить.
Включение задачи не создаёт копию и не переносит её на другую доску.

`GET /plans/compact?projection=compact` (operationId `getPlansCompact`) выбирает
отдельную обзорную проекцию. Query требует буквальный `projection=compact` вместе
с обычными фильтрами и пагинацией. Прежний `GET /plans` сохраняет `PlansQuery` →
`PlansPage`, не принимает новую проекцию и не возвращает union разных DTO.
Compact не передаёт полные Markdown-поля, но сохраняет summary, состояние, counts,
число этапов и nextStage. Полное содержание читайте через `/plans/:reference`.

## Релизы

Правила — в [релизах](../../../docs/domain/RELEASES.md).

| Метод и путь                               | Действие; вход → данные ответа                                                                                    |
| ------------------------------------------ | ----------------------------------------------------------------------------------------------------------------- |
| `GET /releases`                            | Каталог; `ReleasesQuery` → `ReleasesPage`                                                                         |
| `GET /releases/compact`                    | Обзор; `ReleasesCompactQuery` → `ReleasesCompactPage`                                                             |
| `GET /releases/:reference`                 | Реквизиты и текущая готовность → `ReleaseSummary`                                                                 |
| `GET /releases/:reference/plans`           | Актуальный состав; `PlanningPageQuery` → `ReleaseComposition`                                                     |
| `GET /releases/:reference/plans/compact`   | Обзор состава; `ReleaseCompositionCompactQuery` → `ReleaseCompositionCompact`                                     |
| `POST /releases/preview`                   | **Чтение без записи** выбранных планов; `ReleasePreview` → `ReleaseComposition`                                   |
| `POST /releases/preview/compact`           | **Чтение без записи**; тело `ReleasePreview`, query `ReleasePreviewProjectionQuery` → `ReleaseCompositionCompact` |
| `POST /releases`                           | Создать; `SaveRelease` → `PlanningSaved`                                                                          |
| `POST /releases/:reference/update`         | Реквизиты, состав, состояние; `UpdateRelease` → `PlanningSaved`                                                   |
| `POST /releases/by-refs`                   | Состав по ссылкам; `SaveReleaseByRefs` → `PlanningSaved`                                                          |
| `POST /releases/:reference/update-by-refs` | Полное сохранение по ссылкам; `UpdateReleaseByRefs` → `PlanningSaved`                                             |
| `POST /releases/:reference/transition`     | Перепланировать/отменить/выпустить; `ReleaseAction` → `PlanningSaved`                                             |

Состав задаётся `planIds`. Текущий контракт **не имеет `applicationId` и операции
назначения приложения**; это ещё не реализованная часть целевой модели.
`version` в реквизитах релиза — обозначение выпуска, не ревизия и не токен пагинации.
Выпуск проверяет готовность Core, но не запускает CI/CD. Состав читается актуальным,
исторического снимка нет; выпущенная запись неизменяема.

By-refs принимает `plans` — 1–200 ключей, ID или work-plan:ID вместо `planIds`.
Ссылки разрешаются и проверяются в одной мутации Core. Update-by-refs — **полное
сохранение**, включая status и исходную ifRevision, не patch. После конфликта
перечитайте релиз и согласуйте весь ввод. HTTP Backend требует `relay-release-refs-v1`.

Отдельные `/releases/compact`, `/releases/:reference/plans/compact` и
`/releases/preview/compact` требуют query `projection=compact`. У preview эта опция
не входит в тело `ReleasePreview`. OperationId соответственно `getReleasesCompact`,
`getReleasePlansCompact`, `previewReleaseCompact`. Прежние маршруты сохраняют свои
полные формы, не принимают compact в качестве переключателя DTO. Compact-каталог
исключает description/planIds; compact-состав и preview содержат обзорные планы без
полных Markdown-полей. Итоги readiness остаются полными.
Поиск релизов q включает полное description наряду с ключом, названием, version и summary.

## Прогресс

Каждый путь — самостоятельная GET-операция:

| Путь                          | Вход → данные ответа                             |
| ----------------------------- | ------------------------------------------------ |
| `/progress/task`              | `ProgressQuery` → `TaskProgress`                 |
| `/progress/task/dependencies` | `TaskDependenciesQuery` → `TaskDependenciesPage` |
| `/progress/implementation`    | `ProgressQuery` → `ImplementationProgress`       |
| `/progress/scenario`          | `ProgressQuery` → `ScenarioProgress`             |
| `/progress/feature`           | `ProgressQuery` → `FeatureProgress`              |
| `/progress/application`       | `ProgressQuery` → `ApplicationProgress`          |
| `/progress/product`           | `ProgressPageQuery` → `ProductProgress`          |
| `/progress/work-plan`         | `ProgressQuery` → `WorkPlanProgress`             |
| `/progress/release`           | `ProgressQuery` → `ReleaseProgress`              |

`ProgressQuery` добавляет `ref` к параметрам страницы. Итоги рассчитаны по полному
составу, а вложенные списки причин/участников могут требовать продолжения.
Сохранённое состояние и фактическая готовность различаются; формулы и пустой состав
определены в [прогрессе](../../../docs/domain/PROGRESS.md), не в транспортном адаптере.

Отдельная страница зависимостей возвращает `{entity, items, total, nextOffset, version}`
без критериев, детей и причин полного прогресса. При offset > 0 обязательна исходная
version, guard связан с проектом, задачей, limit и состоянием задач; конфликт —
`PROGRESS_CHANGED` (409, exit 4). Это не версия полного TaskProgress.
HTTP Backend требует `relay-work-read-models-v1` для этой операции и compact-страниц
планов/релизов. При несовместимости обновите Server и клиентов согласованно, без
скрытого полного запроса или local fallback. Малый DTO не гарантирует O(limit) I/O.

## Граф и контекст

| Метод и путь         | Действие; вход → данные ответа                                                 |
| -------------------- | ------------------------------------------------------------------------------ |
| `GET /graph`         | Ограниченная диагностика, фильтры/глубина/страницы; `GraphQuery` → `GraphPage` |
| `GET /graph/context` | Полная достижимая компонента; `FullContextQuery` → `FullContext`               |
| `POST /graph`        | Атомарный пакет диагностических изменений; `GraphMutation` → `GraphSaved`      |

`/graph/context` принимает `root` (ключ, ID или `kind:ID`) и возвращает
`complete: true` либо ошибку бюджета. Первая страница `/graph` не является полным контекстом.
`GraphMutation.operations[]` содержит `add`, `update`, `remove`; управляемые группы
защищены `RELATION_MANAGED`. Это не назначение цели, прикрепление документа или включение
задачи в план. Контекст служит выяснению связей и визуализации; знания читаются адресно
из полных записей. `/product/context` — отдельная предметная выборка, `/context` — подключение.
Подробности — в [контракте контекста](../../../docs/domain/CONTEXT.md).

## Страницы и полнота

Единого `meta.nextCursor` нет. Используйте форму конкретного ответа:

- Сущности, доски/задачи, критерии, планы/этапы, релизы и граф используют
  `offset`, `limit`, `nextOffset`, `version` согласно схеме. Продолжайте с той же областью,
  фильтрами и версией; `nextOffset: null` означает конец.
- Прогресс сохраняет версию чтения, а продолжения находятся в его вложенных страницах.
  Итоговые показатели не ограничены видимой страницей.
- Комментарии используют `cursor`, `nextCursor`, `snapshot`: передавайте возвращённый
  курсор без самостоятельного конструирования.
- `product/records` и `product/entities` возвращают `version`, **но не принимают её
  для продолжения**. Их offset-страницы не гарантируют общий снимок; строгая схема
  отклоняет лишний `version`. Перед записью перечитайте выбранную запись.
- Полный `graph/context`, состояние продукта и `product/overview` не нужно трактовать
  как первую страницу универсального списка.
- `product/overview/metrics/:metric` использует непрозрачный `cursor`/`nextCursor`
  и `version` полного среза; при `VERSION_CONFLICT` начинайте с первой страницы.

При `ENTITIES_CHANGED`, `BOARD_CHANGED`, `PLANNING_CHANGED`, `PROGRESS_CHANGED` или
`GRAPH_CHANGED` начинайте соответствующее чтение заново. Не склеивайте несовместимые страницы.
Лимиты и defaults смотрите в query-схеме своей операции; нет одного общего размера ответа.

## SSE

`GET /events` (scoped в workspace) возвращает `text/event-stream`.
Имя `event` соответствует `ServerEvent.type`, JSON в `data` — полю `data` этого варианта:

- `connected`: `projectId`; прочитать REST выбранного проекта.
- `changed`: `source` равен `api` или `storage`, `version` необязательна;
  перечитать затронутые представления.
- `heartbeat`: `timestamp`, каждые 15 секунд; поддерживает соединение, не требует чтения.
- `workspace-error`: `code`, `message`; показать ошибку базы/подключения, не пустой проект.

События могут объединяться и повторяться. Воспроизведения по `Last-Event-ID` нет;
после переподключения перечитывайте REST. Событие не заменяет результат записи или полное
содержание. Подписка изолирована выбранной базой, включая изменения local CLI/Core.
Остановка сервера завершает потоки. При изменении регистрации прежнее соединение
не должно стать подпиской на другую базу.

## Ошибки и исправление

| HTTP | Типичный случай                                                                                | Следующее действие                                                    |
| ---- | ---------------------------------------------------------------------------------------------- | --------------------------------------------------------------------- |
| 400  | Неверный ввод, `VALIDATION_ERROR`, `INVALID_CURSOR`, `UNKNOWN_METRIC`, `RESPONSE_TOO_LARGE`    | Исправить параметры; для большого ответа выбрать другой способ чтения |
| 403  | Недопустимый Host/Origin                                                                       | Использовать разрешённый локальный адрес                              |
| 404  | `ENTITY_NOT_FOUND`, `TASK_NOT_FOUND`, `PROJECT_NOT_FOUND`, неизвестный маршрут                 | Проверить проект и адрес, не создавать замену автоматически           |
| 409  | Ревизия/версия изменилась, предметный запрет, `RELATION_MANAGED`, `PLANNING_REFERENCE_IN_USE`  | Перечитать данные и выполнить действие владельца                      |
| 409  | Совместимость хранилища: `STORAGE_MIGRATION_REQUIRED`, `STORAGE_DATA_MIGRATION_REQUIRED` и др. | Не повторять запрос; выполнить локальное `storage status`/`migrate`   |
| 413  | `PAYLOAD_TOO_LARGE`                                                                            | Уменьшить тело до лимита HTTP                                         |
| 415  | `UNSUPPORTED_MEDIA_TYPE`                                                                       | Передать JSON Content-Type                                            |
| 500  | Ошибка чтения/хранилища, неотображённый специально код Core                                    | Сохранить сообщение и details, проверить базу и подключение           |

`SNAPSHOT_TOO_LARGE` отображается как 409; бюджет чтения не обещает единый HTTP-статус
для всех семейств. Ориентируйтесь также на `error.code`. Семейство совместимости
(409, `exitCode` 4, у `STORAGE_RECOVERY_CONFLICT` — 5) включает также
`STORAGE_VERSION_UNSUPPORTED`, `STORAGE_TRANSITION_MISSING`, `STORAGE_FORMAT_UNKNOWN`,
`UNKNOWN_ENTITY_KIND`, `STORAGE_ADDRESS_COLLISION`, `STORAGE_MIGRATION_CONFLICT`,
`STORAGE_REFERENCE_BROKEN`, `STORAGE_PLAN_STALE`, `STORAGE_RECOVERY_REQUIRED`,
`STORAGE_RECOVERY_CONFLICT`, `STORAGE_INDEX_STALE`, `STORAGE_LIMIT_EXCEEDED` и любой код
`STORAGE_*` с exit 4. `code`, `exitCode` и `details` передаются без изменений; это не
временная ошибка, и запись с таким ответом не выполнена. Повреждения
(`STORAGE_DATA_CORRUPT`, `STORAGE_RECORD_MISSING`, `STORAGE_FORMAT_MISSING`) остаются 500.
`STORAGE_INDEX_STALE` не следует маскировать пустыми данными: нужно явное обслуживание. Правила восстановления —
в [STORAGE](../../../docs/domain/STORAGE.md) и [RECOVERY](../../../docs/guides/RECOVERY.md).

REST не предоставляет операции инициализации базы, `storage migrate`, `reindex`
или `reconcile-relations`. Выполняйте их подходящим локальным интерфейсом.
Совместимые `product migrate`/`graph migrate` в формате 4 не выполняют изменений;
это не скрытые HTTP-маршруты и не альтернатива миграции хранилища.

## Источники для сопровождения

Регистрация: [AppModule](../src/app.module.ts), [контроллеры](../src/modules),
[projectRouting](../src/modules/workspace/routing.ts). Поля:
[реестр схем OpenAPI](../src/openapi/schemas.ts), [Contracts](../../contracts/src).
Публикация: [setup](../src/openapi/setup.ts), [ApiEndpoint](../src/openapi/endpoint.ts).
Статусы: [httpFailure](../src/common/errors.ts). Эти ссылки помогают разработке;
для вызова API достаточно пользовательского контракта и OpenAPI своего сервера.
