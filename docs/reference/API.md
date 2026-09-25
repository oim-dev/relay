# Контракт REST API Relay

[Документация](../README.md) → REST API. Каноническая схема — `/api/openapi.json`,
Swagger — `/api/docs`. Сервер вызывает Core, SDK генерируется из этой схемы.

Отдельный контроллер `/progress`: задача, реализация, сценарий, фича, приложение, продукт,
план работ и релиз.
Схемы ответов, параметры и ошибки — [предметный прогресс](PROGRESS.md).

## Планирование и релизы

Маршруты ниже относятся к `/api/v1`; в workspace используется
`/api/v1/projects/:project`. Оба адреса вызывают один набор контроллеров.

| Метод и путь                                | Назначение                                                 |
| ------------------------------------------- | ---------------------------------------------------------- |
| `GET /plans`                                | Каталог, поиск, статус, полные счётчики и продолжение      |
| `GET /plans/:reference`                     | Реквизиты и полные показатели плана                        |
| `GET /plans/:reference/stages`              | Страница вложенных этапов, показатели и `planRevision`     |
| `GET /plans/:reference/stages/:stage/tasks` | Страница актуальных задач этапа                            |
| `GET /plans/task-candidates`                | Серверный поиск задач по доске и доступности               |
| `GET /plans/task-memberships/:reference`    | Текущее и историческое участие задачи                      |
| `POST /plans`                               | Создать черновик                                           |
| `POST /plans/:reference/update`             | Частично изменить реквизиты                                |
| `POST /plans/:reference/stages`             | Создать/изменить/удалить/переместить этап                  |
| `POST /plans/:reference/tasks`              | Добавить и снять выбранные включения                       |
| `POST /plans/:reference/transfer`           | Перенести задачу с причиной и двумя ревизиями              |
| `POST /plans/:reference/transition`         | Начать/завершить/отменить план                             |
| `GET /releases`                             | Каталог релизов с полными счётчиками                       |
| `GET /releases/:reference`                  | Реквизиты, состояние и готовность                          |
| `GET /releases/:reference/plans`            | Актуальные планы состава, в том числе после выпуска        |
| `POST /releases/preview`                    | Чтение готовности выбранных планов без записи              |
| `POST /releases`                            | Создать с выбором состава и состояния                      |
| `POST /releases/:reference/update`          | Сохранить реквизиты, состав и выбранное состояние атомарно |
| `POST /releases/:reference/transition`      | Перепланировать/отменить/зафиксировать выпуск              |
| `GET /progress/work-plan`                   | Предметное выполнение плана                                |
| `GET /progress/release`                     | Текущая готовность планов и сохранённый статус релиза      |

Контракты: [PLANNING](PLANNING.md), [RELEASES](RELEASES.md). Записи проверяют `ifRevision`
и `requestId`; страницы — `offset/limit/version`. `PLANNING_CHANGED`, конфликты ревизии,
неготовность и неизменяемый выпуск возвращаются как 409. API не выполняет второй
клиентский запрос для записи связей: это обязательный шаг предметного сервиса Core.

У этапа используется локальный ID вместе с адресом плана; собственного ключа или
ревизии нет. Все изменения этапов и задач состава защищает ревизия плана.
`GET /plans/task-candidates` с `stage` требует `plan`; перенос принимает `targetPlan`,
`targetStage` и ревизии `ifRevision`/`targetRevision`. API снимков выпуска отсутствует.

## Запуск и транспорт

`npx @oim-dev/relay-server --actor human --open` запускает общий Web/REST-сервер.
Префикс API — `/api/v1`, JSON UTF-8, Content-Type application/json, тело до 1 МиБ.
Успех: `{ok:true,data}`; ошибка: `{ok:false,error:{code,message,exitCode?,details?}}`.
400 — аргументы, 403 — источник, 404 — объект/маршрут, 409 — конфликт, 413 — размер,
415 — Content-Type, 500 — хранилище или IO. Автор приходит из тела или настроек сервера.

## Режим и проекты сервера

