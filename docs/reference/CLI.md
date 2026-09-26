# Справочник CLI

`relay-cli` означает установленную команду или `npx @oim-dev/relay-cli`.
В workspace передавайте проект префиксом или `--project`; в local можно работать
через Core либо HTTP. [Конфигурация](CONFIGURATION.md) определяет поиск и приоритеты.
Чтение не требует автора; запись требует `--actor` или `RELAY_ACTOR`.

## Предметный прогресс

### progress work-plan

`progress work-plan <ref>` — полное выполнение состава плана, этапы, препятствия,
условия начала/завершения и расхождение закрытого плана с текущими задачами.
Страницы: `--offset`, `--limit`, `--snapshot-version`.

### progress release

`progress release <ref>` — текущая готовность планов и сохранённый статус релиза.
Состояние выпуска и текущая готовность различаются. Те же параметры страниц.

## Планы и релизы

Правила: [планы](PLANNING.md), [релизы](RELEASES.md). Все записи принимают `--request-id`;
после потери ответа читают текущее состояние до решения о новой записи.
`--request-id` — корреляция, не дедупликация. Изменения требуют `--if-revision`.
Автор задаётся глобально через `--actor`. Страницы используют `--offset`, `--limit`
и `--snapshot-version`, сохраняя фильтры. Человеческий Markdown/таблицы — по умолчанию,
машинный ответ — `--format json`.

### plan list

`plan list [--q <текст>] [--status draft|active|completed|cancelled]` — каталог с полными
показателями. Порция по умолчанию 12, максимум 100.

### plan get

`plan get <reference>` — полные тексты, область, ревизия и показатели плана.

### plan candidates

`plan candidates [--q <текст>] [--board <доска>] [--plan <план>] [--stage <id>]
[--available-only true|false]` — серверный поиск задач для включения. Свободные и
текущие задачи выбранного этапа видны при true; false показывает также занятые/отменённые.
`--stage` требует `--plan`: ID этапа локален плану. Поддержаны общие параметры страниц.

### plan create

`plan create --title <название> [--goal <Markdown>]` — новый черновик. Дополнительные поля:
`--summary` — краткий текст, `--rationale` — обоснование, `--boundaries` — границы,
`--expected-result` — ожидаемый результат, `--scope <адреса...>` — реальные области,
`--participants <авторы...>` — участники. Полные тексты принимают Markdown напрямую.

### plan update

`plan update <reference> --if-revision <n>` — только заданные поля из `plan create`.
`--clear-scope` явно очищает область. Отсутствующее поле сохраняет прежнее значение.

### plan stages

`plan stages <reference>` — страница вложенных этапов с полными счётчиками задач
и `planRevision`. У этапов нет самостоятельных ключей и ревизий.

### plan tasks

`plan tasks <reference> <stage>` — актуальные задачи одного этапа. Полное описание
задачи читается через `task get`; подзадачи и зависимости не добавляются в состав автоматически.

### plan memberships

`plan memberships <reference>` — участие задачи в текущем составе планов, не журнал включений.

### plan stage create

`plan stage create <reference> --title <название> --if-revision <n>` — создать этап.
`--summary` — краткий текст, `--outcome` — ожидаемый результат в Markdown,
`--completion-conditions` — описанные условия завершения в Markdown.

### plan stage update

`plan stage update <reference> <stage> --if-revision <n>` — изменить заданные поля этапа.
Ревизия относится к плану, включая его состав. Поля совпадают с созданием этапа.
Передаются только заданные параметры, без подстановки актуальных непереданных полей.
После потери ответа перечитайте план и состав; не повторяйте изменение безусловно.

### plan stage remove

`plan stage remove <reference> <stage> --if-revision <n>` — удалить пустой этап.

### plan stage move

`plan stage move <reference> <stage> --if-revision <n> [--before <id>]` — переместить
перед выбранным этапом; отсутствие `--before` означает конец полного списка.

### plan include

