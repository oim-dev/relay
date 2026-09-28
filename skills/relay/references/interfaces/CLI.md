# Справочник Relay CLI

CLI — основной интерфейс агента к памяти проекта. Обычный результат читают агент
и человек; JSON выбирается явно для машинного разбора. Этот справочник описывает
зарегистрированные команды, ввод, ответы и ограничения, а не состав опубликованной
версии. Синтаксис установленного пакета уточняйте через `npx @oim-dev/relay-cli --help`.

Предметные правила принадлежат [domain](../domain/README.md),
покрытие — [матрице возможностей](../CAPABILITIES.md).
См. также [стиль вызовов](COMMAND_STYLE.md), [терминальное представление](TERMINAL.md)
и [разработку CLI](https://github.com/oim-dev/relay/blob/main/apps/cli/docs/EXTENDING.md).

## Содержание

- [Вызов и подключение](#вызов-и-подключение)
- [Ввод, запись и восстановление](#ввод-запись-и-восстановление)
- [Ответы, ошибки и страницы](#ответы-ошибки-и-страницы)
- [Проект и workspace](#проект-и-workspace)
- [Продукт и каталоги](#продукт-и-каталоги)
- [Документы и разделы](#документы-и-разделы)
- [Доски и задачи](#доски-и-задачи)
- [Критерии и обсуждения](#критерии-и-обсуждения)
- [Планы и этапы](#планы-и-этапы)
- [Релизы](#релизы)
- [Поиск и инспекция](#поиск-и-инспекция)
- [Диагностика и обслуживание](#диагностика-и-обслуживание)

## Вызов и подключение

```bash
npx skills add oim-dev/relay
npx @oim-dev/relay-cli init
npx @oim-dev/relay-cli project get
npx @oim-dev/relay-cli board list
```

Установка скилла подготавливает агентский сценарий, но не является runtime-зависимостью
CLI. Полный маршрут — [первый запуск](../guides/GETTING_STARTED.md).

Синтаксис: `npx @oim-dev/relay-cli [глобальные параметры] [проект] <команда> [аргументы]`.
`<...>` — обязательное значение, `[...]` — необязательное, `<refs...>` — несколько
отдельных аргументов. Примеры рассчитаны на shell с POSIX-кавычками; значения ключей,
ID, ревизий и версий заменяйте фактически прочитанными. Группа без подкоманды
показывает help. Help и версия не открывают проект и не требуют данных.

| Глобальный параметр  | Значение                                                        |
| -------------------- | --------------------------------------------------------------- |
| `-h, --help`         | Справка выбранной команды                                       |
| `-V, --version`      | Версия CLI, не версия данных                                    |
| `--config <path>`    | Путь к `.relay/config.json` или `relay.workspace.json`          |
| `--project <name>`   | Проект; альтернатива позиционному префиксу, не вместе с ним     |
| `--server-url <url>` | Явное HTTP-подключение                                          |
| `--local`            | Прямой Core; не fallback после HTTP-ошибки и не режим workspace |
| `--actor <id>`       | Автор предметной записи; приоритет над `RELAY_ACTOR`            |
| `--format <format>`  | `text` по умолчанию; JSON только через `--format json`          |

`output.format` и `output.maxBytes` из конфигурации не управляют CLI. Параметры
`--color` и `--max-bytes` удалены. Текст бесцветный, без ANSI-оформления,
независимо от TTY, NO_COLOR и FORCE_COLOR; ширина и структура Markdown сохраняются.
Подробнее — [TERMINAL](TERMINAL.md).

Конфиг: `--config` → `RELAY_CONFIG` → поиск вверх от cwd. В одном каталоге workspace
имеет приоритет над `.relay/config.json`. URL: `--server-url` → `RELAY_SERVER_URL` →
настройки сервера. Без URL обычный локальный проект использует Core. Явный URL
допускает работу без локального конфига. Workspace требует сервер и явный проект
для предметных команд; команды реестра, наоборот, не принимают выбор одного проекта.

```bash
npx @oim-dev/relay-cli frontend task list
npx @oim-dev/relay-cli task get PRODUCT-1 \
  --server-url http://127.0.0.1:4700 \
  --project frontend
npx @oim-dev/relay-cli config get \
  --local \
  --config /work/project/.relay/config.json
```

HTTP-ошибка не разрешает переключаться на локальные данные. Подробности подключения —
[project-runtime](CONFIGURATION.md).

## Ввод, запись и восстановление

Перед изменением прочитайте `get` и ревизию. Update изменяет только переданные поля;
пропуск, пустая строка, false и явная очистка различаются. Набор целей или состава
при передаче заменяется целиком, если команда не названа add/remove. Название —
одна строка, summary — обычный многострочный текст, description/body/goal/result — Markdown.

**Текстовая пара T(field)** в описаниях ниже означает два конкретных флага:
`--field <text>` и `--field-file <path>`. Путь `-` читает stdin. Например,
T(description) — `--description`/`--description-file`, T(expected-result) —
`--expected-result`/`--expected-result-file`. Это не универсальный флаг `--field`.
Пары существуют только у явно перечисленных полей. Нельзя передать оба источника
одного поля или читать stdin для двух полей. Файл читается как UTF-8; ввод проверяется
до мутации. Лимит чтения общего текстового ввода — 128 МиБ; предметные и транспортные
лимиты могут быть меньше. Пустые строки и значимые отступы не нормализуются.

| Обозначение              | Зарегистрированная пара флагов                                          |
| ------------------------ | ----------------------------------------------------------------------- |
| T(name)                  | `--name <text>`, `--name-file <path>` — только project update           |
| T(summary)               | `--summary <text>`, `--summary-file <path>`                             |
| T(description)           | `--description <text>`, `--description-file <path>`                     |
| T(body)                  | `--body <text>`, `--body-file <path>`                                   |
| T(goal)                  | `--goal <text>`, `--goal-file <path>`                                   |
| T(rationale)             | `--rationale <text>`, `--rationale-file <path>`                         |
| T(boundaries)            | `--boundaries <text>`, `--boundaries-file <path>`                       |
| T(expected-result)       | `--expected-result <text>`, `--expected-result-file <path>`             |
| T(result)                | `--result <text>`, `--result-file <path>`                               |
| T(outcome)               | `--outcome <text>`, `--outcome-file <path>`                             |
| T(completion-conditions) | `--completion-conditions <text>`, `--completion-conditions-file <path>` |
| T(reason)                | `--reason <text>`, `--reason-file <path>`                               |

```bash
npx @oim-dev/relay-cli document create \
  --actor agent \
  --name 'Правила проверки' \
  --document-kind rules \
  --body '## Проверка

1. Открыть карточку.
2. Сравнить сохранённое содержание.'
npx @oim-dev/relay-cli document get DOC-1
npx @oim-dev/relay-cli document update DOC-1 \
  --actor agent \
  --if-revision 1 \
  --body-file ./rules.md
npx @oim-dev/relay-cli task update PRODUCT-1 \
  --actor agent \
  --if-revision 2 \
  --description-file - < ./task.md
```

Числа ревизий здесь иллюстративны. После записи перечитайте полное содержание
и отношения в том же проекте. Не считайте квитанцию проверкой внешнего результата.

**Запись R** ниже означает обязательный `--if-revision <n>` и необязательный
`--request-id <id>`, а также автора через глобальный `--actor`/`RELAY_ACTOR`.
Ревизия относится к изменяемому владельцу: у критериев — задача, у этапов — план,
у разделов — проект, у participation — состав приложения. **Создание C** требует
автора и допускает `--request-id`, но не требует ревизию. У диагностического графа
вместо ревизии требуется `--if-version <version>`.
Ревизия — целое число: task/criterion/plan/release требуют минимум 1;
project и каталог продуктовых сущностей допускают 0 (например, незаполненный паспорт
или ещё не созданный состав приложения). Это не разрешение угадывать ревизию.

`requestId` — только корреляция, по умолчанию UUID; не ключ дедупликации и не
сохранённая квитанция. Скрытых повторов нет. При потере ответа сначала перечитайте
запись/обсуждение/связи. При конфликте согласуйте изменения, не подставляйте свежую
ревизию к старому телу. Правила — [сохранение](../domain/STORAGE.md).

## Ответы, ошибки и страницы

Команда возвращает карточку, страницу, квитанцию, прогресс или ошибку. Штатные
результаты и ошибки идут в stdout; stderr штатного вызова чист. Успех — exit 0,
ошибка — ненулевой код, синтаксическая ошибка обычно 2. Help и версия всегда текстовые.
Закрытый получателем pipe (`EPIPE`) — штатный exit 0. В text пользовательские
управляющие последовательности обезвреживаются; это не побайтовая копия поля.
JSON не содержит терминального оформления и сохраняет предметные поля.

Пример формы пустой страницы, не полный DTO конкретного backend:

```json
{
  "ok": true,
  "data": { "items": [] },
  "meta": {
    "page": {
      "count": 0,
      "total": 0,
      "limit": 20,
      "nextCursor": null,
      "nextCommand": null,
      "consistency": "snapshot"
    }
  }
}
```

Ошибка имеет форму:

```json
{
  "ok": false,
  "error": { "code": "ACTOR_REQUIRED", "message": "Для записи укажите --actor или RELAY_ACTOR" }
}
```

У квитанции сущности `data` содержит адрес/ключ, ревизию, действие и requestId;
квитанции других семейств сохраняют DTO своей операции. Их нельзя получить позже
командой истории. Явно выбранный проект передаётся в `meta.project`.

### Правила продолжения

**Страница P** ниже означает `--limit <count>` (1–100) и `--cursor <cursor>`.
Размер берётся из `output.defaultLimit`, в том числе для ленты комментариев;
реестр workspace по умолчанию использует 20. Публичных offset/параметров версии страницы нет.
Глобальный `--version` показывает версию пакета, а не продолжает список.

`Result.page` выводится единым footer в text и как `meta.page` в JSON:
`count`, `total?`, `limit`, `nextCursor`, `nextCommand`, `consistency`.
Отсутствующий total не равен нулю. `null` в nextCursor/nextCommand означает конец.
Пустая страница с курсором имеет продолжение. Копируйте nextCommand целиком:
она сохраняет конфиг, проект, сервер/local, команду, ref и фильтры; жёстких переносов нет.
Курсор непрозрачен и не переносится на другой запрос или подключение.
Публичный CLI-курсор берите только из `meta.page.nextCursor`. Он хранит параметры
продолжения, включая фильтры и limit, и привязан к контексту и ref. Поэтому
`meta.page.nextCommand` может не повторять `--limit` и фильтры: wrapper восстанавливает
их при продолжении. Сохранять выборку не означает повторять все флаги вручную.

`snapshot` для offset-backend — **проверка неизменности текущего состояния**, не
доступ к сохранённому историческому снимку. Исходная версия не заменяется свежей;
конфликт требует начать чтение заново без курсора. `live` означает, что данные
могут меняться между страницами; наличие cursor не создаёт гарантии snapshot.
Реестр workspace проверяет отпечаток заново прочитанного каталога на клиенте,
а не хранит серверный снимок. У ленты комментариев `meta.page.nextCursor` — wrapper,
который хранит исходный native token backend вместе с фильтрами, limit и контекстом/ref.
`data.nextCursor` сохранён как сырой backend token для совместимости DTO и **не
принимается CLI напрямую**. Не передавайте его в `--cursor`.

В progress один limit применяется к каждому вложенному списку, count/total — сумма
элементов списков, а не число уникальных сущностей. У inspect graph list limit
отдельно ограничивает узлы и рёбра; `meta.paginationUnit` — `nodes-and-edges`,
`meta.limitPerCollection` уточняет размер. Итоги готовности относятся ко всему составу.

CLI не обрезает ответ по байтовому бюджету. Это не отменяет лимиты Core/HTTP/MCP
или ввода. Полный текст `get` не усекается; большие коллекции читаются отдельными
списками. Полный графовый context возвращает компоненту с `complete:true` либо ошибку.

| Ситуация                                                | Действие                                                                     |
| ------------------------------------------------------- | ---------------------------------------------------------------------------- |
| CONFIG_NOT_FOUND / PROJECT_REQUIRED / REGISTRY_REQUIRED | Проверить конфиг, режим и проект, не создавать новую базу вместо неизвестной |
| ACTOR_REQUIRED                                          | Указать автора записи                                                        |
| INVALID_ARGUMENT / CONFLICTING_OPTIONS / INVALID_JSON   | Исправить параметры и источники ввода по help команды                        |
| INVALID_CURSOR / VERSION_CONFLICT / SNAPSHOT_CONFLICT   | Проверить контекст; начать список заново, не смешивая страницы               |
| Конфликт ревизии                                        | Перечитать запись и согласовать изменение                                    |
| NOT_FOUND                                               | Проверить проект и адрес через inspect resolve                               |
| LOCAL_REQUIRED / WORKSPACE_REQUIRES_SERVER              | Выбрать допустимое подключение, не обходить HTTP локальными файлами          |
| Ошибка размера нижнего слоя                             | Уменьшить выборку либо читать адресно; CLI-флага увеличения бюджета нет      |

## Проект и workspace

### init

`npx @oim-dev/relay-cli init [--storage <path>]` — создать локальные конфиг и хранилище.
`--storage` по умолчанию `tasks` — совместимая привязка конфигурации, не отдельная
база задач. `--config` задаёт место конфигурации. Существующие данные не заменяются.
При явно настроенном HTTP требуется `--local`. Автор не нужен. Ответ: configPath,
storageDir; проверьте затем config get и board list.

### project get

`npx @oim-dev/relay-cli project get` — карточка единственного PROJECT с именем,
настройками и ревизией. Собственных флагов нет. Это не список регистраций workspace.

### project update

```bash
npx @oim-dev/relay-cli project update \
  --actor human \
  --name 'Мой проект' \
  --if-revision 1
```

Запись R. Обязательна T(name): `--name` либо `--name-file`. Меняется только имя;
description, slug и регистрация workspace не поддерживаются этим действием.
Ответ — квитанция сущности; проверьте project get.

### config get

`npx @oim-dev/relay-cli config get` — чтение конфигурации без собственных флагов.
JSON data — конфиг; meta.configPath и meta.storagePath — фактические пути.
Совместимые статусы не меняют фиксированные колонки досок. Это не редактор настроек.

### workspace project init

`npx @oim-dev/relay-cli workspace project init` — создать локальный пустой
relay.workspace.json; `--config`/RELAY_CONFIG выбирает путь. Не требует автора,
не принимает `--project` и проектный префикс. Ответ — результат создания реестра.

### workspace project list

`npx @oim-dev/relay-cli workspace project list` — страница P зарегистрированных
проектов. Требуются workspace-конфиг и сервер, без `--local` и выбранного проекта.
CLI читает каталог целиком, затем выдаёт страницу; изменение отпечатка каталога
вызывает конфликт. `meta.paginationSource` — `client-catalog-fingerprint`.
Это не серверный исторический снимок и не универсальная проверка local-проекта.

### workspace project add

`npx @oim-dev/relay-cli workspace project add alpha ./alpha` — зарегистрировать
инициализированный проект через сервер. `<name>` — имя регистрации, `[path]` — путь
относительно workspace-конфига. `--project-config <path>` — конфиг внутри каталога
проекта; `--replace` явно разрешает замену регистрации. Автор и ревизия не нужны.
Не создаёт и не переносит данные. Ответ — квитанция регистрации; проверьте list.

### workspace project remove

`npx @oim-dev/relay-cli workspace project remove alpha` — удалить только регистрацию
через сервер. Данные остаются. Собственных флагов, автора и ревизии нет. Как add/list,
требует workspace и не принимает выбор отдельного проекта или `--local`.

## Продукт и каталоги

**Каталог L** для feature/scenario/application/implementation/document означает P
и `--q <text>`, `--sort <field>` (`key`, `title`, `updated`). Фильтры применяются
до пагинации. Ответ — краткие items с показателями страницы, не полные тексты.

**Содержание N** для product/feature/application: `--name <text>`, T(summary),
T(description). Create требует name и непустое description; summary по умолчанию
пустое. Update — только переданные поля, минимум одно; `--clear-summary` очищает
summary и несовместим с его текстовым источником. Создание C, изменение R.
Имена не имеют неявного `--name-file`, кроме отдельно описанного project update.

**Прогресс G**: страница P полного ответа предметного прогресса, со сводкой,
причинами и страницами составляющих. Это чтение, не установка готовности.
**Переименование K**: запись R нового читаемого ключа, не названия; ID и прежние
алиасы сохраняются. Возвращает квитанцию сущности; коллизия отклоняется.

### product get

`npx @oim-dev/relay-cli product get` — полный singleton-паспорт и ревизия,
без позиционного ref и собственных флагов. Незаполненный паспорт имеет ревизию 0.

### product create

```bash
npx @oim-dev/relay-cli product create \
  --actor agent \
  --name 'Продукт' \
  --description 'Назначение и границы'
```

C и содержание N. Заполняет паспорт единственного продукта, не создаёт второй продукт.
Ответ — квитанция; перечитайте product get.

### product update

```bash
npx @oim-dev/relay-cli product update \
  --actor agent \
  --summary 'Уточнённое назначение' \
  --if-revision 1
```

R и содержание N, без ref. Непереданные поля сохраняются. Ответ — квитанция.

### product rename

```bash
npx @oim-dev/relay-cli product rename PRODUCT \
  --actor agent \
  --if-revision 1
```

K; единственный позиционный аргумент — новый ключ. Паспорт остаётся singleton.

### product progress

`npx @oim-dev/relay-cli product progress` — G без ref: фичи и текущая готовность продукта.

### product overview

`npx @oim-dev/relay-cli product overview` — P компактной карты продукта.
Счётчики готовности относятся ко всему продукту; продолжение проверяет версию
текущего состояния. Не заменяет полное содержание get.

### product validate

`npx @oim-dev/relay-cli product validate` — проверка структурных инвариантов,
без собственных флагов. Ответ: valid, records, version. Не внешняя приёмка требований.

### product lint

`npx @oim-dev/relay-cli product lint [--id <ref>]` — P предупреждений по содержанию.
Без id проверяет весь продукт. Отдельная реализация в `--id` не поддержана;
для реализаций запускайте без id. Результат warnings не меняет данные и не доказывает полноту ТЗ.

### feature list

`npx @oim-dev/relay-cli feature list` — L; дополнительно `--status <state>`.
Возвращает краткие карточки фич.

### feature get

`npx @oim-dev/relay-cli feature get FEATURE-1` — полные требования, метаданные
и ревизия. `<ref>` — ключ/ID; собственных флагов нет.

### feature create

```bash
npx @oim-dev/relay-cli feature create \
  --actor agent \
  --name 'Поиск' \
  --description 'Пользователь находит документы'
```

C и N; возвращает квитанцию новой фичи.

### feature update

```bash
npx @oim-dev/relay-cli feature update FEATURE-1 \
  --actor agent \
  --name 'Поиск документов' \
  --if-revision 1
```

R и N; сохраняет непереданные тексты, не устанавливает готовность вручную.

### feature rename

```bash
npx @oim-dev/relay-cli feature rename FEATURE-1 SEARCH-1 \
  --actor agent \
  --if-revision 1
```

K по `<ref> <key>`.

### feature progress

`npx @oim-dev/relay-cli feature progress FEATURE-1` — G: сценарии, реализации
и прямые продуктовые задачи фичи.

### scenario list

`npx @oim-dev/relay-cli scenario list` — L; дополнительно `--status <state>`,
`--feature <ref>`. Ответ — краткие сценарии выбранной фичи или проекта.

### scenario get

`npx @oim-dev/relay-cli scenario get SCENARIO-1` — полное содержание и ревизия,
без собственных флагов.

### scenario create

```bash
npx @oim-dev/relay-cli scenario create \
  --actor agent \
  --name 'Найти документ' \
  --feature FEATURE-1 \
  --description 'Шаги и ожидаемый результат'
```

C; обязательны `--name <text>`, `--feature <ref>`, непустая T(description).
Summary отсутствует. Ответ — квитанция сценария.

### scenario update

```bash
npx @oim-dev/relay-cli scenario update SCENARIO-1 \
  --actor agent \
  --name 'Поиск по названию' \
  --if-revision 1
```

R; `--name <text>`, T(description), минимум одно поле. Родительскую фичу не меняет.

### scenario rename

```bash
npx @oim-dev/relay-cli scenario rename SCENARIO-1 SEARCH-SC-1 \
  --actor agent \
  --if-revision 1
```

K по `<ref> <key>`.

### scenario progress

`npx @oim-dev/relay-cli scenario progress SCENARIO-1` — G: активные реализации
и прямые задачи сценария.

### application list

`npx @oim-dev/relay-cli application list` — L; дополнительных фильтров нет.
Приложения продукта не являются регистрациями workspace.

### application get

`npx @oim-dev/relay-cli application get WEB` — полное содержание и ревизия
приложения, без собственных флагов. Ревизию состава отдельно даёт participation list.

### application create

```bash
npx @oim-dev/relay-cli application create \
  --actor agent \
  --name 'Web' \
  --slug web \
  --description 'Интерфейс человека'
```

C и N; обязателен `--slug <slug>`, необязательны `--prefix <prefix>` и
`--type <type>` (frontend/backend/internal, по умолчанию frontend).
Создаёт приложение с его доской. Slug и prefix после создания неизменяемы.

### application update

```bash
npx @oim-dev/relay-cli application update WEB \
  --actor agent \
  --summary 'Пользовательский интерфейс' \
  --if-revision 1
```

R и N; также `--type <type>`. Slug/prefix и состав этим вызовом не меняются.

### application rename

```bash
npx @oim-dev/relay-cli application rename WEB FRONTEND \
  --actor agent \
  --if-revision 1
```

K по `<ref> <key>`; не меняет slug или префикс доски.

### application progress

`npx @oim-dev/relay-cli application progress WEB` — G. Продуктовая готовность
и показатели всех задач доски различаются.

### application participation list

`npx @oim-dev/relay-cli application participation list WEB` — P всех реализаций
состава, включая снятые. Ответ содержит revision **состава** и version продукта
для replace; это не ревизия application get. Прочитайте все страницы перед заменой.

### application participation replace

```bash
npx @oim-dev/relay-cli application participation replace WEB \
  --actor agent \
  --implementations WEB-FI-1 WEB-SI-1 \
  --if-revision 2 \
  --if-version VERSION
```

R плюс обязательный `--if-version <version>`. Ровно один вариант:
`--implementations <refs...>` — весь активный набор существующих реализаций данного
приложения, либо `--clear` — снять всё участие. Тексты и адреса сохраняются;
исключённые реализации не удаляются. SI требует FI. CLI проверяет исходные revision
и version, Core атомарно меняет состав; скрытого повтора нет. Ответ — квитанция состава.
Для новых реализаций используйте implementation create, отдельного deactivate нет.

### implementation list

`npx @oim-dev/relay-cli implementation list` — L; дополнительные фильтры:
`--status <state>`, `--feature <ref>`, `--application <ref>`, `--scenario <ref>`,
`--target <ref>`, `--active <value>` (true/false).

### implementation get

`npx @oim-dev/relay-cli implementation get WEB-FI-1` — полное описание вклада,
участие и собственная ревизия реализации. Читает также снятые реализации.

### implementation create

```bash
npx @oim-dev/relay-cli implementation create \
  --actor agent \
  --application WEB \
  --target FEATURE-1 \
  --title 'Поиск в Web' \
  --description 'Вклад интерфейса'
```

C; обязательны `--application <ref>`, `--target <ref>` (фича/сценарий),
`--title <text>` и непустая T(description). `--status <status>` — совместимая
отметка none/partial/done, не вычисляемая готовность; по умолчанию none.
При возврате снятой пары приложение/цель Core использует прежний ID, но заменяет
содержание переданными полями. Чтобы вернуть участие **без замены текстов**, используйте
participation replace. Ответ — квитанция реализации.

### implementation update

```bash
npx @oim-dev/relay-cli implementation update WEB-FI-1 \
  --actor agent \
  --title 'Уточнённый вклад' \
  --if-revision 1
```

R собственной ревизии; `--title <text>`, T(description), `--status <status>`.
Минимум одно поле. Приложение, цель и участие не меняются.

### implementation rename

```bash
npx @oim-dev/relay-cli implementation rename WEB-FI-1 WEB-SEARCH \
  --actor agent \
  --if-revision 1
```

K по `<ref> <key>`.

### implementation progress

`npx @oim-dev/relay-cli implementation progress WEB-FI-1` — G: собственные задачи,
а для FI также активные SI. Снятое участие не равно выполнению.

## Документы и разделы

Содержание документа D: `--name <text>`, T(summary), T(body),
`--document-kind <kind>` (specification/description/rules/instruction/proposal/decision/research),
`--document-status <state>` (draft/active/archived), `--section-id <id>`,
`--clear-section`, `--pinned <value>` (строго true/false), `--targets <refs...>`,
`--clear-targets`, `--clear-relations`. Section-id конфликтует с clear-section,
targets — с clear-targets. Targets заменяет прежние продуктовые области, clear-relations
очищает только современные адресные отношения. Две формы не очищают друг друга.

### document list

`npx @oim-dev/relay-cli document list` — L; дополнительно `--status <state>`,
`--target <ref>`, `--section <id>` (none — без раздела), `--document-kind <kind>`,
`--pinned <value>`, `--archived <value>` (true/false). Ответ — краткие документы.

### document get

`npx @oim-dev/relay-cli document get DOC-1` — полное body, метаданные и ревизия,
без собственных флагов. Не заменяйте это чтение превью списка.

### document create

```bash
npx @oim-dev/relay-cli document create \
  --actor agent \
  --name 'Решение' \
  --body-file ./decision.md \
  --document-kind decision
```

C и D; name и непустое body обязательны. Summary по умолчанию пустое,
document-kind — description. Ответ — квитанция; проверьте document get.

### document update

```bash
npx @oim-dev/relay-cli document update DOC-1 \
  --actor agent \
  --document-status active \
  --pinned true \
  --if-revision 1
```

R и D, минимум одно поле. Дополнительно `--clear-summary`, несовместимый
с T(summary). Непереданные поля сохраняются; смена proposal на decision сама
по себе не доказывает внешнюю приёмку.

### document rename

```bash
npx @oim-dev/relay-cli document rename DOC-1 RULES-1 \
  --actor agent \
  --if-revision 1
```

K по `<ref> <key>`, не изменение названия документа.

### document links

`npx @oim-dev/relay-cli document links DOC-1` — P прикреплений. Современные
relations и прежние links помечены раздельно; пояснения показываются полностью.
Продолжение защищено ID и ревизией документа; ответ включает его revision.

### document link

```bash
npx @oim-dev/relay-cli document link DOC-1 \
  --actor agent \
  --target FEATURE-1 \
  --relation references \
  --description 'Основание требования' \
  --if-revision 1
```

R документа; обязателен `--target <ref>`, необязательны `--relation <type>`
(references/documents, по умолчанию documents), T(description), `--clear-description`,
`--legacy`. Совпавшая цель+тип обновляет пояснение, пропущенное пояснение сохраняется.
Clear-description конфликтует с текстом. Legacy меняет прежние links/targets и
не допускает relation/пояснение/clear-description. Остальные связи сохраняются;
чтение-изменение-запись проверяет исходную ревизию. Ответ — квитанция документа.

### document unlink

```bash
npx @oim-dev/relay-cli document unlink DOC-1 \
  --actor agent \
  --target FEATURE-1 \
  --if-revision 2
```

R документа; обязателен `--target <ref>`, допустимы `--relation <type>`
(по умолчанию documents) или `--legacy`, но не вместе. Снимает только выбранное
существующее прикрепление, не удаляет документ. Ответ — квитанция.

### document section list

`npx @oim-dev/relay-cli document section list` — P разделов в их порядке и revision
проекта. Если массив ещё не задан, используются стандартные разделы. Версия
продолжения привязана к PROJECT; для записи нужна показанная ревизия проекта.

### document section create

```bash
npx @oim-dev/relay-cli document section create guides \
  --actor agent \
  --name 'Руководства' \
  --if-revision 1
```

R проекта, обязательный `--name <text>`; `<id>` — новый постоянный ID раздела.
Добавляет раздел в конец. CLI читает массив, проверяет исходную ревизию и сохраняет
полный изменённый массив под той же ревизией. Ответ — квитанция PROJECT.

### document section update

```bash
npx @oim-dev/relay-cli document section update guides \
  --actor agent \
  --name 'Инструкции' \
  --if-revision 2
```

R проекта и обязательный `--name <text>`. Меняет имя существующего раздела,
сохраняя ID, порядок и остальные разделы; ответ — квитанция PROJECT.

### document section move

```bash
npx @oim-dev/relay-cli document section move guides \
  --actor agent \
  --last \
  --if-revision 3
```

R проекта. Нужен ровно один из `--before <id>` или `--last`. Нельзя ставить
раздел перед самим собой или неизвестным разделом. Ответ — квитанция PROJECT.

### document section remove

```bash
npx @oim-dev/relay-cli document section remove guides \
  --actor agent \
  --if-revision 4
```

R проекта, других флагов нет. Удаляет существующий раздел, не документы;
они остаются без раздела. Все операции section сохраняют непереданные разделы
через guarded read-modify-write, не повторяют запись при конфликте.

## Доски и задачи

### board list

`npx @oim-dev/relay-cli board list` — P системных досок и досок приложений.
Ответ — краткие свойства; самостоятельных board create/delete нет.

### board get

`npx @oim-dev/relay-cli board get BOARD-PRODUCT` — карточка по ключу или ID,
канонический ключ и ревизия, без собственных флагов.

### task list

```bash
npx @oim-dev/relay-cli task list \
  --board product \
  --completion unfinished
```

P.
Фильтры: `--board <ref>` (slug/префикс/ID), `--column <column>`,
`--completion <state>` (unfinished/finished), `--search-in <scope>` (title/all),
`--product-target <ref>`, `--q <text>`, `--readiness <state>` (blocked/ready).
Finished означает done/cancelled, не фактический успех. Ready — готовые к работе
задачи ready без блокеров. Ответ — краткие задачи, не полные Markdown.

### task get

`npx @oim-dev/relay-cli task get PRODUCT-1` — полная задача и ревизия по текущему
или прежнему ключу/ID. Собственных флагов нет; коллекции читайте адресными списками.

### task create

```bash
npx @oim-dev/relay-cli task create \
  --actor agent \
  --board BOARD-PRODUCT \
  --title 'Проверить поиск' \
  --criterion-title 'search=Находит документ' \
  --criterion-summary 'search=По названию' \
  --criterion-description 'search=Введите название и проверьте результат'
```

C; обязателен `--board <ref>`. Допустимы `--title <text>`, T(description),
`--column <column>` (по умолчанию inbox), `--parent <ref>`, `--dependencies <refs...>`,
`--related <refs...>`, `--targets <refs...>`, `--clear-targets` (не вместе с targets).
Название и описание могут быть пустыми. Цели зависят от доски: общие требования
на продуктовой, реализации своего приложения на прикладной, без целей на инфраструктурной.

Критерии задаются повторяемыми `--criterion-title <label=text>`,
`--criterion-summary <label=text>`, `--criterion-description <label=Markdown>`.
Метка состоит из латиницы, цифр, `_`, `-`, не сохраняется; разделитель — первое `=`.
Для каждой метки обязателен title, остальные тексты по умолчанию пусты; повтор
одного поля метки — ошибка. До 100 критериев; задача, критерии и связи создаются
одной предметной операцией. Метки связывают поля независимо от порядка флагов.
Ответ — квитанция задачи; перечитайте get и criterion list.

### task update

```bash
npx @oim-dev/relay-cli task update PRODUCT-1 \
  --actor agent \
  --title 'Уточнить поиск' \
  --if-revision 1
```

R; `--title <text>`, T(description), `--targets <refs...>` или `--clear-targets`.
Переданный набор целей заменяется целиком; пропуск сохраняет его. Колонка,
критерии и связи меняются отдельными командами. Ответ — квитанция задачи.

### task rename

```bash
npx @oim-dev/relay-cli task rename PRODUCT-1 TASK-1 \
  --actor agent \
  --if-revision 1
```

K задачи по `<task> <key>`; не изменение title.

### task move

```bash
npx @oim-dev/relay-cli task move PRODUCT-1 \
  --actor agent \
  --column review \
  --if-revision 1
```

R; обязателен `--column <column>`: inbox/ready/in-progress/review/done/cancelled.
`--board <ref>` меняет доску, `--before <ref>` задаёт следующую задачу (без него конец),
`--if-version <version>` проверяет прочитанную версию порядка. ID сохраняется;
несовместимые цели снимите явно. Core проверяет обязательства при завершении.
Ответ — квитанция; перечитайте task get и нужный список.

### task children

`npx @oim-dev/relay-cli task children PRODUCT-1` — P прямых детей. Фильтр родителя
применяется до пагинации, не локально к уже ограниченной странице.

### task links

`npx @oim-dev/relay-cli task links PRODUCT-1` — P родителя, детей, зависимостей,
блокируемых и обычных связанных задач. Страница не равна всему составу.

### task progress

`npx @oim-dev/relay-cli task progress PRODUCT-1` — G: критерии, дети, зависимости
и причины неготовности. Колонка done сама по себе не доказывает выполнение.

### task parent set

```bash
npx @oim-dev/relay-cli task parent set PRODUCT-2 PRODUCT-1 \
  --actor agent \
  --if-revision 1
```

R первой задачи; `<task> <parent>` устанавливает родителя. Core проверяет циклы.
Ответ — квитанция задачи, не независимая запись диагностического графа.

### task parent clear

```bash
npx @oim-dev/relay-cli task parent clear PRODUCT-2 \
  --actor agent \
  --if-revision 2
```

R задачи. CLI читает существующего родителя под исходной ревизией; отсутствие
родителя — ошибка. Обе задачи сохраняются; ответ — квитанция.

### task dependency list

`npx @oim-dev/relay-cli task dependency list PRODUCT-2` — P прямых обязательных
зависимостей. Используется dependencies предметного прогресса, не фильтрация
страницы всех links. JSON data сохраняет полный ответ прогресса; meta.page
описывает dependencies. Ревизии соседних задач ответ не предоставляет.

### task dependency add

```bash
npx @oim-dev/relay-cli task dependency add PRODUCT-2 PRODUCT-1 \
  --actor agent \
  --if-revision 1
```

R первой задачи: её выполнение требует результата второй. Ответ — квитанция.

### task dependency remove

```bash
npx @oim-dev/relay-cli task dependency remove PRODUCT-2 PRODUCT-1 \
  --actor agent \
  --if-revision 2
```

R первой задачи: снимает depends-on, не удаляет задачи. Ответ — квитанция.

### task link

```bash
npx @oim-dev/relay-cli task link PRODUCT-1 PRODUCT-2 \
  --actor agent \
  --if-revision 1
```

R первой задачи; устанавливает только related без блокировки. Target —
позиционный аргумент, флагов `--relation`/`--target` здесь нет. Ответ — квитанция.

### task unlink

```bash
npx @oim-dev/relay-cli task unlink PRODUCT-1 PRODUCT-2 \
  --actor agent \
  --if-revision 2
```

R первой задачи: снимает related. Для parent/depends-on используйте их владельцев.

## Критерии и обсуждения

Во всех изменениях criterion используется R **задачи**, не локальная ревизия критерия.
`<criterion>` — постоянный ID из списка. В done операции с критериями заблокированы;
сначала верните задачу в работу. Изменение текста снимает отметку выполнения,
сохранение того же текста — нет. Квитанция относится к задаче.

### task criterion list

`npx @oim-dev/relay-cli task criterion list PRODUCT-1` — P кратких критериев.
Полный Markdown читайте через get; для изменения нужна ревизия задачи.

### task criterion get

`npx @oim-dev/relay-cli task criterion get PRODUCT-1 Abc12345` — полное содержание,
отметка, автор/время выполнения и ревизия задачи. Собственных флагов нет.

### task criterion add

```bash
npx @oim-dev/relay-cli task criterion add PRODUCT-1 \
  --actor agent \
  --title 'Результат проверен' \
  --if-revision 1
```

R; обязательный `--title <text>`, необязательные T(summary), T(description).
Создаёт невыполненный критерий. Описания по умолчанию пусты.

### task criterion update

```bash
npx @oim-dev/relay-cli task criterion update PRODUCT-1 Abc12345 \
  --actor agent \
  --summary 'Проверить повторное открытие' \
  --if-revision 2
```

R; `--title <text>`, T(summary), T(description), только переданные поля.

### task criterion complete

```bash
npx @oim-dev/relay-cli task criterion complete PRODUCT-1 Abc12345 \
  --actor agent \
  --if-revision 3
```

R; отмечает completed=true, не закрывает задачу автоматически.

### task criterion reopen

```bash
npx @oim-dev/relay-cli task criterion reopen PRODUCT-1 Abc12345 \
  --actor agent \
  --if-revision 4
```

R; явно снимает отметку completed.

### task criterion remove

```bash
npx @oim-dev/relay-cli task criterion remove PRODUCT-1 Abc12345 \
  --actor agent \
  --if-revision 5
```

R; удаляет критерий, не задачу.

### task comment list

```bash
npx @oim-dev/relay-cli task comment list PRODUCT-1 \
  --limit 20
```

P ленты,
по умолчанию размер из output.defaultLimit. `--after <n>` — после последовательного номера,
`--by <name>` — точное имя автора, `--action <action>` — только comment-publish.
CLI-курсор сохраняет исходный native token ленты, подключение, ref задачи, фильтры
и limit. Для продолжения достаточно `--cursor` со значением **из meta.page.nextCursor**
в том же контексте команды и задачи; повторять limit/фильтры не требуется.
`meta.page.nextCommand` может опускать эти флаги, потому что wrapper восстанавливает их.
`data.nextCursor` — сырой native token, оставленный для совместимости DTO; CLI его
напрямую не принимает. Total может отсутствовать.

```bash
npx @oim-dev/relay-cli task comment list PRODUCT-1 \
  --by worker-api \
  --limit 10 \
  --format json
npx @oim-dev/relay-cli task comment list PRODUCT-1 \
  --cursor 'CURSOR_ИЗ_META_PAGE_NEXTCURSOR' \
  --format json
```

Во втором вызове замените placeholder значением `meta.page.nextCursor` первого ответа,
если оно не null. Фильтр by и limit=10 восстановятся из wrapper. Для HTTP/workspace
сохраните исходные параметры подключения либо скопируйте `meta.page.nextCommand`.

### task comment get

`npx @oim-dev/relay-cli task comment get PRODUCT-1 1` — полное сообщение;
`<entryId>` — номер из списка, не ID критерия. Собственных флагов нет.

### task comment add

```bash
npx @oim-dev/relay-cli task comment add PRODUCT-1 \
  --actor worker-api \
  --role worker \
  --title 'Проверка' \
  --description '## Результат

Проверено повторное открытие.'
```

C без ревизии задачи. Обязательны `--title <text>`, `--role <role>`
(operator/orchestrator/worker) и непустая T(description). Доступно в любой колонке,
не меняет ревизию содержания или готовность. Ответ — квитанция публикации.
Повтор с тем же request-id может создать новое сообщение; update/remove комментариев нет.

## Планы и этапы

Состояния плана: draft/active/completed/cancelled. Закрытые планы неизменяемы.
Plan/release rename отсутствуют: Core не поддерживает это действие.
Для этапов `<reference>` — план, `<stage>` — внутренний ID этапа, не отдельный ключ.
Любое изменение этапа защищено R плана. Порядок этапов не запрещает параллельное выполнение.

Содержание плана F: `--title <title>`, T(summary), T(goal), T(rationale),
T(boundaries), T(expected-result), `--scope <references...>`, `--clear-scope`,
`--participants <actors...>`. Scope принимает ключи/kind:ID допустимых предметных
областей; конфликтует с clear-scope. Переданный scope/participants заменяет набор.

### plan list

`npx @oim-dev/relay-cli plan list` — P; `--q <text>`, `--status <status>`.
Ответ — краткие планы со счётчиками, независимыми от размера страницы.

### plan get

`npx @oim-dev/relay-cli plan get PLN-1` — полные тексты, состояние, ревизия
и актуальная готовность. Собственных флагов нет; состав имеет отдельные списки.

### plan create

```bash
npx @oim-dev/relay-cli plan create \
  --actor agent \
  --title 'Поиск' \
  --goal 'Проверенный сценарий поиска'
```

C и F; title обязателен. Создаёт draft; заполните цель до начала выполнения.
Ответ — квитанция плана; после создания добавьте этап и состав.

### plan update

```bash
npx @oim-dev/relay-cli plan update PLN-1 \
  --actor agent \
  --goal 'Уточнённая цель' \
  --if-revision 1
```

R и F; только переданные поля. Не заменяет явные переходы состояния.

### plan start

```bash
npx @oim-dev/relay-cli plan start PLN-1 \
  --actor agent \
  --if-revision 3
```

R; регистрирует также T(result), но результат не обязателен для start.
Требуются заполненная цель и непустой состав задач. Отдельный start не обязателен
для работы над задачами или последующего complete. Ответ — квитанция перехода.

### plan complete

```bash
npx @oim-dev/relay-cli plan complete PLN-1 \
  --actor agent \
  --result 'Проверено выполнение сценария' \
  --if-revision 4
```

R и обязательная непустая T(result). Core проверяет весь непустой состав и
фактическое выполнение задач. Разрешено из draft/active. Ответ — квитанция;
перечитайте состояние completed и итог через get.

### plan cancel

```bash
npx @oim-dev/relay-cli plan cancel PLN-1 \
  --actor agent \
  --result 'Объём пересмотрен' \
  --if-revision 4
```

R и обязательная непустая T(result) с причиной. Не отменяет задачи автоматически;
закрытый план остаётся только для чтения. Ответ — квитанция.

### plan progress

`npx @oim-dev/relay-cli plan progress PLN-1` — G по полному явному составу.
Вычисляемая готовность не равна сохранённому состоянию completed.

### plan stage list

`npx @oim-dev/relay-cli plan stage list PLN-1` — P этапов в порядке, со счётчиками.
Возвращённые ID используйте вместе с планом.

### plan stage get

`npx @oim-dev/relay-cli plan stage get PLN-1 Ab12Cd34` — полные тексты этапа,
явные taskIds и planRevision из текущей сущности плана. Собственных флагов нет.

### plan stage create

```bash
npx @oim-dev/relay-cli plan stage create PLN-1 \
  --actor agent \
  --title 'Первый этап' \
  --if-revision 1
```

R плана; обязателен `--title <title>`, допустимы T(summary), T(outcome),
T(completion-conditions). Условия — текст, не исполняемый тест. Ответ — квитанция плана.

### plan stage update

```bash
npx @oim-dev/relay-cli plan stage update PLN-1 Ab12Cd34 \
  --actor agent \
  --outcome 'Проверенный результат' \
  --if-revision 2
```

R; `--title <title>`, T(summary), T(outcome), T(completion-conditions).
Минимум одно поле; пустая строка явно очищает описание/результат/условия.

### plan stage move

```bash
npx @oim-dev/relay-cli plan stage move PLN-1 Ab12Cd34 \
  --actor agent \
  --if-revision 3
```

R; `--before <id>` задаёт следующий этап, без него — конец. Это порядок этапов,
не ручная сортировка задач и не зависимость. Ответ — квитанция плана.

### plan stage remove

```bash
npx @oim-dev/relay-cli plan stage remove PLN-1 Ab12Cd34 \
  --actor agent \
  --if-revision 4
```

R. Удаляет только пустой этап: сначала исключите его задачи явно.

### plan stage task list

`npx @oim-dev/relay-cli plan stage task list PLN-1 Ab12Cd34` — P актуальных
задач явного состава. Дети и зависимости не включаются автоматически.

### plan stage task add

```bash
npx @oim-dev/relay-cli plan stage task add PLN-1 Ab12Cd34 \
  --actor agent \
  --tasks PRODUCT-1 \
  --if-revision 2
```

R плана; обязательный `--tasks <references...>`, максимум 2000.
Включает существующие задачи, не копии; Core проверяет текущее участие. Ответ — квитанция.

### plan stage task remove

```bash
npx @oim-dev/relay-cli plan stage task remove PLN-1 Ab12Cd34 \
  --actor agent \
  --tasks PRODUCT-1 \
  --if-revision 3
```

R; обязательный `--tasks <references...>`, максимум 2000. Снимает включение,
сохраняя сами задачи. Ответ — квитанция плана.

### plan stage task transfer

```bash
npx @oim-dev/relay-cli plan stage task transfer PLN-1 PRODUCT-1 Ef56Gh78 \
  --actor agent \
  --target-plan PLN-2 \
  --if-revision 3 \
  --target-revision 2 \
  --reason 'Пересмотр состава'
```

R исходного плана. Позиционные аргументы: исходный план, задача, ID целевого этапа.
Обязательны `--target-plan <reference>`, `--target-revision <n>`, непустая T(reason).
Проверяются обе исходные ревизии; перенос согласованно меняет включения.
Причина не обещает постоянного журнала переносов. Ответ — квитанция операции.

### plan task candidates

```bash
npx @oim-dev/relay-cli plan task candidates \
  --available-only true
```

P кандидатов.
`--q <text>`, `--board <reference>`, `--plan <reference>`, `--stage <id>` (требует plan),
`--available-only <value>` (true — доступные; false — также занятые/отменённые).
Ответ показывает текущее участие. Фильтры применяются до пагинации.

### plan task memberships

`npx @oim-dev/relay-cli plan task memberships PRODUCT-1` — P включений задачи
в текущие и закрытые планы. Это актуальные ссылки состава, не история перемещений.

## Релизы

Релиз — проектная запись с выбранными планами, не релиз приложения: applicationId
и фильтра принадлежности приложению нет. Состав — 1–200 планов целиком.
Выпущенная запись неизменяема. Фиксация выпуска не запускает CI/CD.

Содержание релиза E: `--title <title>`, `--release-version <label>`,
`--plans <references...>`, T(summary), T(description), `--planned-for <date>`
(YYYY-MM-DD; пустая строка очищает), `--status <status>` (planned/cancelled/released).
Release-version — обозначение выпуска, не глобальный --version. При update CLI
сохраняет непереданные поля из чтения, но проверяет именно переданную пользователем
ревизию, не подменяет её. Status released выполняет проверки выпуска, не обходя publish.

### release list

`npx @oim-dev/relay-cli release list` — P; `--q <text>`, `--status <status>`.
Ответ — краткие релизы с текущей готовностью состава.

### release get

`npx @oim-dev/relay-cli release get REL-1` — полное содержание, состояние,
ревизия и актуальная готовность. Собственных флагов нет.

### release preview

```bash
npx @oim-dev/relay-cli release preview \
  --plans PLN-1 PLN-2
```

Чтение без записи
и автора, P; `--plans <references...>` — выбранные планы, максимум 200.
Пустой выбор допустим для предпросмотра, но не означает готовый выпуск.
Ответ — текущая готовность и страницы выбранного состава.

### release create

```bash
npx @oim-dev/relay-cli release create \
  --actor agent \
  --title 'Первый выпуск' \
  --release-version 0.1 \
  --plans PLN-1
```

C и E; обязательны title, release-version, plans. Создание planned допускает
незавершённые планы; released требует условий выпуска. Ответ — квитанция релиза.

### release update

```bash
npx @oim-dev/relay-cli release update REL-1 \
  --actor agent \
  --summary 'Уточнённый состав' \
  --if-revision 1
```

R и E. Переданные plans заменяют весь набор. Выпущенный релиз редактировать нельзя.

### release plan

```bash
npx @oim-dev/relay-cli release plan REL-1 \
  --actor agent \
  --if-revision 2
```

R; явное перепланирование отменённого релиза. Ответ — квитанция.

### release cancel

```bash
npx @oim-dev/relay-cli release cancel REL-1 \
  --actor agent \
  --if-revision 1
```

R; отменяет плановый выпуск, не планы и задачи. Ответ — квитанция.

### release publish

```bash
npx @oim-dev/relay-cli release publish REL-1 \
  --actor agent \
  --if-revision 2
```

R; все планы должны быть completed и фактически готовы. Сохраняет факт выпуска,
не выполняет внешнюю публикацию. Ответ — квитанция; проверьте get.

### release plans

`npx @oim-dev/relay-cli release plans REL-1` — P текущих планов состава.
Даже после выпуска это актуальные данные, не исторический снимок выпуска.

### release progress

`npx @oim-dev/relay-cli release progress REL-1` — G; фактическая готовность
может измениться после выпуска, сохранённый статус released при этом остаётся.

## Поиск и инспекция

### search

```bash
npx @oim-dev/relay-cli search 'каталог' \
  --kind feature
```

P поиска разных видов.
`[text]` и `--q <text>` — альтернативы, не вместе. Дополнительные фильтры:
`--kind <kind>`, `--refs <refs...>` (выбранные ключи/ID, до 100), `--board <ref>`,
`--application <ref>`, `--feature <ref>`, `--scenario <ref>`, `--target <ref>`,
`--parent <ref>`, `--status <status>`, `--active <value>`, `--section <id>`
(none — без раздела), `--document-kind <kind>`, `--pinned <value>`,
`--archived <value>`, `--sort <field>` (key/title/updated).
Булевы значения — true/false. Виды: project/product/feature/scenario/application/
implementation/board/task/document/work-plan/release. Ответ — карточки, не полные тексты;
полное содержание читайте у владельца, например document get или plan get.

### inspect types

`npx @oim-dev/relay-cli inspect types` — P каталога видов, назначения и действий.
Наличие вида в чтении не означает доступность всех операций записи.

### inspect type

`npx @oim-dev/relay-cli inspect type document` — схемы полей, фильтры и действия
вида; `<kind>` обязателен, собственных флагов нет. Отсутствующая схема означает
отсутствие общей операции, не пустой набор обязательных полей.

### inspect resolve

`npx @oim-dev/relay-cli inspect resolve FEATURE-1 [--kind <kind>]` — постоянный
адрес по ключу, алиасу, ID или kind:ID. Kind уточняет ожидаемый вид.

### inspect keys

`npx @oim-dev/relay-cli inspect keys FEATURE-1` — P текущего ключа и алиасов.
Это не история содержимого.

### inspect key-spaces

`npx @oim-dev/relay-cli inspect key-spaces feature` — P пространств нумерации
и шаблонов ключей вида. Не меняет ключи или резервирование.

### inspect graph list

```bash
npx @oim-dev/relay-cli inspect graph list \
  --root PRODUCT-1 \
  --limit 20
```

P графа.
`--root <address>` выбирает корень, без него весь проект; `--type <type>` фильтрует
отношения, `--direction <direction>` — both/outgoing/incoming, `--profile <profile>` —
all/context (context — совместимое имя all), `--depth <n>` — 0–100,
`--q <text>` — поиск сущностей. Узлы/рёбра имеют отдельные страницы общего guard;
конец страниц не отменяет фильтры или глубину. Ответ содержит version для ремонта.

### inspect graph context

`npx @oim-dev/relay-cli inspect graph context PRODUCT-1` — вся достижимая компонента
в обоих направлениях, включая циклы и параллельные отношения. Собственных флагов,
глубины и страниц нет. Успешный ответ complete=true; лимит Core даёт ошибку,
не усечённый успех. Контекст не заменяет полные тексты требований.

## Диагностика и обслуживание

Прямой ремонт графа не устанавливает цели задач, родительство или состав планов.
Используйте предметного владельца; перед ремонтом сохраните резервную копию.
Графовые записи требуют автора, `--if-version <version>` из inspect graph list/context
и допускают `--request-id <id>`. Ответ — квитанция графа с новой версией; перечитайте связи.

### doctor check

`npx @oim-dev/relay-cli doctor check` — проверка схем, каталога, досок, задач
и связей. Нет собственных флагов, автора и автоматического ремонта. Нарушение
целостности — ошибка с exit 5, не пустая база. Успех содержит показатели проверки.

### doctor graph link

```bash
npx @oim-dev/relay-cli doctor graph link \
  --actor agent \
  --from PRODUCT-1 \
  --to DOC-1 \
  --type references \
  --if-version VERSION
```

Запись графа; обязательны `--from <address>`, `--to <address>`, `--type <type>`;
необязательна T(description). Создаёт диагностическое направленное отношение.

### doctor graph update

```bash
npx @oim-dev/relay-cli doctor graph update EDGE_ID \
  --actor agent \
  --description 'Основание' \
  --if-version VERSION
```

Запись графа; `<id>` — ID отношения, обязательна T(description).
Пустая строка явно очищает пояснение, пропуск — ошибка. Концы и тип не меняются.

### doctor graph unlink

```bash
npx @oim-dev/relay-cli doctor graph unlink EDGE_ID \
  --actor agent \
  --if-version VERSION
```

Запись графа, отзыв отношения по ID; другие предметные данные не заменяет.

### doctor graph apply

```bash
npx @oim-dev/relay-cli doctor graph apply \
  --actor agent \
  --json '[{"action":"add","from":"PRODUCT-1","to":"DOC-1","type":"references","description":"Основание"}]' \
  --if-version VERSION
```

Запись графа; обязательный `--json <json>` содержит массив до 100 операций,
не конверт запроса. Add: from/to/type/description; update: id/description;
remove: id. Пакет атомарный. Невалидный JSON — INVALID_JSON; json-file не зарегистрирован.

### storage migrate

```bash
npx @oim-dev/relay-cli storage migrate \
  --local
```

Локальное обслуживание без
собственных флагов и автора. Поддерживаемые legacy и физические версии 1/2/3
переносятся в формат 4; текущая база сообщает, что перенос не нужен. Сохраняются
текущие тексты, ID, ключи, ревизии, комментарии и алиасы, не история запросов.
Старые предметные версии планов/релизов не поддерживаются; автосброса нет.

### storage reindex

```bash
npx @oim-dev/relay-cli storage reindex \
  --local
```

Перестроение производных
индексов после внешних изменений или потери индекса; без собственных флагов и автора.
Не создаёт недостающие предметные отношения из полей. Ответ — результат
восстановления; затем выполните doctor check и адресное чтение.

### storage reconcile-relations

```bash
npx @oim-dev/relay-cli storage reconcile-relations \
  --local \
  --actor agent \
  --request-id relations-v1
```

Локальное согласование предметных связей одной транзакцией. Автор обязателен,
`--request-id <id>` необязателен; ревизия параметром не передаётся.
Сохраняет ID неизменённых связей, независимые диагностические рёбра и ревизии сущностей.
Ответ: added/updated/removed и requestId. После потери ответа перечитайте связи.

Все storage-команды требуют файловую рабочую область выбранного проекта, не HTTP
и не workspace-реестр. Для нестандартного пути передавайте `--config` проекта.
Сначала остановите записи и сохраните резерв, после — выполните doctor check.
Команд удаления сущностей, истории запросов, product state/save/context,
старых entities/boards/projects/progress/graph на верхнем уровне нет.