`GET /api/v1/server` и `GET /api/v1/projects` возвращают `{mode,configPath,projects,defaultProject}`.
Проект содержит key, id, name, slug?, configPath, available, error?. В local проект выбирается
автоматически; workspace требует явного проекта, defaultProject равен null.

`PUT /api/v1/projects/:project` регистрирует базу: `{path?,config?,replace?}`.
`DELETE /api/v1/projects/:project` удаляет регистрацию с сохранением файлов.
Обе операции доступны в workspace и возвращают актуальный серверный контекст.

Каждая проектная операция доступна под `/api/v1/projects/:project/...`; принимается
slug, ключ реестра или постоянный ID. В local доступен также короткий путь `/api/v1/...`.
Workspace без выбора возвращает PROJECT_REQUIRED; неизвестный проект — PROJECT_NOT_FOUND.
Контексты запросов изолированы. Health, server и реестр остаются на корне API.
Swagger выбирает проект для коротких маршрутов, сохраняя явные проектные адреса.

## Настройки проекта

`GET /context` возвращает автора, конфигурацию, пути и постоянный ID.
`GET /context/settings` возвращает `{name,slug,revision}`.
`PUT /context/settings` принимает `{name,slug,ifRevision}` и возвращает подтверждённый снимок.
Имя — 1–120 символов без переносов; slug — 2–64 строчные латинские буквы/цифры
с одиночными дефисами. Занятый адрес — PROJECT_SLUG_TAKEN, устаревшая ревизия — REVISION_CONFLICT.
Повтор уже сохранённых значений успешен без новой ревизии.