`plan include <reference> <stage> --tasks <задачи...> --if-revision <n>` — добавить задачи,
сохранив остальные включения. Допускается до 2000 задач в этапе.

### plan exclude

`plan exclude <reference> <stage> --tasks <задачи...> --if-revision <n>` — снять выбранные
включения и их связи; задачи сохраняются.

### plan transfer

`plan transfer <reference> <task> <targetStage> --target-plan <план> --if-revision <n> --target-revision <n>
--reason <Markdown>` — явный перенос с ревизиями исходного и целевого планов и причиной.

### plan start

`plan start <reference> --if-revision <n>` — начать черновик с целью и непустым составом.

### plan complete

`plan complete <reference> --if-revision <n> --result <Markdown>` — завершить черновой
или начатый план с итогом после серверной проверки всех обязательств задач.
Предварительный `plan start` не требуется.

### plan cancel

`plan cancel <reference> --if-revision <n> --result <Markdown>` — отменить с причиной,
сохранив текущий состав закрытого плана, без журнала прежних включений.

### release list

`release list [--q <текст>] [--status planned|released|cancelled]` — каталог выпусков.

### release get

`release get <reference>` — реквизиты, готовность, дата и автор выпуска.

### release preview

`release preview [--plans <планы...>]` — прочитать готовность выбранного состава без
создания релиза. Пустой выбор возвращает неготовность. Поддержаны параметры страниц;
команда продолжения сохраняет весь выбранный набор.

### release create

`release create --title <название> --release-version <обозначение> --plans <планы...>` —
создать самостоятельный релиз. `--summary`, `--description`, `--planned-for YYYY-MM-DD`
и `--status` задают описание, дату и состояние. `released` проверяет состав и фиксирует выпуск.

### release update

`release update <reference> --if-revision <n>` — изменить заданные реквизиты из создания.
`--plans` заменяет полный состав, пустая строка `--planned-for` очищает дату.

### release plan

`release plan <reference> --if-revision <n>` — явно перепланировать отменённый релиз.

### release cancel

`release cancel <reference> --if-revision <n>` — отменить будущий выпуск; планы не отменяются.

### release publish

`release publish <reference> --if-revision <n>` — проверить готовность и сохранить
статус, автора и дату. Это фиксация сведений, не запуск CI/CD.

### release plans

`release plans <reference>` — страница актуальных выбранных планов, в том числе после выпуска.

## Прогресс существующих сущностей

### progress task

`progress task <ref> [--offset <n>] [--limit <n>] [--snapshot-version <version>]` — фактическое
выполнение, критерии, подзадачи и зависимости. [Контракт прогресса](PROGRESS.md).

### progress implementation

`progress implementation <ref>` — задачи реализации, SI/FI и участие. Общие параметры
страниц прогресса: `--offset`, `--limit`, `--snapshot-version` (не глобальная версия CLI).

### progress scenario

`progress scenario <ref>` — реализации сценария и прямые задачи; параметры страниц прогресса.

### progress feature

`progress feature <ref>` — сценарии, FI и прямые задачи; параметры страниц прогресса.

### progress application

`progress application <ref>` — состав и раздельные счётчики досок; параметры страниц прогресса.

### progress product

`progress product` — готовность и страница фич; параметры страниц прогресса. Итоги полные;
после конфликта версии перечитайте первую страницу. Человек получает таблицы/причины,
`--format json` — строгую схему. У всех команд сохраняется выбранный проект.

## Общие параметры

| Параметр                      | Назначение                                    |
| ----------------------------- | --------------------------------------------- |
| `--config <path>`             | Явный проектный конфиг или реестр             |
| `--project <name>`            | Проект из workspace                           |
| `--server-url <url>`          | URL Relay Server                              |
| `--local`                     | Прямой доступ Core в local                    |
| `--actor <id>`                | Автор записи                                  |
| `--format json\|text`         | Машинный ответ или человеческое представление |
| `--color auto\|always\|never` | Подсветка терминала                           |
| `--max-bytes <n>`             | Бюджет ответа от 1 КиБ до 128 МиБ             |
| `--help`, `--version`         | Справка и версия                              |

