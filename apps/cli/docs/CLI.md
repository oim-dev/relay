# Справочник Relay CLI

CLI — прежде всего интерфейс агента к памяти проекта, с отдельным человеческим
представлением. Этот документ — канонический справочник синтаксиса CLI: команды,
параметры, ввод, ответы и ограничения. Команда установленного пакета — `relay-cli`;
без установки используйте `npx @oim-dev/relay-cli` вместо этого имени.

Общий смысл операций принадлежит [предметным контрактам](https://github.com/oim-dev/relay/blob/main/docs/domain/README.md),
покрытие интерфейсов — [матрице возможностей](https://github.com/oim-dev/relay/blob/main/docs/CAPABILITIES.md).
Оформление объясняет [терминальный справочник](TERMINAL.md), разработку —
[расширение CLI](EXTENDING.md). Внешние ссылки ведут на `main`; локальные документы
доступны и в архиве пакета. `relay-cli <команда> --help` уточняет установленный синтаксис.

## Содержание

- [Вызов и подключение](#вызов-и-подключение)
- [Ввод, запись и восстановление](#ввод-запись-и-восстановление)
- [Ответы, ошибки и страницы](#ответы-ошибки-и-страницы)
- [Проект и workspace](#проект-и-workspace)
- [Общие операции сущностей](#общие-операции-сущностей)
- [Продукт](#продукт)
- [Доски и задачи](#доски-и-задачи)
- [Критерии и обсуждения](#критерии-и-обсуждения)
- [Планы](#планы)
- [Релизы](#релизы)
- [Прогресс](#прогресс)
- [Граф](#граф)
- [Обслуживание](#обслуживание)

## Вызов и подключение

Первый запуск для агента начинается с установки Relay skill и инициализации проекта;
подробности — [начало работы](https://github.com/oim-dev/relay/blob/main/docs/guides/GETTING_STARTED.md).

```bash
npx skills add oim-dev/relay
npx @oim-dev/relay-cli init
```

Затем сохраняйте знания проекта и создавайте задачи на их основе. Skill не является
runtime-зависимостью команд чтения или ручного обслуживания. Ниже — примеры команд
CLI, а не замена подготовки знаний созданием первой задачи:

```bash
npx @oim-dev/relay-cli task list --format json
relay-cli --actor agent task create --board product --title 'Реализовать согласованный сценарий'
relay-cli task get PRODUCT-1 --format json
```

Синтаксис: `relay-cli [глобальные параметры] [проект] <команда> [аргументы]`.
`<...>` означает обязательное значение, `[...]` — необязательное, `...` внутри
параметра — несколько отдельных аргументов. Кавычки в примерах рассчитаны на POSIX shell.
Группа без подкоманды показывает справку. Справка и версия не требуют конфигурации.

| Глобальный параметр   | Назначение                                                                        |
| --------------------- | --------------------------------------------------------------------------------- |
| `-h, --help`          | Справка выбранной команды, аргументы и примеры                                    |
| `-V, --version`       | Версия CLI; не версия записи или страницы                                         |
| `--config <path>`     | Нестандартный путь `.relay/config.json` или `relay.workspace.json`                |
| `--project <name>`    | Проект workspace; альтернатива префиксу `relay-cli <проект> ...`, не вместе с ним |
| `--server-url <url>`  | HTTP-сервер вместо прямого Core                                                   |
| `--local`             | Прямой локальный Core, игнорируя URL; не применим к workspace                     |
| `--actor <id>`        | Автор предметного изменения; приоритет над `RELAY_ACTOR`                          |
| `--format <format>`   | `json` для автоматизации, `text` для терминала                                    |
| `--color <mode>`      | `auto`, `always`, `never`; JSON всегда без ANSI                                   |
| `--max-bytes <bytes>` | Бюджет всего ответа UTF-8, 1024–134217728 байт                                    |

Конфиг выбирается через `--config` → `RELAY_CONFIG` → поиск вверх от cwd.
В одном каталоге `relay.workspace.json` имеет приоритет над `.relay/config.json`.
Обычный local без URL использует Core. URL выбирается через `--server-url` →
`RELAY_SERVER_URL` → `server.url`; `--local` явно выбирает файлы.
Явный URL позволяет работать без локального конфига. Ошибка HTTP не переключает
клиента на локальную базу. Workspace всегда использует сервер и явный проект.

```bash
relay-cli frontend task list --format json
relay-cli --server-url http://127.0.0.1:4700 --project frontend task list --format json
relay-cli --config /work/shared/.relay/config.json config get
```

Конфигурация и переменные окружения подробно описаны в
[project-runtime](https://github.com/oim-dev/relay/blob/main/packages/project-runtime/docs/CONFIGURATION.md),
HTTP — в [API](https://github.com/oim-dev/relay/blob/main/packages/server-runtime/docs/API.md).

## Ввод, запись и восстановление

Сначала прочитайте полную запись и её ревизию. Списки обычно содержат лишь краткие
карточки. В ссылочных аргументах используйте ключ или ID там, где это явно разрешено;
`kind:ID` уточняет вид. Для параметров, требующих постоянный ID, получите его через
`entities resolve` или карточку. Все адреса относятся к выбранному проекту.

Предметная запись требует `--actor <id>` либо `RELAY_ACTOR`. Существующая запись
обычно требует `--if-revision <n>`; граф — `--if-version <version>`, состав продукта —
оба значения. Исключения перечислены у команд: например, публикация комментария
не требует ревизии задачи. Инициализация и техническое обслуживание имеют отдельные правила.

`--request-id <id>` в командах записи — необязательная корреляция, по умолчанию UUID.
В `product save` это поле `requestId` JSON. **Это не ключ дедупликации**:
первоначальная квитанция не хранится для повтора. После потери ответа прочитайте
содержание, комментарии и отношения и решите, нужно ли новое действие. Создание
или публикация повторно могут создать дубликат. При конфликте перечитайте запись
и согласуйте поля, не подставляйте новую ревизию к старому содержимому автоматически.
Команд истории изменений и чтения сохранённых результатов запросов нет.

Заголовок/название — одна строка; `summary` — обычный многострочный текст;
`description`, `body`, цель, результат и пояснения — Markdown. Передавайте полный
текст непосредственно аргументом, сохраняя пустые строки и отступы. Временный файл
не обязателен; флаги `--description-file` или `--stdin` в описанных командах не зарегистрированы.

```bash
relay-cli --actor agent entities create document --name 'Правила проверки' \
  --document-kind rules --body '## Проверка

1. Открыть карточку.
2. Сравнить сохранённое содержание.

    Значимые отступы сохраняются.
'
relay-cli --actor agent task update PRODUCT-1 --if-revision 1 \
  --description '## Цель

Сохранить требования пользователя без потери содержания.

## Проверка

- Прочитать запись после изменения.'
```

Число `1` в примере замените фактически прочитанной ревизией. Общие правила
[сохранения и восстановления](https://github.com/oim-dev/relay/blob/main/docs/domain/STORAGE.md)
действуют независимо от транспорта. Предметная команда выполняет действие вместе
с необходимыми связями; второй клиентский вызов `graph link` для синхронизации не нужен.

## Ответы, ошибки и страницы

`--format json` выдаёт один конверт в stdout, без баннеров и ANSI:

```json
{ "ok": true, "data": {}, "meta": { "project": "frontend" } }
```

```json
{
  "ok": false,
  "error": { "code": "ACTOR_REQUIRED", "message": "Для записи укажите --actor или RELAY_ACTOR" }
}
```

Это примеры формы, не полные DTO. `data` сохраняет предметные поля; необязательная
`meta` содержит контекст, например явно выбранный проект. Ответ записи сообщает
результат, ID/ключ и ревизию, если они предусмотрены операцией, и корреляцию запроса.
Сохраните нужные значения в ходе сценария, но не рассчитывайте получить эту же
квитанцию отдельной командой позже. `text` — представление для человека, не формат
для разбора скриптом; технические команды реестра могут показывать структурированные значения.

Успех завершает процесс с кодом 0, ошибка — ненулевым кодом `AppError`.
Штатные ошибки также идут в stdout, stderr остаётся чистым. Синтаксическая ошибка
`INVALID_ARGUMENT` указывает справку команды и код завершения 2. Help и версия —
текстовые исключения даже при `--format json`. Закрытый получателем pipe (`EPIPE`)
завершается с кодом 0.

| Ситуация                                                    | Следующий шаг                                                                        |
| ----------------------------------------------------------- | ------------------------------------------------------------------------------------ |
| `CONFIG_NOT_FOUND`, `PROJECT_REQUIRED`, `REGISTRY_REQUIRED` | Проверить каталог, режим и выбор проекта; не создавать новую базу вместо неизвестной |
| `ACTOR_REQUIRED`                                            | Указать автора записи                                                                |
| `INVALID_ARGUMENT`, `INVALID_JSON`                          | Исправить синтаксис/JSON, сверить параметры конкретной команды                       |
| Конфликт ревизии или версии                                 | Перечитать состояние; заново согласовать запись либо начать страницы с начала        |
| Неизвестная сущность                                        | Проверить проект и адрес через `entities resolve`                                    |
| Ошибка целостности                                          | Не считать проект пустым; сохранить копию и выполнить диагностику                    |
| `LOCAL_REQUIRED`, `LOCAL_ONLY`                              | Для обслуживания выбрать локальный проект, не workspace/HTTP                         |
| `RESPONSE_TOO_LARGE`                                        | Уменьшить страницу, выбрать запись/область либо увеличить `--max-bytes`              |

По умолчанию бюджет 16384 байта, если конфиг его не переопределил. Он ограничивает
полный сериализованный ответ выбранного формата, включая конверт. Большой неделимый
ответ не становится частичным успехом. Ошибка бюджета содержит `requiredBytes` и
`maxBytes`, если подробности помещаются. Слишком большие подробности ошибки заменяются
`{omitted:true}`. Ошибка вывода после записи **не доказывает, что запись не произошла**.

### Правила продолжения

| Семейство                                          | Параметры страницы                                                               | Как продолжать                                                                     |
| -------------------------------------------------- | -------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------- |
| `entities types/list/keys/key-spaces`              | `--offset <n>`, `--limit <n>` (1–100, обычно 40), `--snapshot-version <version>` | `nextOffset` и `version` из первой страницы                                        |
| `plan`, списки `release`, `progress`, `graph list` | `--offset <n>`, `--limit <n>` (1–100), `--snapshot-version <version>`            | Сохранить версию; для `progress` один offset/limit применяется к каждому списку    |
| `boards`, `task list/links`, `task criterion list` | `--offset <n>`, `--limit <n>` (1–100), `--version <version>`                     | Локальный параметр версии страницы стоит после команды, не вместо глобального `-V` |
| `product list/entities/lint`                       | `--offset <n>`, `--limit <n>` (1–100)                                            | Только `nextOffset`; согласованный снимок между страницами не гарантируется        |
| `task comment list`                                | `--limit <n>` (1–100, по умолчанию 20), `--cursor <cursor>`                      | Продолжать по возвращённому курсору, в том числе после пустой страницы             |

Смещение начинается с 0, `nextOffset: null` означает конец offset-списка.
Не подменяйте размер страницы общей полнотой. Для комментариев курсор сохраняет
снимок и фильтры; `--after` задаёт нижнюю границу последовательного номера.
Продолжение должно сохранять проект, конфиг, фильтры и сортировку исходного запроса.
При конфликте снимка начните заново. У `product list/entities` возвращаемая `version`
не принимается параметром продолжения; для согласованного каталога используйте `entities list`.

```bash
relay-cli entities list --kind document --limit 10 --format json
relay-cli entities list --kind document --limit 10 --offset 10 \
  --snapshot-version 'ВЕРСИЯ_ПЕРВОЙ_СТРАНИЦЫ' --format json
relay-cli task list --limit 10 --offset 10 --version 'ВЕРСИЯ_ПЕРВОЙ_СТРАНИЦЫ' --format json
```

Далее у каждого листа указаны собственные параметры; глобальные доступны всем.
Обозначение **страница снимка** означает offset/limit/snapshot-version из таблицы,
**страница задач** — offset/limit/version, **страница продукта** — только offset/limit.
«Чтение» не меняет предметные записи; «Запись» и «Обслуживание» явно изменяют данные.

## Проект и workspace

### init

`relay-cli init [--storage <path>]` — локальное создание конфига и единого хранилища.
Ответ: `configPath`, `storageDir`. Существующие данные не заменяются. `--storage`
(по умолчанию `tasks`) — совместимая привязка старого `storageDir/runtime`, не отдельная
база задач нового формата. Для нестандартного пути используйте глобальный `--config`.
При явно настроенном HTTP локальная инициализация требует `--local`. Автор не требуется.

### validate

`relay-cli validate` — чтение и проверка схем, сущностей, досок, задач и отношений.
Возвращает показатели проверенного хранилища; нарушение целостности — ошибка, код 5,
а не пустой список. Полезно после Git-слияния и обслуживания. Собственных параметров нет.

### config get

`relay-cli config get` — чтение актуальной конфигурации. `data` содержит конфиг,
`meta.configPath` и `meta.storagePath` — пути. Это не команда изменения настроек;
собственных параметров нет. Имя проекта меняется через `entities update PROJECT`,
смены slug проекта в CLI нет.

### projects init

`relay-cli projects init` — локальная запись пустого workspace-реестра.
`--config` либо `RELAY_CONFIG` выбирает путь вместо обычного `relay.workspace.json`.
Проектный префикс и `--project` здесь недопустимы. Автор и ревизия не нужны.

### projects list

`relay-cli projects list` — чтение регистраций через Relay Server по workspace-конфигу.
Возвращает доступные проекты; собственных флагов и страниц нет. Не принимает `--local`
или выбранный `--project`. Это реестр подключений, не каталог продуктовых приложений.

### projects add

`relay-cli projects add <name> [path] [--project-config <path>] [--replace]` — запись
регистрации через сервер. `name` — имя в workspace, `path` — каталог проекта относительно
workspace-конфига; `--project-config` — конфиг относительно этого каталога.
`--replace` разрешает заменить существующее подключение. Подключает инициализированный
проект, не заменяет `init`; автора и ревизии не требует. Ответ содержит результат регистрации.

### projects remove

`relay-cli projects remove <name>` — удаление регистрации через сервер без удаления
проектных данных. `name` — имя регистрации. Собственных параметров, автора и ревизии нет.
Как и другие команды реестра, не принимает выбор отдельного проекта.

## Общие операции сущностей

Каталог знает `project`, `product`, `feature`, `scenario`, `application`,
`implementation`, `board`, `task`, `document`, `work-plan`, `release`.
Наличие вида в чтении не означает возможность generic create/update.
Схемы и доступные действия возвращает `entities type`; общих команд удаления нет.

### entities types

`relay-cli entities types` — чтение каталога видов, назначения, правил ключей и действий,
в том числе в пустом проекте. Параметры: страница снимка. Ответ: `items`, `total`,
`nextOffset`, `version`.

### entities type

`relay-cli entities type <kind>` — чтение контракта указанного вида: `schema`,
`createSchema`, `updateSchema`, фильтры и действия. `null` вместо схемы означает,
что эта generic-операция для вида не предоставлена. Собственных параметров нет.

### entities list

`relay-cli entities list` — чтение кратких карточек, не полного Markdown.
Параметры: страница снимка и следующие фильтры, применяемые до пагинации:

| Параметр                              | Выбор                                                                       |
| ------------------------------------- | --------------------------------------------------------------------------- |
| `--kind <kind>`                       | Вид сущностей                                                               |
| `--q <text>`                          | Ключ, ID, название, краткое описание; для документов также поиск содержания |
| `--refs <refs...>`                    | До 100 выбранных ключей/ID                                                  |
| `--board <ref>`                       | Доска задач                                                                 |
| `--application <ref>`                 | Приложение                                                                  |
| `--feature <ref>`, `--scenario <ref>` | Родительская фича или сценарий                                              |
| `--target <ref>`                      | Явная продуктовая цель                                                      |
| `--parent <ref>`                      | Родитель задачи                                                             |
| `--status <status>`                   | Предметное состояние вида                                                   |
| `--active <value>`                    | Участие реализации: `true`/`false`                                          |
| `--section <id>`                      | Раздел документов, `none` — без раздела                                     |
| `--document-kind <kind>`              | Тип документа                                                               |
| `--pinned <value>`                    | Закрепление: `true`/`false`                                                 |
| `--archived <value>`                  | Только архив / исключить архив: `true`/`false`                              |
| `--sort <field>`                      | `key`, `title`, `updated`                                                   |

Ответ: карточки в `items` и показатели страницы. Для полного содержания вызовите `get`.

### entities get

`relay-cli entities get <ref> [--kind <kind>]` — полное чтение по ключу, ID или `kind:ID`.
`--kind` уточняет ожидаемый вид при неоднозначности. Ответ содержит `ref`, `key`,
`revision`, типизированные `data` и краткие `references`.

### entities resolve

`relay-cli entities resolve <ref> [--kind <kind>]` — разрешение ключа/алиаса/ID в постоянный
адрес. `--kind` уточняет вид. Чтение; результат нужен для параметров, принимающих только ID.

### entities keys

`relay-cli entities keys <ref>` — чтение текущего ключа и прежних алиасов записи.
Параметры: страница снимка. Это не история содержания.

### entities key-spaces

`relay-cli entities key-spaces <kind>` — чтение пространств нумерации и шаблонов ключей
указанного вида. Параметры: страница снимка.

### entities create

`relay-cli --actor agent entities create <kind> [поля] [--request-id <id>]` — запись
одной сущности. Поддержаны `product`, `feature`, `scenario`, `application`,
`implementation`, `task`, `document`. Ключ назначает Core. Ответ: `ref`, `key`,
`revision`, `requestId`, `action`. Поля описаны ниже; нерелевантные виду отклоняются.

### entities update

`relay-cli --actor agent entities update <ref> --if-revision <n> [поля] [--request-id <id>]`
— частичное изменение. Вид разрешается по адресу; отсутствие поля сохраняет значение.
Результат имеет ту же форму, что create. Поддержаны также имя и разделы `project`,
но не `board`, `work-plan`, `release`: для планов и релизов есть предметные команды.
Ревизия — прочитанная, неотрицательное целое.

#### Поля generic create/update

Все эти флаги зарегистрированы у обеих команд; допустимость определяется видом и действием.
`--json <json>` принимает **объект полей**, не конверт операции. Явные параметры
переопределяют поля JSON; `--clear-section` задаёт `sectionId:null`.

| Флаг                                              | Поле и применение                                                                                          |
| ------------------------------------------------- | ---------------------------------------------------------------------------------------------------------- |
| `--name <text>`                                   | `name`: продукт, фича, сценарий, приложение, документ; при update также проект                             |
| `--title <text>`                                  | `title`: задача или реализация                                                                             |
| `--summary <text>`                                | `summary`: обычный многострочный текст продукта, фичи, приложения, документа                               |
| `--description <markdown>`                        | `description`: полное описание, кроме документа (у него body)                                              |
| `--body <markdown>`                               | `body`: полный текст документа                                                                             |
| `--feature <ref>`                                 | `featureId`: родитель создаваемого сценария                                                                |
| `--application <ref>`, `--target <ref>`           | Приложение и фича/сценарий создаваемой реализации                                                          |
| `--board <ref>`                                   | Доска создаваемой задачи                                                                                   |
| `--slug <slug>`, `--prefix <prefix>`              | Адрес и префикс создаваемого приложения                                                                    |
| `--type <type>`                                   | Приложение: `frontend`, `backend`, `internal`                                                              |
| `--document-kind <kind>`                          | `documentKind`: `specification`, `description`, `rules`, `instruction`, `proposal`, `decision`, `research` |
| `--document-status <state>`                       | `documentStatus`: `draft`, `active`, `archived`                                                            |
| `--section-id <id>`, `--clear-section`            | `sectionId`: раздел документа или отсутствие раздела                                                       |
| `--pinned <value>`                                | `pinned`: строго `true` или `false`                                                                        |
| `--relations <json>`                              | Полный массив адресных отношений документа                                                                 |
| `--document-sections <json>`                      | Полный упорядоченный массив разделов проекта; только update project                                        |
| `--status <status>`                               | Совместимая ручная отметка реализации: `none`, `partial`, `done`, не вычисленная готовность                |
| `--column <column>`                               | Начальная колонка создаваемой задачи                                                                       |
| `--parent <ref>`                                  | Родитель создаваемой задачи                                                                                |
| `--targets <refs...>`                             | Продуктовые цели задачи или прежние области документа; update заменяет весь набор                          |
| `--dependencies <refs...>`, `--related <refs...>` | Зависимости и обычные связи создаваемой задачи                                                             |
| `--json <json>`                                   | Дополнительные типизированные поля; например `{"targets":[]}` для очистки                                  |
| `--request-id <id>`                               | Корреляция; не безопасный повтор                                                                           |

При создании продукта/фичи нужны `name`, непустой Markdown `description`; для сценария
также `featureId`; для приложения — `slug`, `type`. `summary` для продукта, фичи,
приложения и документа CLI по умолчанию задаёт пустым. У реализации обязательны
`application`, `target`, `title`, `description`. У задачи обязательна доска;
заголовок/описание могут быть пусты, начальная колонка `inbox`. Через `--json` при
создании задачи также доступен `acceptanceCriteria` — массив до 100 объектов
`{title,summary,description}`. Для документа нужны `name`, `body`, `documentKind`.

Update сценария не меняет фичу; update приложения — slug/prefix; update реализации —
application/target. Update задачи меняет только title/description/targets:
перемещение и связи задач выполняются отдельными командами, критерии — `task criterion`.
Имя проекта доступно, slug проекта — нет. Перечитайте `entities get PROJECT`, затем:

```bash
relay-cli --actor agent entities update PROJECT --if-revision 1 --name 'Мой проект'
relay-cli --actor agent entities update PROJECT --if-revision 2 \
  --document-sections '[{"id":"guides","name":"Руководства"}]'
relay-cli --actor agent entities update DOC-1 --if-revision 1 \
  --document-status active --section-id guides --pinned true
```

`documentSections` полностью заменяет массив: сохраняйте ID при переименовании,
меняйте порядок элементов для сортировки, исключайте элемент для удаления раздела.
Не заменяйте остальные разделы случайно. Пустой массив удаляет все разделы, не документы.
Адресное отношение документа имеет форму
`{"target":{"kind":"task","id":"ПОСТОЯННЫЙ_ID"},"type":"documents","description":"Markdown"}`;
тип также может быть `references`. `--relations '[]'` снимает все такие отношения.
`--clear-section` оставляет документ без раздела; `--pinned false` открепляет.
`--document-kind decision` меняет тип предложения на решение, но не доказывает внешнюю приёмку.
Семантика библиотеки — [документы](https://github.com/oim-dev/relay/blob/main/docs/domain/DOCUMENTS.md).

### entities rename

`relay-cli --actor agent entities rename <ref> <key> --if-revision <n> [--request-id <id>]`
— запись нового читаемого ключа. `<key>` — новый ключ, не название или slug.
ID/связи сохраняются, старый ключ остаётся алиасом; коллизия отклоняется.
Ответ — квитанция сущности, как create/update.

### entities move-task

`relay-cli --actor agent entities move-task <ref> --column <column> --if-revision <n>`
— перемещение задачи. Дополнительно: `--board <ref>` — новая доска,
`--before <ref>` — следующая задача по ключу/ID (без него конец колонки),
`--request-id <id>`. Ответ — квитанция. Колонки: `inbox`, `ready`, `in-progress`,
`review`, `done`, `cancelled`. При смене доски ID остаётся прежним.

### entities link-task

`relay-cli --actor agent entities link-task <ref> <target> --relation <relation> --if-revision <n>`
— предметная связь двух задач по ключам/ID. `--relation`: `depends-on`, `related`,
`parent` (target — родитель ref). `--remove` снимает связь; `--request-id <id>` — корреляция.
Ответ — квитанция. Это правильный путь для зависимостей задач, не `graph link`.

## Продукт

Назначение паспорта, фич, сценариев, приложений и реализаций описывает
[продуктовый контракт](https://github.com/oim-dev/relay/blob/main/docs/domain/PRODUCT.md).
Здесь `passport` — имя паспорта в предметном API; generic-вид называется `product`.

### product state

`relay-cli product state` — чтение полного снимка продукта с `records` и `version`.
Параметров и страниц нет; для большой базы используйте адресное чтение либо увеличьте бюджет.

### product overview

`relay-cli product overview` — чтение компактной карты продукта и версии каталога.
Собственных параметров нет. `version` нужна при замене состава приложения.

### product list

`relay-cli product list [--kind <kind>] [--q <text>]` — чтение записей с поиском,
включая Markdown. Виды: `passport`, `feature`, `scenario`, `application`, `scope`,
`document`. Параметры: страница продукта; ответ содержит `nextOffset` и `version`,
но передать version для продолжения нельзя.

### product get

`relay-cli product get <id>` — полная запись по ID/ключу, включая реализации
(`WEB-FI-12`); `passport` открывает паспорт. Результат содержит содержание и ревизию
для следующей записи. Собственных параметров нет.

### product entities

`relay-cli product entities` — чтение компактных целей связи, без полного содержания.
Параметры: `--q <text>` — ключ/название; `--kind <kind>` — `feature`, `scenario`,
`application`, `implementation`, `passport`, `document`; `--application <ref>` —
приложение; `--active <value>` — `true`/`false`; страница продукта.
Не гарантирует снимок между страницами.

### product context

`relay-cli product context [--id <id>] [--application <id>]` — чтение предметной
подборки паспорта, требований, реализаций и документов с причинами включения.
`--id` выбирает цель, `--application` — приложение-реализатор. Это не полный обход графа;
параметров глубины и страниц нет.

### product validate

`relay-cli product validate` — чтение состояния продукта с проверками целостности.
Ответ: `valid`, число `records`, `version`. Собственных параметров нет; не оценивает
содержательную полноту требований.

### product lint

`relay-cli product lint [--id <id>]` — чтение предупреждений о структуре описаний.
Параметры: страница продукта (offset предупреждений, limit 1–100). Без `--id`
проверяет продукт целиком. Ничего не исправляет и не заменяет приёмку.

### product save

`relay-cli --actor agent product save --json <json> [--description <markdown>] [--body <markdown>]`
— запись по JSON операции. Обязателен объект `fields`, содержащий `kind` и поля вида;
`action` — `create`/`update`, при update нужны `id` и прочитанная `ifRevision`.
Для scope/contract применяется `ifVersion`. `requestId` можно задать внутри JSON;
при отсутствии CLI создаёт UUID. Прямые `--description`/`--body` заменяют одноимённое
поле `fields`. Ответ: ID/ключ, ревизия и requestId.

```bash
relay-cli --actor agent product save --json '{"action":"create","fields":{"kind":"feature","name":"Поиск","summary":"Поиск документов","description":"## Поведение\n\nПользователь находит документ по тексту."}}'
```

Поля обычных видов описаны ниже; `fields.kind` допускает также `scope`, `contract`,
`implementation`. Scope: `applicationId`, `contracts` (как `product scope replace`);
contract: `applicationId`, `contractId`, `status`, необязательные title/description;
implementation: `applicationId`, `featureId`, `scenarioId` (null для FI), title,
description, status. Для документов здесь доступны также `documentStatus`, `sectionId`,
`pinned`, `relations`; прежние `links` обязательны в полном содержании документа.
Ссылки продукта в JSON допускают ключи/ID там, где схема использует ref.

#### Общие флаги предметных create/update

У `product passport/feature/scenario/application/document create/update` один набор
регистрации. Это **полное содержание**, не частичный patch. Update требует прочитанной
`--if-revision`, хотя Commander не помечает этот флаг обязательным.

| Параметр                   | Назначение и фактическое применение                                                                               |
| -------------------------- | ----------------------------------------------------------------------------------------------------------------- |
| `--name <name>`            | Обязательное название у всех пяти видов                                                                           |
| `--summary <text>`         | Краткое описание; по умолчанию пустое; не передаётся сценарию                                                     |
| `--description <markdown>` | Непустое полное описание паспорта, фичи, сценария, приложения                                                     |
| `--body <markdown>`        | Непустой полный текст только документа                                                                            |
| `--type <type>`            | Только приложение: frontend/backend/internal, по умолчанию frontend                                               |
| `--feature <id>`           | Только сценарий: родительская фича                                                                                |
| `--links <json>`           | Только документ: массив прежних продуктовых областей, по умолчанию `[]`                                           |
| `--document-kind <kind>`   | Только документ: specification/description/rules/instruction/proposal/decision/research; по умолчанию description |
| `--if-revision <n>`        | Прочитанная ревизия для update; неотрицательное целое                                                             |
| `--request-id <id>`        | Корреляция, по умолчанию UUID                                                                                     |
| `--slug <slug>`            | Только приложение, обязателен и при create, и при update; изменить существующий нельзя                            |
| `--prefix <prefix>`        | Только приложение: неизменяемый префикс задач; при создании по умолчанию из slug                                  |

Флаги другого вида могут приниматься парсером, но не передаются в его поля:
например, `--description` не заменяет `--body` документа. Не используйте их как
обход схемы. `links` документа: `{kind:"product"}`, либо `{kind:"feature"|"scenario"|"application",id}`,
либо `{kind:"implementation",applicationId,id}`. Это не `relations` современной библиотеки.
Для частичной правки и всех полей библиотеки предпочтительны `entities update`.

### product passport create

`relay-cli --actor agent product passport create --name <name> --description <markdown>`
— создание паспорта. Дополнительно общие флаги выше, по смыслу `--summary` и метаданные записи.
Ответ — сохранённая запись: ID/ключ и ревизия, requestId.

### product passport update

`relay-cli --actor agent product passport update <id> --name <name> --description <markdown> --if-revision <n>`
— полная запись паспорта; `<id>` — адрес прочитанной записи. Общие флаги выше.
Передайте актуальный `--summary`, если его нужно сохранить. Ответ — квитанция продукта.

### product feature create

`relay-cli --actor agent product feature create --name <name> --description <markdown>`
— создание фичи. Общие флаги, включая `--summary`, выше. Ответ — квитанция продукта.

### product feature update

`relay-cli --actor agent product feature update <id> --name <name> --description <markdown> --if-revision <n>`
— полная запись фичи по прочитанному адресу; общие флаги выше. Возвращает квитанцию,
не устанавливает вычисленную готовность фичи вручную.

### product scenario create

`relay-cli --actor agent product scenario create --name <name> --feature <id> --description <markdown>`
— создание сценария в фиче. Общие флаги выше; сохраняются name/featureId/description,
не summary. Ответ — квитанция продукта.

### product scenario update

`relay-cli --actor agent product scenario update <id> --name <name> --feature <id> --description <markdown> --if-revision <n>`
— полная запись сценария. Передайте его существующую фичу; это не команда переноса.
Общие флаги выше. Ответ — квитанция продукта.

### product application create

`relay-cli --actor agent product application create --name <name> --slug <slug> --description <markdown>`
— создание приложения и его доски. Общие флаги выше; `--type` выбирает frontend,
backend или internal, `--prefix` задаёт префикс задач. Slug: строчные латинские буквы,
цифры и дефисы. Ответ — квитанция продукта.

### product application update

`relay-cli --actor agent product application update <id> --name <name> --slug <slug> --description <markdown> --if-revision <n>`
— полная запись приложения. Сохраните прочитанные slug/prefix/type/summary;
slug и prefix неизменяемы. Общие флаги выше. Ответ — квитанция продукта.

### product document create

`relay-cli --actor agent product document create --name <name> --body <markdown>`
— создание документа; общие флаги выше, включая `--document-kind`, `--summary`, `--links`.
Ответ — квитанция продукта. Для раздела, состояния, закрепления и адресных отношений
используйте `entities create document` либо `product save`.

### product document update

`relay-cli --actor agent product document update <id> --name <name> --body <markdown> --if-revision <n>`
— полная запись документа. Общие флаги выше; не забывайте существующие summary/kind/links.
Для безопасного изменения только отдельных полей используйте `entities update`.

### product scope replace

`relay-cli --actor agent product scope replace <applicationId> --json <json> --if-revision <n> --if-version <version> [--request-id <id>]`
— замена **всего** активного состава приложения по ID/ключу. Версия — из overview,
ревизия состава — из get, 0 для нового. JSON — массив до 10000 контрактов
`{featureId,scenarioId,title,description,status}`; scenarioId=null для FI, иначе SI;
status — none/partial/done. Ключи/ID в ссылках допустимы. Для существующих элементов
можно передать прочитанные `key`, `revision`. `[]` снимает участие, не удаляет адреса
реализаций. Ответ — квитанция продукта. Это не команда очистки истории.

### product contract update

`relay-cli --actor agent product contract update <id> --application <id> --status <status> --if-revision <n> --if-version <version>`
— точечная запись контракта в составе приложения. `<id>` — контракт, `--application` —
приложение; ревизия относится к составу, version — к продукту. Дополнительно:
`--title <text>`, `--description <markdown>`, `--request-id <id>`.
Status none/partial/done — совместимая отметка, не доказательство вычисленной готовности.
Ответ — квитанция продукта; соседние контракты не заменяются.

### product implementation update

`relay-cli --actor agent product implementation update <ref> --if-revision <n>` —
запись отдельной реализации по её собственной ревизии (положительное целое).
Поля: `--title <text>`, `--description <markdown>`, `--status <status>` (none/partial/done),
`--key <key>` — свободный новый ключ, `--request-id <id>`. Соседние реализации
не изменяются; ручной status не переопределяет расчёт готовности. Ответ: ID/ключ,
revision, requestId.

### product migrate

`relay-cli --local product migrate` — совместимая локальная команда без изменения
формата 4: результат `migrated: 0`. **Не переносит старую базу**; вне текущего формата
нужна `storage migrate`. Собственных параметров и автора нет. Старое описание
миграции продукта в help не является действующим маршрутом переноса.

## Доски и задачи

[Правила задач](https://github.com/oim-dev/relay/blob/main/docs/domain/TASKS.md)
определяют цели, колонки, родительство и блокеры. Здесь перечислен терминальный ввод.

### boards

`relay-cli boards` — чтение каталога досок, slug, префиксов и принадлежности.
Параметры: страница задач. Выберите slug/префикс/ID для `task create --board`.
Самостоятельных команд создания/удаления произвольной доски нет.

### task list

`relay-cli task list` — чтение кратких карточек и блокеров. Параметры: страница задач;
`--board <board>` — slug/префикс/ID; `--column <column>` — колонка;
`--completion <state>` — unfinished (без done/cancelled) или finished (только они);
`--q <text>` — поиск; `--search-in <scope>` — title (ключ/ID/заголовок) или all
(также Markdown, по умолчанию); `--product-target <id>` — явная цель по ID;
`--readiness <state>` — ready или blocked. Ответ: страница и `nextOffset`.

### task get

`relay-cli task get <reference>` — полная карточка по ID, текущему или прежнему ключу:
содержание, ревизия и блокеры. Собственных параметров нет. Перечитайте перед записью.

### task links

`relay-cli task links <reference>` — чтение зависимостей, связанных/блокируемых задач,
родителя и подзадач. Параметры: страница задач. Состояние соседей вычисляется при чтении.

### task create

`relay-cli --actor agent task create --board <board>` — запись задачи на доске по
slug/префиксу/ID. Параметры:

- `--title <title>` — однострочный заголовок (по умолчанию пустой);
- `--description <markdown>` — полное описание;
- `--column <column>` — начальная колонка, по умолчанию inbox;
- `--feature <ids...>`, `--scenario <ids...>`, `--implementation <ids...>` — постоянные ID продуктовых целей;
- `--clear-product-links` — пустой набор целей, несовместим с переданными целями;
- `--criteria <json>` — до 100 критериев `{title,summary,description}` для атомарного создания;
- `--parent-id <id>` — постоянный ID родителя;
- `--request-id <id>` — корреляция.

Ответ — квитанция задачи с адресом и ревизией. Для создания с зависимостями по ключам
используйте также `entities create task`; это не повод публиковать диагностические рёбра.

### task update

`relay-cli --actor agent task update <reference> --if-revision <n>` — запись только
переданных полей: `--title <title>`, `--description <markdown>`,
`--feature <ids...>`, `--scenario <ids...>`, `--implementation <ids...>`,
`--clear-product-links`, `--request-id <id>`. Передача любой группы целей заменяет
весь набор целей; очистку нельзя совмещать с целями. Ответ — квитанция задачи.

### task move

`relay-cli --actor agent task move <reference> --column <column> --if-revision <n>`
— перемещение в inbox/ready/in-progress/review/done/cancelled.
`--board <board>` меняет доску; `--before-id <id>` ставит перед задачей по постоянному
ID (без него конец колонки); `--if-version <version>` проверяет прочитанную версию
порядка; `--request-id <id>` — корреляция. Ответ — квитанция с актуальным ключом и
сохранённым ID. Блокеры завершения нельзя обойти перемещением в done.

### task link

`relay-cli --actor agent task link <reference> --target <reference> --relation <relation> --if-revision <n>`
— запись связи задач по ID/ключам. Relation: depends-on/related/parent; target при
parent — родитель исходной задачи. `--remove` снимает связь, `--request-id <id>` —
корреляция. Ответ — квитанция задачи. Чтение результата: `task links`.

## Критерии и обсуждения

### task criterion list

`relay-cli task criterion list <reference>` — чтение компактных критериев задачи.
Параметры: страница задач, по умолчанию 20, максимум 100. Полный Markdown — через get.

### task criterion get

`relay-cli task criterion get <reference> <criterionId>` — чтение критерия по
постоянному ID из списка: полный Markdown, completed, автор/время, ревизия задачи.
Собственных параметров нет.

### task criterion add

`relay-cli --actor agent task criterion add <reference> --title <title> --if-revision <n>`
— добавление критерия. `--summary <text>`, `--description <markdown>` — содержание,
`--request-id <id>` — корреляция. Ревизия относится к задаче, не критерию.
Ответ — квитанция задачи. Готовую задачу сначала верните из done.

### task criterion update

`relay-cli --actor agent task criterion update <reference> <criterionId> --if-revision <n>`
— изменение критерия. Поля: `--title <title>`, `--summary <text>`,
`--description <markdown>`, `--request-id <id>`. Изменение текста сбрасывает выполнение.
Ответ — квитанция задачи; для done сначала измените колонку задачи.

### task criterion complete

`relay-cli --actor agent task criterion complete <reference> <criterionId> --if-revision <n> [--request-id <id>]`
— запись completed=true. Ответ — квитанция задачи; не заменяет внешнюю проверку.

### task criterion reopen

`relay-cli --actor agent task criterion reopen <reference> <criterionId> --if-revision <n> [--request-id <id>]`
— запись completed=false. Ответ — квитанция задачи. Для готовой задачи сначала выход из done.

### task criterion remove

`relay-cli --actor agent task criterion remove <reference> <criterionId> --if-revision <n> [--request-id <id>]`
— удаление критерия, не задачи. Ответ — квитанция задачи; также требует выхода из done.

### task comment list

`relay-cli task comment list <reference>` — чтение обсуждения задачи.
Параметры: `--limit <n>` (1–100, по умолчанию 20), `--cursor <cursor>`,
`--after <n>` — после последовательного номера (от 0), `--by <name>` — точный автор,
`--action <action>` — совместимый фильтр, только comment-publish.
Возвращает компактные записи и курсор; пустая страница с курсором не означает конец.

### task comment get

`relay-cli task comment get <reference> <entryId>` — полное чтение сообщения.
`entryId` — номер записи из списка, не criterionId. Собственных параметров нет.

### task comment publish

`relay-cli --actor agent task comment publish <reference> --title <text> --description <markdown> --role <role> [--request-id <id>]`
— публикация сообщения от выбранного автора. Все три поля обязательны, роль:
operator/orchestrator/worker. Ревизия задачи не нужна. Ответ — квитанция публикации.
После потери ответа сначала читайте обсуждение: повтор может создать новое сообщение.
Команд изменения/удаления комментария и автоматической истории задач нет.

## Планы

Предметные правила — [планирование](https://github.com/oim-dev/relay/blob/main/docs/domain/PLANNING.md).
План может состоять из одной задачи; нет требования искусственно увеличивать его.
`reference` — ключ/ID плана, `stage` — внутренний ID этапа из `plan stages`, не его название.
Запись возвращает квитанцию планирования; `--if-revision` проверяет план, в том числе
при изменении этапа/состава. Все записи принимают `--request-id <id>` для корреляции.

### plan list

`relay-cli plan list [--q <text>] [--status <status>]` — чтение каталога с прогрессом.
Status: draft/active/completed/cancelled. Параметры: страница снимка.
`total` относится ко всей выборке, не только странице; `statusCounts` — счётчики
состояний проекта без поисковых фильтров.

### plan get

`relay-cli plan get <reference>` — полное чтение текстов, состояния и ревизии плана.
Собственных параметров нет. Состав этапов/задач имеет отдельные страницы.

### plan candidates

`relay-cli plan candidates` — чтение кандидатов для включения в этап.
Параметры: страница снимка; `--q <text>` — ключ/название;
`--board <reference>` — slug/ключ/ID доски; `--plan <reference>` — выбранный план;
`--stage <id>` — этап (требует --plan); `--available-only <value>` — true только
доступные, false также занятые/отменённые. Возвращает задачи и текущее участие.

#### Поля содержания плана

Create/update принимают `--title <title>`, `--summary <text>`, `--goal <markdown>`,
`--rationale <markdown>` (обоснование), `--boundaries <markdown>` (границы),
`--expected-result <markdown>`, `--scope <references...>` (ключи либо kind:ID),
`--clear-scope` (явно пустая область), `--participants <actors...>` (участники).
Область и участники — целые наборы до 100 элементов каждый, не добавление одного элемента.
Для scope допустимы project/product/application/feature/scenario/implementation.

### plan create

`relay-cli --actor agent plan create --title <title> [поля содержания] [--request-id <id>]`
— создание черновика. Название обязательно, остальные поля описаны выше.
Не создаёт задачи автоматически. Ответ — квитанция плана.

### plan update

`relay-cli --actor agent plan update <reference> --if-revision <n> [поля содержания] [--request-id <id>]`
— изменение только переданных полей. Положительная ревизия обязательна; поля выше.
Ответ — квитанция. Закрытый план не редактируется.

### plan start

`relay-cli --actor agent plan start <reference> --if-revision <n> [--result <markdown>] [--request-id <id>]`
— явное начало плана. `--result` зарегистрирован, но предназначен для итогов
complete/cancel; начало не требует итога. Ответ — квитанция перехода.

### plan complete

`relay-cli --actor agent plan complete <reference> --if-revision <n> --result <markdown> [--request-id <id>]`
— явное завершение с содержательным итогом. Хотя `--result` не requiredOption в парсере,
предметный переход требует итог и проверяет условия завершения. Ответ — квитанция.

### plan cancel

`relay-cli --actor agent plan cancel <reference> --if-revision <n> --result <markdown> [--request-id <id>]`
— отмена с причиной, а не удаление. Ответ — квитанция; закрытый план нельзя возобновить CLI-командой.

### plan stages

`relay-cli plan stages <reference>` — чтение этапов и их прогресса. Параметры: страница
снимка. Порядок этапов не устанавливает запрет параллельного исполнения.

### plan tasks

`relay-cli plan tasks <reference> <stage>` — чтение текущих задач выбранного этапа.
Параметры: страница снимка. Подзадачи и зависимости не добавляются в состав автоматически.

### plan memberships

`relay-cli plan memberships <reference>` — здесь reference означает **задачу**, не план.
Читает текущие и закрытые включения задачи в планы/этапы; параметры: страница снимка.
Это текущие предметные записи участия, не журнал изменений и не исторический снимок задачи.

### plan stage create

`relay-cli --actor agent plan stage create <reference> --title <title> --if-revision <n>`
— создание этапа. Дополнительно `--summary <text>`, `--outcome <markdown>` — результат,
`--completion-conditions <markdown>` — текстовые условия завершения,
`--request-id <id>`. Ответ — квитанция; ID этапа можно получить через `plan stages`.

### plan stage update

`relay-cli --actor agent plan stage update <reference> <stage> --if-revision <n>`
— частичная правка этапа. Нужно хотя бы одно поле: `--title <title>`, `--summary <text>`,
`--outcome <markdown>`, `--completion-conditions <markdown>`. Пустая строка очищает
summary/outcome/conditions; пропущенное поле сохраняется. `--request-id <id>` — корреляция.

### plan stage remove

`relay-cli --actor agent plan stage remove <reference> <stage> --if-revision <n> [--request-id <id>]`
— удаление **пустого** этапа; сначала явно исключите задачи. Ответ — квитанция плана.

### plan stage move

`relay-cli --actor agent plan stage move <reference> <stage> --if-revision <n> [--before <id>] [--request-id <id>]`
— изменение порядка этапов: before — ID следующего этапа, без него конец.
Не переупорядочивает задачи внутри этапа. Ответ — квитанция плана.

### plan include

`relay-cli --actor agent plan include <reference> <stage> --tasks <references...> --if-revision <n> [--request-id <id>]`
— включение до 2000 существующих задач по ключам/ID. Ответ — квитанция плана;
не копирует содержание задач и не включает их соседей автоматически.

### plan exclude

`relay-cli --actor agent plan exclude <reference> <stage> --tasks <references...> --if-revision <n> [--request-id <id>]`
— исключение выбранных задач (до 2000), не их удаление. Ответ — квитанция плана.

### plan transfer

`relay-cli --actor agent plan transfer <reference> <task> <targetStage> --target-plan <reference> --if-revision <n> --target-revision <n> --reason <markdown> [--request-id <id>]`
— перенос задачи между этапами или планами. Первый reference — исходный план,
task — ключ/ID задачи, targetStage — ID целевого этапа. Обязательны целевой план,
прочитанные ревизии обеих сторон и причина. Ответ — результат согласованного переноса.

## Релизы

`release` управляет записями выпусков пользовательского проекта, не запускает CI/CD
и не публикует пакет CLI. Целевая модель — релиз приложения; текущее действие
сохраняет проектный релиз с `planIds`, **без applicationId и флага выбора приложения**.
Условия выпуска и этот пробел описаны в [контракте релизов](https://github.com/oim-dev/relay/blob/main/docs/domain/RELEASES.md).
Все записи требуют автора, принимают `--request-id <id>` и возвращают квитанцию.

### release list

`relay-cli release list [--q <text>] [--status <status>]` — чтение каталога и готовности.
Status: planned/cancelled/released. Параметры: страница снимка.

### release get

`relay-cli release get <reference>` — полное чтение релиза по ключу/ID: содержание,
состояние, ревизия. Собственных параметров нет; планы читаются отдельно.

### release preview

`relay-cli release preview [--plans <references...>]` — **чтение**, проверка выбранных
планов без записи релиза. До 200 ключей/ID; отсутствие plans означает пустой выбор,
не готовый выпуск. Параметры: страница снимка. Ответ — состав и общая готовность.

### release create

`relay-cli --actor agent release create --title <title> --release-version <label> --plans <references...>`
— создание релиза. Обязательны название, обозначение версии и планы по ключам/ID.
Дополнительно: `--summary <text>`, `--description <markdown>`, `--planned-for <date>`
(YYYY-MM-DD), `--status <status>` (planned/cancelled/released), `--request-id <id>`.
Released сразу фиксирует выпуск с предметными проверками, не только меняет метку.

### release update

`relay-cli --actor agent release update <reference> --if-revision <n>` — изменение
невыпущенного релиза. Необязательные поля: `--title <title>`, `--release-version <label>`,
`--plans <references...>` — **полный новый состав**, `--summary <text>`,
`--description <markdown>`, `--planned-for <date>` (пустая строка очищает),
`--status <status>` (planned/cancelled/released), `--request-id <id>`.
Пропущенные поля сохраняются. Выпущенный релиз неизменяем.

### release plan

`relay-cli --actor agent release plan <reference> --if-revision <n> [--request-id <id>]`
— перепланирование отменённого релиза, не создание плана работ. Ответ — квитанция.

### release cancel

`relay-cli --actor agent release cancel <reference> --if-revision <n> [--request-id <id>]`
— отмена планового релиза, не удаление. Ответ — квитанция.

### release publish

`relay-cli --actor agent release publish <reference> --if-revision <n> [--request-id <id>]`
— фиксация выпуска выбранных планов после проверок Core. Ответ — квитанция;
не доказывает фактическую поставку внешней системой и не запускает её.

### release plans

`relay-cli release plans <reference>` — чтение актуальных планов состава и готовности.
Параметры: страница снимка. Даже после выпуска это текущие задачи/планы,
не исторический снимок на дату выпуска.

## Прогресс

Все команды семейства — чтение. Общие параметры каждой: `--offset <n>` (от 0),
`--limit <n>` (1–100, по умолчанию 20), `--snapshot-version <version>` (обязателен при
offset > 0). Итоги относятся ко всему составу, страница — к каждому вложенному списку.
Ответ содержит вычисленные показатели и причины неготовности; done сам по себе
не доказательство выполнения. Расчёт определяет [контракт прогресса](https://github.com/oim-dev/relay/blob/main/docs/domain/PROGRESS.md).

### progress task

`relay-cli progress task <ref>` — прогресс задачи, критерии и обязательства.
Ref — ключ, ID или kind:ID; общие параметры прогресса выше.

### progress implementation

`relay-cli progress implementation <ref>` — прогресс реализации по её задачам и причинам.
Ref — ключ, ID или kind:ID; общие параметры прогресса выше.

### progress scenario

`relay-cli progress scenario <ref>` — прогресс сценария и реализаций.
Ref — ключ, ID или kind:ID; общие параметры прогресса выше.

### progress feature

`relay-cli progress feature <ref>` — прогресс фичи и сценариев.
Ref — ключ, ID или kind:ID; общие параметры прогресса выше.

### progress application

`relay-cli progress application <ref>` — прогресс приложения и причины неготовности.
Ref — ключ, ID или kind:ID; общие параметры прогресса выше.

### progress product

`relay-cli progress product` — прогресс продукта выбранного проекта, без позиционного
аргумента. Общие параметры прогресса выше.

### progress work-plan

`relay-cli progress work-plan <ref>` — прогресс плана по его составу.
Ref — ключ, ID или kind:ID; общие параметры прогресса выше.

### progress release

`relay-cli progress release <ref>` — текущая готовность релиза.
Ref — ключ, ID или kind:ID; общие параметры прогресса выше.

## Граф

Чтение контекста не создаёт отношения. Для предметных изменений используйте владельца
связи (задачу, документ, план, продукт); прямая запись графа — диагностика и ремонт.
Подробности — [контракт адресов и контекста](https://github.com/oim-dev/relay/blob/main/docs/domain/CONTEXT.md).

### graph list

`relay-cli graph list` — чтение ограниченного графа или подграфа.
Параметры: страница снимка; `--root <address>` — ключ/ID корня (без него весь проект);
`--type <type>` — тип отношений; `--direction <direction>` — both/outgoing/incoming;
`--profile <profile>` — all либо совместимое имя context (тот же обход);
`--depth <n>` — 0–100; `--q <text>` — ключ/адрес/название.
Ответ содержит узлы и сохранённые рёбра, `version`, `nextOffset`, `depthLimited`.
Конец страницы не означает отсутствие границы глубины.

### graph context

`relay-cli graph context <root>` — полная достижимая компонента ключа/ID/kind:ID
в обоих направлениях, включая циклы и параллельные связи. Собственных флагов нет:
глубина, фильтры и страницы не применяются. Успех содержит `complete:true`;
при превышении бюджета — ошибка, не частичный граф. При необходимости увеличьте
глобальный `--max-bytes`; полное содержание записей читайте адресно.

### graph link

`relay-cli --actor agent graph link --from <address> --to <address> --type <type> --if-version <version>`
— диагностическая запись направленного отношения. Адреса — ключи/ID;
`--description <markdown>` — пояснение (по умолчанию пустое), `--request-id <id>` — корреляция.
Версию возьмите из graph list/context. Ответ — результат изменения графа.
Не устанавливает предметную зависимость задачи или цель продукта.

### graph update

`relay-cli --actor agent graph update <id> --if-version <version> [--description <markdown>] [--request-id <id>]`
— запись пояснения отношения по ID ребра. Без description записывается пустая строка.
Ответ — результат изменения графа; после потери ответа сначала перечитайте граф.

### graph unlink

`relay-cli --actor agent graph unlink <id> --if-version <version> [--request-id <id>]`
— отзыв диагностического отношения по ID ребра. Ответ — результат изменения графа;
не заменяет снятие предметного линка у его владельца.

### graph apply

`relay-cli --actor agent graph apply --json <json> --if-version <version> [--request-id <id>]`
— атомарная запись до 100 диагностических операций. JSON — массив:

```json
[
  {
    "action": "add",
    "from": "PRODUCT-1",
    "to": "DOC-1",
    "type": "references",
    "description": "Основание"
  },
  { "action": "update", "id": "ID_РЕБРА", "description": "Уточнение" },
  { "action": "remove", "id": "ДРУГОЙ_ID_РЕБРА" }
]
```

ID в примере замените прочитанными значениями. Ответ — результат всего пакета;
ошибка не превращается в частично успешную операцию. RequestId не гарантирует повтор.

### graph migrate

`relay-cli --local graph migrate` — совместимая локальная операция без изменений
в формате 4 (`migrated:false`), не перенос графа в v2. Для старой базы нужна
`storage migrate`. Собственных параметров и автора нет; устаревший help не задаёт
альтернативного процесса миграции.

### graph reindex

`relay-cli --local graph reindex` — локальное восстановление производных индексов
из постоянных записей. Собственных параметров и автора нет. Ответ содержит число
связей и ревизию. Не синхронизирует предметные поля с рёбрами; для этого есть
`storage reconcile-relations`. Для обслуживания единой базы используйте `storage reindex`.

## Обслуживание

Операции требуют прямого Core выбранного проекта. Для нестандартной базы укажите
`--local --config /work/project/.relay/config.json`, не workspace-конфиг.
Остановите старые клиенты и сохраните резервную копию перед переносом.
Общие ограничения — [хранение](https://github.com/oim-dev/relay/blob/main/docs/domain/STORAGE.md),
устройство — [формат Core](https://github.com/oim-dev/relay/blob/main/packages/core/docs/FORMAT.md).

### storage migrate

`relay-cli --local storage migrate` — явная запись переноса поддерживаемой базы
в единый физический формат **4**. Сохраняет текущие данные, ID, ключи, ревизии,
комментарии и алиасы, но не аудит/историю/результаты запросов. Собственных флагов
и автора нет. Ответ сообщает `migrated`, показатели переноса и `format`;
для уже актуальной базы переноса нет. Неподдерживаемые предметные версии планов
и релизов не получают автоматического преобразования или сброса.

### storage reindex

`relay-cli --local storage reindex` — запись производных индексов адресов, карточек
и связей из постоянных данных, например после Git-слияния или потери индекса.
Собственных флагов и автора нет. Ответ — количество связей и ревизия графа.
Не создаёт недостающие предметные отношения из полей.

### storage reconcile-relations

`relay-cli --local --actor agent storage reconcile-relations [--request-id <id>]`
— явное согласование сохранённых управляемых отношений с предметными линками.
Добавляет недостающие и отзывает лишние в одной транзакции, сохраняет неизменённые
ID связей, независимые диагностические рёбра и ревизии сущностей. Ответ:
`added`, `updated`, `removed`, `requestId`. После неопределённого результата
проверьте состояние, не рассчитывайте на сохранённую квитанцию.
