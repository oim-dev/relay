# REST API Relay

Канонический справочник HTTP-интерфейса: как выбрать проект, вызвать действие,
прочитать результат и продолжить работу после ошибки. Предметные правила принадлежат
[Core и доменным контрактам](../domain/README.md), покрытие интерфейсов —
[матрице возможностей](../CAPABILITIES.md). Server не повторяет бизнес-логику
и не запускает агентов, проверки или развёртывание при сохранении данных.

## Содержание

- [Адреса и OpenAPI](#адреса-и-openapi)
- [Запрос и результат](#запрос-и-результат)
- [Сервер, проект и проверка](#сервер-проект-и-проверка)
- [Сущности и удаление](#общие-сущности-адреса-и-удаление)
- [Продукт и документы](#продукт-реализации-и-документы)
- [Доски и задачи](#доски-задачи-критерии-и-комментарии)
- [Планы](#планы-и-этапы) и [релизы](#релизы)
- [Прогресс](#прогресс)
- [Граф и контекст](#граф-и-контекст)
- [Страницы и полнота](#страницы-и-полнота)
- [SSE](#sse)
- [Ошибки и исправление](#ошибки-и-исправление)

## Адреса и OpenAPI

Сначала [запустите Server](SERVER.md) и используйте его
фактический origin. Ниже пути указаны относительно `/api/v1`.

- Local: `/api/v1/<операция>` либо `/api/v1/projects/:project/<операция>`.
- Workspace: только `/api/v1/projects/:project/<операция>` для проектных действий,
  даже при одной регистрации. Короткий адрес не выбирает проект автоматически.
- `/health`, `/server`, `/projects` и операции регистрации остаются на корне `/api/v1`.
- `:project` — ID, ключ регистрации или slug, не отображаемое имя. Различия и
  закрепление клиента по ID описаны в [CONFIGURATION](CONFIGURATION.md).
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

| Метод и путь                | Действие и схема                                                                                       |
| --------------------------- | ------------------------------------------------------------------------------------------------------ |
| `GET /health`               | Доступность API (`HealthResponse`), не проверка всей базы                                              |
| `GET /server`               | Режим, конфиг, defaultProject, регистрации (`ServerContextResponse`)                                   |
| `GET /projects`             | Тот же каталог регистраций с доступностью каждой базы                                                  |
| `PUT /projects/:project`    | Регистрация по **ключу реестра**: `RegisterProjectRequest` с `path`/`config`, необязательным `replace` |
| `DELETE /projects/:project` | Удалить регистрацию по ключу, сохранить файлы базы                                                     |
| `GET /context`              | `ContextResponse`: projectId, capability, конфиг, пути, автор                                          |
| `GET /context/settings`     | Имя, slug и ревизия (`ProjectSettings`)                                                                |
| `PUT /context/settings`     | Сохранить имя и slug с `ifRevision` (`SaveProjectSettings`)                                            |
| `GET /validation`           | Проверить целостность выбранного проекта (`ValidationData`)                                            |

Регистрация и её удаление доступны в workspace. `/context` — подключение, не граф
и не подборка знаний продукта. Настройки не заменяют реестр. Разделы библиотеки
меняются через `entities.update` вида `project`, не через `PUT /context/settings`.

## Общие сущности, адреса и удаление

Правила: [адреса и контекст](../domain/CONTEXT.md),
[удаление](../domain/STORAGE.md).

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

Удаление требует `ref` и `kind` одного из шести удаляемых видов. Сначала прочитайте
`deleted`, `detached`, `relations`, `version`; затем передайте ту же цель,
`ifVersion` и `requestId`. Предпросмотр не усечён: максимум по 1000 удаляемых и сохраняемых
затронутых записей, иначе ошибка. Изменение состояния требует нового предпросмотра.
`PLANNING_REFERENCE_IN_USE` блокирует каскад при ссылках любого плана, включая закрытый.
REST-удаление есть, но прямого метода удаления в общем Backend CLI/MCP нет.

## Продукт, реализации и документы

Правила: [продукт](../domain/PRODUCT.md),
[библиотека документов](../domain/DOCUMENTS.md).

| Метод и путь                            | Действие; вход → данные ответа                                                             |
| --------------------------------------- | ------------------------------------------------------------------------------------------ |
| `GET /product/state`                    | Полное согласованное состояние и готовность → `ProductState`                               |
| `GET /product/overview`                 | Обзор: карта продукта и согласованный срез проекта → `ProductOverview`                     |
| `GET /product/overview/metrics/:metric` | Страница метрики оператора; `ProductOverviewMetricPageQuery` → `ProductOverviewMetricPage` |
| `GET /product/records`                  | Поиск записей; `ProductListQuery` → `ProductList`                                          |
| `GET /product/entities`                 | Карточки целей и реализаций; `ProductEntitiesQuery` → `ProductEntities`                    |
| `GET /product/entity`                   | Одна продуктовая сущность с полным содержанием по `ref` → `ProductEntity`                  |
| `GET /product/context`                  | Предметная подборка по `id`/`applicationId`; `ProductContextQuery` → `ProductContext`      |
| `POST /product/records`                 | Создать/изменить запись; `ProductMutation` → `ProductSaved`                                |
| `POST /product/implementations`         | Изменить отдельную реализацию по её ревизии; `UpdateImplementation` → `ProductSaved`       |

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

`GET /product/overview` (scoped: `GET /projects/:project/product/overview`,
operationId `getProductOverview` / `getProductOverviewForProject`) не принимает
query-параметров. Смысл показателей, подборок и версий задан в
[обзоре продукта](../domain/PRODUCT.md#обзор-состояния-продукта).
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

Документ не требует отдельного `/documents`: создавайте/меняйте его через generic
entities или `product/records`, читайте полное содержание через `entities/get`.
Для библиотеки используйте `GET /entities?kind=document` с `section`, `documentKind`,
`status`, `pinned`, `archived`, `q`, `sort`. `section=none` — без раздела.
Ответ может содержать `libraryCounts`, а не только видимую страницу.

`documentStatus`, `pinned`, `sectionId` и `relations` меняются в данных документа.
Каждый элемент `relations` содержит `target: {kind,id}`, `type: references|documents`
и обязательное строковое поле `description` с Markdown-пояснением. Если пояснения нет,
передавайте `description: ""`: отсутствие свойства не проходит строгую REST-схему.
`links`/`targets` — совместимые продуктовые области, не замена
адресным отношениям. Для снятия набора используйте явное очищение соответствующего поля.
Core согласует документ и связи одной операцией; второй POST графа не нужен.
Порядок/переименование разделов задаются массивом `project.documentSections`.

## Доски, задачи, критерии и комментарии

Правила — в [контракте задач](../domain/TASKS.md).
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

## Планы и этапы

Правила — в [планировании](../domain/PLANNING.md).

| Метод и путь                                | Действие; вход → данные ответа                                                                |
| ------------------------------------------- | --------------------------------------------------------------------------------------------- |
| `GET /plans`                                | Каталог с прогрессом; `PlansQuery` → `PlansPage`                                              |
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

## Релизы

Правила — в [релизах](../domain/RELEASES.md).

| Метод и путь                           | Действие; вход → данные ответа                                                  |
| -------------------------------------- | ------------------------------------------------------------------------------- |
| `GET /releases`                        | Каталог; `ReleasesQuery` → `ReleasesPage`                                       |
| `GET /releases/:reference`             | Реквизиты и текущая готовность → `ReleaseSummary`                               |
| `GET /releases/:reference/plans`       | Актуальный состав; `PlanningPageQuery` → `ReleaseComposition`                   |
| `POST /releases/preview`               | **Чтение без записи** выбранных планов; `ReleasePreview` → `ReleaseComposition` |
| `POST /releases`                       | Создать; `SaveRelease` → `PlanningSaved`                                        |
| `POST /releases/:reference/update`     | Реквизиты, состав, состояние; `UpdateRelease` → `PlanningSaved`                 |
| `POST /releases/:reference/transition` | Перепланировать/отменить/выпустить; `ReleaseAction` → `PlanningSaved`           |

Состав задаётся `planIds`. Текущий контракт **не имеет `applicationId` и операции
назначения приложения**; это ещё не реализованная часть целевой модели.
`version` в реквизитах релиза — обозначение выпуска, не ревизия и не токен пагинации.
Выпуск проверяет готовность Core, но не запускает CI/CD. Состав читается актуальным,
исторического снимка нет; выпущенная запись неизменяема.

## Прогресс

Каждый путь — самостоятельная GET-операция:

| Путь                       | Вход → данные ответа                       |
| -------------------------- | ------------------------------------------ |
| `/progress/task`           | `ProgressQuery` → `TaskProgress`           |
| `/progress/implementation` | `ProgressQuery` → `ImplementationProgress` |
| `/progress/scenario`       | `ProgressQuery` → `ScenarioProgress`       |
| `/progress/feature`        | `ProgressQuery` → `FeatureProgress`        |
| `/progress/application`    | `ProgressQuery` → `ApplicationProgress`    |
| `/progress/product`        | `ProgressPageQuery` → `ProductProgress`    |
| `/progress/work-plan`      | `ProgressQuery` → `WorkPlanProgress`       |
| `/progress/release`        | `ProgressQuery` → `ReleaseProgress`        |

`ProgressQuery` добавляет `ref` к параметрам страницы. Итоги рассчитаны по полному
составу, а вложенные списки причин/участников могут требовать продолжения.
Сохранённое состояние и фактическая готовность различаются; формулы и пустой состав
определены в [прогрессе](../domain/PROGRESS.md), не в транспортном адаптере.

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
Подробности — в [контракте контекста](../domain/CONTEXT.md).

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

| HTTP | Типичный случай                                                                               | Следующее действие                                                    |
| ---- | --------------------------------------------------------------------------------------------- | --------------------------------------------------------------------- |
| 400  | Неверный ввод, `VALIDATION_ERROR`, `INVALID_CURSOR`, `UNKNOWN_METRIC`, `RESPONSE_TOO_LARGE`   | Исправить параметры; для большого ответа выбрать другой способ чтения |
| 403  | Недопустимый Host/Origin                                                                      | Использовать разрешённый локальный адрес                              |
| 404  | `ENTITY_NOT_FOUND`, `TASK_NOT_FOUND`, `PROJECT_NOT_FOUND`, неизвестный маршрут                | Проверить проект и адрес, не создавать замену автоматически           |
| 409  | Ревизия/версия изменилась, предметный запрет, `RELATION_MANAGED`, `PLANNING_REFERENCE_IN_USE` | Перечитать данные и выполнить действие владельца                      |
| 413  | `PAYLOAD_TOO_LARGE`                                                                           | Уменьшить тело до лимита HTTP                                         |
| 415  | `UNSUPPORTED_MEDIA_TYPE`                                                                      | Передать JSON Content-Type                                            |
| 500  | Ошибка чтения/хранилища, неотображённый специально код Core                                   | Сохранить сообщение и details, проверить базу и подключение           |

`SNAPSHOT_TOO_LARGE` отображается как 409; бюджет чтения не обещает единый HTTP-статус
для всех семейств. Ориентируйтесь также на `error.code`. `STORAGE_INDEX_STALE` не следует
маскировать пустыми данными: нужно явное обслуживание. Правила восстановления —
в [STORAGE](../domain/STORAGE.md) и [RECOVERY](../guides/RECOVERY.md).

REST не предоставляет операции инициализации базы, `storage migrate`, `reindex`
или `reconcile-relations`. Выполняйте их подходящим локальным интерфейсом.
Совместимые `product migrate`/`graph migrate` в формате 4 не выполняют изменений;
это не скрытые HTTP-маршруты и не альтернатива миграции хранилища.

## Источники для сопровождения

Регистрация: [AppModule](https://github.com/oim-dev/relay/blob/main/packages/server-runtime/src/app.module.ts), [контроллеры](https://github.com/oim-dev/relay/blob/main/packages/server-runtime/src/modules),
[projectRouting](https://github.com/oim-dev/relay/blob/main/packages/server-runtime/src/modules/workspace/routing.ts). Поля:
[реестр схем OpenAPI](https://github.com/oim-dev/relay/blob/main/packages/server-runtime/src/openapi/schemas.ts), [Contracts](https://github.com/oim-dev/relay/blob/main/packages/contracts/src).
Публикация: [setup](https://github.com/oim-dev/relay/blob/main/packages/server-runtime/src/openapi/setup.ts), [ApiEndpoint](https://github.com/oim-dev/relay/blob/main/packages/server-runtime/src/openapi/endpoint.ts).
Статусы: [httpFailure](https://github.com/oim-dev/relay/blob/main/packages/server-runtime/src/common/errors.ts). Эти ссылки помогают разработке;
для вызова API достаточно пользовательского контракта и OpenAPI своего сервера.