Схема конфигурации остаётся v1. Настройки сохраняются атомарно под блокировкой проекта;
занятость slug в workspace сериализуется реестром. Переименование не меняет ID, каталоги,
ключ регистрации или паспорт продукта. [Полный контракт](CONFIGURATION.md#имя-и-адрес-проекта).

## Маршруты

Пути ниже указаны относительно `/api/v1`. Детальные схемы и примеры принадлежат справочникам владельцев.

| Область     | Маршруты                                                                                                                                                                                                                                                      | Контракт                                                      |
| ----------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------- |
| Сущности    | GET/POST `/entities`, GET `/entities/types`, `/entities/type`, `/entities/get`, `/entities/resolve`, `/entities/keys`, `/entities/key-spaces`, `/entities/history`; POST `/entities/update`, `/entities/rename`, `/entities/move-task`, `/entities/link-task` | [Движок](ENTITIES.md)                                         |
| Продукт     | `/product/state`, `/product/overview`, `/product/records`, `/product/context`, `/product/entities`, `/product/entity`, `/product/implementations`                                                                                                             | [Продукт](PRODUCT.md#rest)                                    |
| Доски       | GET `/boards`, `/boards/:slug`                                                                                                                                                                                                                                | [Доски](BOARDS.md)                                            |
| Задачи      | GET/POST `/board-tasks`, GET `/board-tasks/:reference`, GET/POST `/board-tasks/:reference/links`, POST `/board-tasks/:reference/update`, `/board-tasks/:reference/move`                                                                                       | [Канбан](KANBAN.md)                                           |
| Связи       | GET/POST `/graph`, GET `/graph/history`                                                                                                                                                                                                                       | [Граф](GRAPH.md)                                              |
| Удаление    | GET `/entities/deletion-preview`, POST `/entities/delete`                                                                                                                                                                                                     | [Сценарии и подтверждение](#предпросмотр-и-удаление-сущности) |
| Целостность | GET `/validation` → `{valid,entities,boards,tasks}`                                                                                                                                                                                                           | Каталог, продукт, задачи и граф под общей блокировкой         |
| События     | GET `/events`                                                                                                                                                                                                                                                 | SSE                                                           |
| Доступность | GET `/health`                                                                                                                                                                                                                                                 | Состояние процесса; не подтверждает качество данных           |

Критерии приёмки: GET/POST `/board-tasks/:reference/criteria`,
GET `/board-tasks/:reference/criteria/:criterionId`. Список ограничен,
полное описание читается адресно. [Схемы и действия](KANBAN.md#критерии-приёмки).

Обсуждения: GET/POST `/board-tasks/:reference/comments`, GET полного сообщения по
`/comments/:entryId`. История: GET `/board-tasks/:reference/history` и `/history/:entryId`.
[Контракт ленты](TASK-ACTIVITY.md) определяет автора, Markdown, последовательность и повтор.

Прежние `/board`, `/tasks`, `/task-list`, `/groups`, `/overview` и `/project/*`
удалены вместе со специализированными схемами. Они возвращают 404 и отсутствуют в OpenAPI.
Страницы Web «В разработке» не имеют старого backend за заглушкой.

## Списки и пагинация

### Предпросмотр и удаление сущности

`GET /entities/deletion-preview?kind=feature&ref=FEATURE-1` возвращает
`{target,version,deleted,detached,relations}`. `deleted` — полный каскад карточек;
`detached` — сохраняемые сущности со снимаемыми ссылками; `relations` — число
отзываемых активных отношений графа. Допустимы `feature`, `scenario`, `application`,
`implementation`, `task`, `document`. Пагинации нет: каждый из двух списков ограничен
1000 записями, превышение возвращает `RESPONSE_TOO_LARGE`, а не усечённый состав.

`POST /entities/delete` принимает `{kind,ref,ifVersion,requestId,actor?}`.
`ifVersion` берётся из предпросмотра и привязан к выбранной сущности, каталогу,
состоянию графа и сигналу обсуждений. `REVISION_CONFLICT` требует нового предпросмотра.
После неопределённого ответа повторяется прежнее тело с тем же requestId.
Квитанция `{action:"delete",ref,requestId,deleted,detached,relations}` сохраняется
отдельно от удаляемой записи; изменение тела при повторе — `IDEMPOTENCY_CONFLICT`.
Все маршруты имеют проектные варианты. Правила каскада: [удаление](../product/ENTITY-DELETION.md).

Legacy-граф v1 требует явной миграции до удаления (`GRAPH_MIGRATION_REQUIRED`).
Постоянные ключи и алиасы удалённых сущностей резервируются; старый адрес не начнёт
открывать новую запись. Повторное использование зарезервированного ключа — `ENTITY_KEY_CONFLICT`.

### Остальные списки

Действующие предметные списки ограничены: limit 1–100, обычно offset, nextOffset и версия снимка.
Ленты задачи используют cursor/nextCursor, snapshot и after; новая запись не сдвигает старые страницы.
Фильтры применяются до подсчёта и продолжения; при изменении снимка начните заново.
Полные Markdown-тексты читаются адресно, они не подменяются краткой карточкой.
Ошибки ревизии и повтор requestId определяются контрактом владельца.

## Полный контекст

Полный контекст доступен через `GET /api/v1/graph/context?root=...` и проектный маршрут.
Возвращает root/version/nodes/edges/complete; страницы и глубина его не ограничивают.
Согласованный контракт и пределы — [граф](GRAPH.md).

## SSE

События: connected, changed, workspace-error; heartbeat каждые 15 секунд поддерживает
поток и не требует REST. Changed содержит `{source:"api"|"storage",version?}`.
После подключения, изменения и восстановления связи перечитайте нужные REST-данные.
Доставка может объединяться и повторяться; Last-Event-ID не воспроизводит историю.

Наблюдатели отслеживают конфиг, продукт, доски/задачи и граф; прямые записи CLI/Core
видны Web. Старые документы и числовая доска не сканируются. Ошибка хранилища сообщается
отдельно от пустоты. Реестр освобождает наблюдателей удалённой регистрации.

Для единого формата Server читает лёгкий сигнал `.indexes/state.json` и конфигурацию,
не перечитывая все задачи по таймеру. Постоянные пути из файловых уведомлений проверяются
по контрольным суммам. Внешние правки вызывают `STORAGE_INDEX_STALE`; после явного reindex
уведомление снимается и REST снова доступен.

## Локальный доступ

Сервер слушает loopback и проверяет Host/Origin; [инструкции запуска](../../apps/server/README.md).
API и Swagger доступны без Web, если runtime запущен без статики.