Справка конкретной команды: `relay-cli <команда> --help`. Полный автоматически
сформированный перечень аргументов — [команды распространяемого скилла](../../skills/relay/references/CLI-COMMANDS.md).
Ниже перечислены все действующие команды. Прежние корневые команды числовой доски
и группа документов жизненного цикла удалены.

### Известные ограничения текущей проверки

В Playground 22 сентября 2026 воспроизведён конфликт `--version` для `boards` и
`task list`: вместо страницы со снимком CLI печатает свою версию, даже с `--format json`.
Чтение следующего offset без этого параметра работает, но не фиксирует снимок.
Подсказки продолжения также не сохраняют выбранный workspace-проект — указывайте его явно.
`product overview` на текущих данных `p2p-rental` требует увеличения `--max-bytes`
до 32768. Это наблюдаемые отклонения, не изменение ожидаемого контракта.
Основание — исследование 22 сентября 2026 поверх `f8615e9`; это не новая проверка ветки.
Воспроизведение того среза: получить version первой страницы `boards --limit 2`, затем
передать её в `boards --offset 2 --limit 2 --version <version> --format json`.
Вместо JSON печаталась версия CLI. Аналогично проверялся `task list`.
Наблюдение относится к тогдашним параметрам, а не заменяет текущую справку `--help`.

## Проект и реестр

### init

`init [--storage <path>]` создаёт конфиг, системные доски и единое ID-хранилище рядом
с конфигом. Существующие данные не заменяет. `--storage` сохраняет прежнюю привязку
storageDir для совместимости конфигурации; прежний каталог задач не создаётся.
Новый формат блокируется по реальному каталогу базы.
Пример: `relay-cli init`. [Формат и обслуживание](STORAGE.md).

### config get

Читает конфигурацию и пути. `relay-cli config get --format json` возвращает исходные настройки.

### validate

Проверяет каталог сущностей, продукт, задачи и граф. Ответ: valid, entities, boards, tasks.
При нарушении целостности код процесса 5; список причин находится в error.details.

### storage migrate

`--local storage migrate` явно переводит базу на контракт без истории операций.
Поддерживаемые legacy-базы и единые версии 1/2/3 переходят в физическую версию 4
с оболочками записей версии 3; версия 4 повторного переноса не требует.
Укажите проектный `--config`, остановите старые версии клиентов.
Сначала восстанавливается WAL. Сохраняются ID, алиасы, тексты, ревизии, полные комментарии,
отношения, надгробия, резервы адресов и текущие данные планирования.
Весь автоматический аудит, события, квитанции и результаты команд удаляются.
Повтор завершённого переноса
сообщает, что он не требуется. В HTTP-режиме команда возвращает `LOCAL_REQUIRED`.

### storage reindex

`--local storage reindex` восстанавливает адреса, карточки и смежность
из постоянных записей. Используйте после внешних изменений или потери индекса. Команда
доступна и без `.indexes/state.json`; обычное открытие не заменяет её автоматическим
перестроением. Постоянные данные сохраняются; миграция формата не выполняется.

### storage reconcile-relations

`--local --actor agent storage reconcile-relations --request-id relations-v1` явно согласует
предметные группы связей существующей единой базы. Добавляет недостающие и отзывает лишние
отношения; сохраняет ID неизменённых связей, независимые диагностические рёбра и ревизии
сущностей. Результат содержит `added`, `updated`, `removed`, `requestId` и не сохраняется.
Каждый запуск сверяет текущее состояние, а не воспроизводит прежний ответ.
Для прежней базы сначала выполните `storage migrate`; для потерянного индекса — `storage reindex`.
Команда локальная, без автоматического импорта при чтении. [Подробности](STORAGE.md).

### projects init

Создаёт `relay.workspace.json`; существующий реестр не заменяет.

### projects list

