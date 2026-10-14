# legacy-5c7265b

Замороженная база Relay, созданная реальными операциями CLI/Core коммита
`5c7265b78725faf158d90a495f99715d7344005b` (2026-09-22, «chore: черновая реализация документов»).
Первый содержащий тег: `v0.6.1`. Номер релиза не приписывается коммиту без тега.

## Формат

Legacy-раскладка последней версии перед единым хранением: `product/` (+ `.document-links`), `boards/*/tasks/*.json` (`version: 5`, с `acceptanceCriteria`), `task-activity/<taskId>/…` (комментарии, события), `entity-deletions/` (keys.json, receipts), граф v2 `relations/`. Нет `storage.json`.

Маркер: отсутствует (legacy).
Виды версии (`entities types` той же версии): `project`, `product`, `feature`, `scenario`, `application`, `implementation`, `board`, `task`, `document`.

## Охват

Все владельцы версии: project с разделами документов, паспорт, фичи/сценарии, приложения, FI/SI, неактивная реализация, задачи с критериями (выполненный и невыполненный), зависимостью, related, родителем, переносом доски, комментарии (CRLF, Unicode, длинный ~12 КиБ, разные авторы и роли), документы с relations/разделами/архивом/закреплением, диагностические рёбра active/revoked, удаления task/document/feature.

Отсутствующее в версии: Нет планов/этапов/релизов (появились в 43d683b) и сегментированных наборов отношений (граф v2 хранит рёбра по одному файлу).

## Особенности

Массовые диагностические рёбра для сегментов в legacy-профиле не создавались. Базовый перенос на 4321233 успешен (27 сущностей).

## Файлы

- `base.json.gz` — побайтный снимок дерева проекта (каталог с `.relay/`): 148 файлов,
  94 каталогов, 131791 байт; sha256 архива `9600a4955e953df91060bae3ff43c633e144046c4e73b266be401f7e3d97f754`.
  Разворачивается `../restore-tree.mjs`. Каталогом в Git хранить нельзя: `.gitignore` со строкой `*`
  внутри `.relay/runtime`, `.relay/transactions`, `.relay/.indexes` скрыл бы файлы, пустые каталоги теряются.
- `oracle.json` — независимый oracle: входные значения генератора (тексты, ключи, ID из ответов
  старого CLI, ожидаемые связи, удаления, алиасы), без чтения результата мигратора.
- `steps.jsonl` — журнал шагов генерации (аргументы, длинные тексты заменены длиной).
- `provenance.json` — SHA, генератор, состав коллекций, версии оболочек и данных.

## Генерация

```sh
git worktree add --detach <wt> 5c7265b && (cd <wt> && pnpm install --frozen-lockfile)
cp generators/fixture-delete.mts <wt>/apps/cli/
WORKTREE=<wt> node generators/generate-unified.mjs <relay-bin> <db>/relay-fixture <out>/oracle.json <wt> legacy
node generators/pack-tree.mjs <db>/relay-fixture base.json.gz stats.json
```

`<relay-bin>` — обёртка по образцу `generators/relay-bin.sh.example`; автор по умолчанию `fixture-author`,
Node v24.3.0. Повторная генерация даёт другие ID и даты: фикстуру не перегенерируют,
тесты генератор не исполняют.

## Коллекции записей

| Коллекция            | Записей | Надгробий | schemaVersion | dataVersion |
| -------------------- | ------- | --------- | ------------- | ----------- |
| — (legacy-раскладка) |         |           |               |             |

## Ключевые сущности oracle

| Псевдоним | Вид            | ID         | Ключ         |
| --------- | -------------- | ---------- | ------------ |
| project   | project        | `fnWE4i8g` | ``           |
| passport  | product        | `passport` | `PRODUCT`    |
| F1        | feature        | `9LGB2QX5` | `FEATURE-1`  |
| F2        | feature        | `6dt6dStk` | `FEATURE-UX` |
| F3        | feature        | `r6i2NMvp` | `FEATURE-3`  |
| S1        | scenario       | `bgr6GxUh` | `SCENARIO-1` |
| S2        | scenario       | `e7A51flf` | `SCENARIO-2` |
| S3        | scenario       | `P07Ue4ig` | `SCENARIO-3` |
| A1        | application    | `WP5uBfBW` | `WEB`        |
| A2        | application    | `ZOW3aTBR` | `API`        |
| FI1       | implementation | `5tkODD3k` | `WEB-FI-1`   |
| SI1       | implementation | `cmbxi8Tv` | `WEB-SI-1`   |
| FI2       | implementation | `CIvGGgpU` | `API-FI-1`   |
| T7        | task           | `cGlbt29t` | `PRODUCT-2`  |
| T1        | task           | `6XtSz0Lk` | `WEB-1`      |
| T2        | task           | `dT8a9zYW` | `WEB-2`      |
| T3        | task           | `DTAv61jm` | `API-1`      |
| T4        | task           | `9XqVS5q2` | `WEB-3`      |
| T5        | task           | `QtZuV5Mg` | `PRODUCT-1`  |
| T6        | task           | `d3LUa0BG` | `API-2`      |
| D1        | document       | `7xyzrE0x` | `DOC-1`      |
| D2        | document       | `hsj6WPEC` | `DOC-2`      |
| D3        | document       | `9AywMc2i` | `DOC-3`      |
| D4        | document       | `GJn6lAr2` | `DOC-4`      |
