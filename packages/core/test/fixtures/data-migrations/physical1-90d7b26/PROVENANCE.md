# physical1-90d7b26

Замороженная база Relay, созданная реальными операциями CLI/Core коммита
`90d7b26933902765605b6ff389ccc02a3833e243` (2026-09-22, «feat: поменять структуру хранилища»).
Первый содержащий тег: `v0.6.1`. Номер релиза не приписывается коммиту без тега.

## Формат

Единое хранение, `storage.json.schemaVersion = 1`, оболочка записей 1, все виды `dataVersion = 1`, служебные источники `operations/<uuid>.json` (с `changes`, `events`, квитанциями), индексы `.indexes/`. Единственный коммит истории, который пишет формат 1 (68124da уже пишет 2).

Маркер: `{"format":"relay-entities","schemaVersion":1,"productId":"kPK0FPlD"}`.
Виды версии (`entities types` той же версии): `project`, `product`, `feature`, `scenario`, `application`, `implementation`, `board`, `task`, `document`.

## Охват

Как legacy-5c7265b, плюс надгробия в `entities/*`, keyspaces, `relations/<collection>/<id>.json` inline и сегментированный набор: владелец задачи PRODUCT-2 с 300 диагностическими рёбрами (`relations/tasks/<id>/<prefix>.json`, limit inline = 256).

Отсутствующее в версии: Нет work-plan/plan-stage/release (появились в 43d683b).

## Особенности

Остались пустые прежние каталоги `boards/`, `tasks/` и `relations/.indexes/edges.json` от инициализации той версии. Индексы компактированы командой `storage reindex` той же версии. Комментарии хранятся только как события в `operations/` (поля `comments` в записях задач нет).

## Файлы

- `base.json.gz` — побайтный снимок дерева проекта (каталог с `.relay/`): 158 файлов,
  253 каталогов, 2631556 байт; sha256 архива `8cb84f2d220f623b98c3c833aa0a970b728fdcfa6ddf25f6a18d539f9c19f6cf`.
  Разворачивается `../restore-tree.mjs`. Каталогом в Git хранить нельзя: `.gitignore` со строкой `*`
  внутри `.relay/runtime`, `.relay/transactions`, `.relay/.indexes` скрыл бы файлы, пустые каталоги теряются.
- `oracle.json` — независимый oracle: входные значения генератора (тексты, ключи, ID из ответов
  старого CLI, ожидаемые связи, удаления, алиасы), без чтения результата мигратора.
- `steps.jsonl` — журнал шагов генерации (аргументы, длинные тексты заменены длиной).
- `provenance.json` — SHA, генератор, состав коллекций, версии оболочек и данных.

## Генерация

```sh
git worktree add --detach <wt> 90d7b26 && (cd <wt> && pnpm install --frozen-lockfile)
cp generators/fixture-delete.mts <wt>/apps/cli/
WORKTREE=<wt> node generators/generate-unified.mjs <relay-bin> <db>/relay-fixture <out>/oracle.json <wt> f1
node generators/pack-tree.mjs <db>/relay-fixture base.json.gz stats.json
```

`<relay-bin>` — обёртка по образцу `generators/relay-bin.sh.example`; автор по умолчанию `fixture-author`,
Node v24.3.0. Повторная генерация даёт другие ID и даты: фикстуру не перегенерируют,
тесты генератор не исполняют.

## Коллекции записей

| Коллекция         | Записей | Надгробий | schemaVersion | dataVersion |
| ----------------- | ------- | --------- | ------------- | ----------- |
| `applications`    | 2       | 0         | 1             | 1           |
| `boards`          | 4       | 0         | 1             | 1           |
| `documents`       | 4       | 1         | 1             | 1           |
| `features`        | 3       | 1         | 1             | 1           |
| `implementations` | 3       | 0         | 1             | 1           |
| `products`        | 1       | 0         | 1             | 1           |
| `projects`        | 1       | 0         | 1             | 1           |
| `scenarios`       | 3       | 0         | 1             | 1           |
| `scopes`          | 2       | 0         | 1             | 1           |
| `tasks`           | 7       | 1         | 1             | 1           |

## Ключевые сущности oracle

| Псевдоним | Вид            | ID         | Ключ         |
| --------- | -------------- | ---------- | ------------ |
| project   | project        | `kPK0FPlD` | ``           |
| passport  | product        | `passport` | `PRODUCT`    |
| F1        | feature        | `1X0hl6bM` | `FEATURE-1`  |
| F2        | feature        | `8nEzyqvi` | `FEATURE-UX` |
| F3        | feature        | `g5dADWPa` | `FEATURE-3`  |
| S1        | scenario       | `7xz0lLfA` | `SCENARIO-1` |
| S2        | scenario       | `ghuZsioe` | `SCENARIO-2` |
| S3        | scenario       | `Kx35aV4p` | `SCENARIO-3` |
| A1        | application    | `9dUVk1iu` | `WEB`        |
| A2        | application    | `H2Ac3pND` | `API`        |
| FI1       | implementation | `cmc8rq8h` | `WEB-FI-1`   |
| SI1       | implementation | `APVU7lQA` | `WEB-SI-1`   |
| FI2       | implementation | `0CPHxrhd` | `API-FI-1`   |
| T7        | task           | `fCP6vjC3` | `PRODUCT-2`  |
| T1        | task           | `UYC2ypmj` | `WEB-1`      |
| T2        | task           | `1X2lDNXU` | `WEB-2`      |
| T3        | task           | `6Cbmtb8s` | `API-1`      |
| T4        | task           | `CPi0GCM3` | `WEB-3`      |
| T5        | task           | `SY406XMk` | `PRODUCT-1`  |
| T6        | task           | `CqjfzyWP` | `API-2`      |
| D1        | document       | `3mQqultC` | `DOC-1`      |
| D2        | document       | `yg7E5sIQ` | `DOC-2`      |
| D3        | document       | `PsUwT0o9` | `DOC-3`      |
| D4        | document       | `uLYqEzfS` | `DOC-4`      |