Показывает регистрации. `--limit`, `--cursor`, `--all` управляют страницами и бюджетом.

### projects add

`projects add <name> <path> [--project-config <path>] [--replace]` регистрирует проект.
Пути разрешаются относительно реестра. Замена существующего подключения явная.

### projects remove

`projects remove <name>` удаляет регистрацию, сохраняя файлы проекта.

## Доски и задачи

### boards

Каталог досок: `--offset`, `--limit` (1–100), `--version`. Продолжение — nextOffset.

### task create

`task create --board <slug|prefix|id> [--title <text>] [--description <markdown>] [--column <column>]`.
Пустые поля допустимы. `--parent-id` создаёт подзадачу; `--feature`, `--scenario`,
`--implementation` задают продуктовые цели. `--request-id` задаёт идентификатор корреляции.
`--criteria <json>` принимает массив `{title,summary?,description?}` для атомарного
создания критериев вместе с задачей. Все критерии первоначально не выполнены.

### task get

`task get <reference>` читает полную задачу по ID или текущему/прежнему ключу.
Например: `relay-cli task get PRODUCT-1`.

### task list

Фильтры: `--board`, `--column`, `--q`, `--readiness ready|blocked`,
`--completion unfinished|finished`, `--search-in title|all`, `--product-target`.
Страницы: `--offset`, `--limit`, `--version`; по умолчанию 40, максимум 100.
Фильтрация выполняется до пагинации. `nextOffset: null` означает конец.

### task update

`task update <reference> --if-revision <n> [--title <text>] [--description <markdown>]`.
Переданные `--feature`, `--scenario`, `--implementation` заменяют набор продуктовых целей;
`--clear-product-links` очищает его. Неуказанные поля сохраняются.

### task move

`task move <reference> --column <column> --if-revision <n> [--board <board>] [--before-id <id>] [--if-version <version>]`.
Колонки: inbox, ready, in-progress, review, done, cancelled. Перенос сохраняет ID и связи.
Без before-id вставляет в конец. Невыполненные зависимости блокируют переход в done.

### task links

`task links <reference> [--offset <n>] [--limit <n>] [--version <version>]` читает
прямые и обратные связи с состояниями связанных задач.

### task link

`task link <reference> --target <reference> --relation depends-on|related|parent --if-revision <n> [--remove]`.
Изменяет связь между задачами одного проекта. Все записи канбана принимают `--request-id`.
[Контракт канбана](KANBAN.md).

## Обсуждения и история задачи

### task comment publish

`task comment publish <reference> --title <text> --description <markdown> --role <role> [--request-id <id>]`.
Глобальный `--actor` задаёт имя, role — operator/orchestrator/worker. Публикация не требует
ревизии карточки и допустима в любой колонке. После потери ответа сначала прочитайте
комментарии: безусловный повтор может создать дубликат. Ответ содержит ID сообщения и ревизию ленты.

### task comment list

`task comment list <reference> [--limit <n>] [--cursor <cursor>] [--after <n>] [--by <name>] [--action <action>]`.
Компактная лента от новых сообщений к старым. По умолчанию 20, максимум 100; команда
продолжения сохраняет фильтры. By — точное имя автора, after — последовательный номер;
совместимый action принимает только `comment-publish`.

### task comment get

`task comment get <reference> <entryId>` показывает автора, время и полный Markdown.
`--format json` возвращает точное содержание без терминального оформления.

Автоматическая история задач не ведётся; команды `task history` удалены.
Полные комментарии сохраняются. [Контракт](TASK-ACTIVITY.md).

## Критерии приёмки задачи

### task criterion list

`task criterion list <reference> [--offset <n>] [--limit <n>] [--version <version>]`.
Список заголовков, кратких описаний и отметок, по умолчанию 20, максимум 100;
показывает ревизию задачи и команду продолжения.

### task criterion get

`task criterion get <reference> <criterionId>` читает полный Markdown, состояние,
автора/время выполнения и ревизию задачи. `--format json` возвращает структурированный ответ.

### task criterion add

`task criterion add <reference> --title <text> [--summary <text>] [--description <markdown>] --if-revision <n>`.
Добавляет невыполненный критерий. Все записи критериев требуют автора и принимают
`--request-id`; после потери ответа сначала читается текущее состояние.

### task criterion update

`task criterion update <reference> <criterionId> --if-revision <n> [--title <text>] [--summary <text>] [--description <markdown>]`.
Непереданные поля сохраняются; изменение текста снимает выполнение.

### task criterion complete

`task criterion complete <reference> <criterionId> --if-revision <n>` отмечает выполнение
с автором и временем. Не закрывает задачу автоматически.

### task criterion reopen

`task criterion reopen <reference> <criterionId> --if-revision <n>` снимает отметку.

### task criterion remove

`task criterion remove <reference> <criterionId> --if-revision <n>` удаляет критерий.
Для любого изменения критериев готовая задача сначала возвращается из done.
Невыполненные критерии запрещают done, но не исключают задачу из ready.

## Граф

### graph list

`graph list [--root <ref>]` читает проектный граф. Параметры: `--type`, `--direction`,
`--profile all|context`, `--depth`, `--q`, `--offset`, `--limit`, `--snapshot-version`.

### graph context

`graph context <ref>` одним вызовом возвращает весь достижимый граф в обоих направлениях:
`root`, `version`, все `nodes/edges` и `complete: true`. Циклы и параллельные рёбра сохраняются.
У команды нет depth/offset/limit/profile: ограниченная выборка остаётся в `graph list`.
Полные тексты читаются отдельно. При превышении `--max-bytes` возвращается ошибка;
частичного успешного ответа нет. Пример:
`relay-cli graph context WEB-24 --format json --max-bytes 1048576`.

### graph link

`graph link --from <ref> --to <ref> --type <type> [--description <markdown>] --if-version <version>`.
Прямая запись предназначена для диагностики/ремонта; связь не меняет продуктовые линки
и статусы задач. Штатные действия выполняются предметными операциями, интеграцию с
движком обеспечивает их бекенд.

### graph update

`graph update <id> --description <markdown> --if-version <version>` меняет пояснение.

### graph unlink

`graph unlink <id> --if-version <version>` отзывает явную связь без записи общего аудита.

### graph apply

`graph apply --json '<массив операций>' --if-version <version>` атомарно выполняет пакет.
Все записи графа принимают автора и `--request-id`.

### graph migrate

`--local graph migrate` переносит v1 в раздельное хранение v2 с сохранением ID, текстов,
ревизий. [Гарантии и восстановление](GRAPH.md#переход-с-v1-и-обслуживание).

### graph reindex

`--local graph reindex` восстанавливает производные индексы связей, не создаёт аудит
и не заменяет явный `storage migrate`.

## Продукт

### product state

Полный снимок продуктовых записей и готовности; при большом объёме используйте адресное чтение.

### product overview

Компактный обзор паспорта, состава и готовности продукта.

### product list

Каталог: `--kind`, `--q`, `--offset`, `--limit`.

### product get

`product get <id>` читает запись по ID или ключу.

### product entities

Компактные цели: `--q`, `--kind`, `--application`, `--active`, `--offset`, `--limit`.

### product context

`product context [--id <id>] [--application <id>]` читает требования и связанные материалы.

### product validate

Проверяет продуктовые инварианты.

### product lint

Проверяет структуру содержания: `--id`, `--offset`, `--limit`. Предупреждение не означает
неверного требования; отсутствие предупреждений не доказывает полноту.

### product migrate

Локальная миграция продуктового хранения; [гарантии](PRODUCT.md#json-хранилище).

### product save

`product save --json '<операция>' [--description <markdown>] [--body <markdown>]`.
Предметные команды ниже предпочтительнее для обычного ввода.

### product passport create

Создаёт паспорт: `--name`, `--summary`, `--description`.

### product passport update

`product passport update <id>` заменяет паспорт с `--if-revision`.

### product feature create

Создаёт фичу: `--name`, `--summary`, `--description`.

### product feature update

`product feature update <id>` заменяет содержание с `--if-revision`.

### product scenario create

Создаёт сценарий: `--name`, `--feature`, `--description`.

### product scenario update

`product scenario update <id>` сохраняет сценарий с `--if-revision`.

### product application create

Создаёт приложение и доску: `--name`, `--slug`, `--prefix`, `--type`, `--summary`, `--description`.

### product application update

`product application update <id>` изменяет содержание; slug и prefix неизменяемы.

### product document create

Создаёт материал: `--name`, `--summary`, `--body`, `--document-kind`, `--links '<JSON>'`.

### product document update

`product document update <id>` заменяет материал и связи с `--if-revision`.
Предметные create/update принимают `--request-id`; состав полей уточняйте через --help.

### product scope replace

`product scope replace <applicationId> --json '<контракты>' --if-revision <n> --if-version <version>`.
Снимает отсутствующие вклады, сохраняя их идентичность.

### product contract update

`product contract update <id> --application <id> --status <status> --if-revision <n> --if-version <version>`.
Допустимы `--title`, `--description`, `--request-id`.
Переданный status сохраняется как совместимая прежняя отметка; фактическая готовность
поднимается по каскаду задача → реализация приложения → фича/сценарий, а не этой командой.

### product implementation update

`product implementation update <ref> --if-revision <n>` меняет отдельную реализацию:
`--title`, `--description`, `--status`, `--key`, `--request-id`. [Модель продукта](PRODUCT.md).

## Движок сущностей

Общие страницы: `--limit`, `--offset`, `--snapshot-version`.

### entities types

Каталог девяти видов и операций.

### entities type

`entities type <kind>` — схема данных, создания, изменения и фильтров.

### entities list

Фильтры: `--kind`, `--q`, `--refs`, `--board`, `--application`, `--feature`, `--scenario`,
`--target`, `--parent`, `--status`, `--active`, `--sort key|title|updated`.
Для документов: `--section <id>` (none — без раздела), `--document-kind`,
`--pinned true|false`, `--archived true|false`.

### entities get

`entities get <ref> [--kind <kind>]` — полное содержание.

### entities resolve

`entities resolve <ref> [--kind <kind>]` — постоянный адрес и ключ.

### entities keys

`entities keys <ref>` — текущий ключ и алиасы.

### entities key-spaces

`entities key-spaces <kind>` — владельцы нумерации.

Общий автоматический audit отсутствует; команда `entities history` удалена.

### entities create

`entities create <kind>` принимает предметные поля: `--name`, `--title`, `--summary`,
`--description`, `--body`, `--feature`, `--application`, `--target`, `--board`, `--slug`,
`--prefix`, `--type`, `--document-kind`, `--status`, `--column`, `--parent`, `--targets`,
`--dependencies`, `--related`, `--json`, `--request-id`. Допустимость определяет вид.
Поля библиотеки: `--document-status draft|active|archived`, `--section-id`, `--clear-section`,
`--pinned true|false`, `--relations '<JSON>'` (продуктовые линки target/type/description),
`--document-sections '<JSON>'` (разделы проекта id/name). Эти поля не создают рёбра графа
без явной интеграции предметной операции с движком Core.

### entities update

`entities update <ref> --if-revision <n>` меняет переданные поля из того же набора;
вид определяется по выбранной сущности.

### entities rename

`entities rename <ref> <key> --if-revision <n>` меняет ключ с сохранением ID и алиасов.

### entities move-task

`entities move-task <ref> --column <column> --if-revision <n>`; необязательные `--board`, `--before`.

### entities link-task

`entities link-task <ref> --target <ref> --relation <relation> --if-revision <n> [--remove]`.
Все записи требуют автора и поддерживают `--request-id`. [Контракт](ENTITIES.md).
