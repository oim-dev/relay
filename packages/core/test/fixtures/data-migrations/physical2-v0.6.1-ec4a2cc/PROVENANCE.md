# physical2-v0.6.1-ec4a2cc

Замороженная база Relay, созданная реальными операциями CLI/Core коммита
`ec4a2cc940640739a9415f774a1a811378fb61d6` (2026-09-26, «chore: подготовить первый ручной npm-релиз 0.6.1», тег `v0.6.1`).
Первый содержащий тег: `v0.6.1`. Номер релиза не приписывается коммиту без тега.

## Формат

Формат 2, оболочка 1, work-plan и release `dataVersion = 2` (вложенные `stages`, у релиза нет `snapshotId`). Коммит тега v0.6.1 (первый npm-релиз).

Маркер: `{"format":"relay-entities","schemaVersion":2,"productId":"jM9FOkio"}`.
Виды версии (`entities types` той же версии): `work-plan`, `release`, `project`, `product`, `feature`, `scenario`, `application`, `implementation`, `board`, `task`, `document`.

## Охват

Как physical2-plan-v1, но этапы вложены в план; удаление этапа не оставляет надгробия; REL-1 released без снимков.

Отсутствующее в версии: Нет plan-stage, release-snapshot*, отдельных этапов (удалены в 1afe138).

## Особенности

Базовый перенос на 4321233 успешен (35 сущностей).

## Файлы

- `base.json.gz` — побайтный снимок дерева проекта (каталог с `.relay/`): 120 файлов,
  262 каталогов, 1831302 байт; sha256 архива `0ed0278efd3480f974261bd3fbe93f37029faff534bb5f7895be901cc8a273b6`.
  Разворачивается `../restore-tree.mjs`. Каталогом в Git хранить нельзя: `.gitignore` со строкой `*`
  внутри `.relay/runtime`, `.relay/transactions`, `.relay/.indexes` скрыл бы файлы, пустые каталоги теряются.
- `oracle.json` — независимый oracle: входные значения генератора (тексты, ключи, ID из ответов
  старого CLI, ожидаемые связи, удаления, алиасы), без чтения результата мигратора.
- `steps.jsonl` — журнал шагов генерации (аргументы, длинные тексты заменены длиной).
- `provenance.json` — SHA, генератор, состав коллекций, версии оболочек и данных.

## Генерация

```sh
git worktree add --detach <wt> ec4a2cc && (cd <wt> && pnpm install --frozen-lockfile)
cp generators/fixture-delete.mts <wt>/apps/cli/
WORKTREE=<wt> node generators/generate-unified.mjs <relay-bin> <db>/relay-fixture <out>/oracle.json <wt> nested
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
| `releases`        | 2       | 0         | 1             | 2           |
| `scenarios`       | 3       | 0         | 1             | 1           |
| `scopes`          | 2       | 0         | 1             | 1           |
| `tasks`           | 7       | 1         | 1             | 1           |
| `work-plans`      | 3       | 0         | 1             | 2           |

## Ключевые сущности oracle

| Псевдоним | Вид            | ID         | Ключ         |
| --------- | -------------- | ---------- | ------------ |
| project   | project        | `jM9FOkio` | ``           |
| passport  | product        | `passport` | `PRODUCT`    |
| F1        | feature        | `r6lYYJo2` | `FEATURE-1`  |
| F2        | feature        | `hAuCIPNA` | `FEATURE-UX` |
| F3        | feature        | `fOaFxDEw` | `FEATURE-3`  |
| S1        | scenario       | `kEG5LfaD` | `SCENARIO-1` |
| S2        | scenario       | `3Hu0VcnU` | `SCENARIO-2` |
| S3        | scenario       | `UF4VhSRa` | `SCENARIO-3` |
| A1        | application    | `s6JFYiR4` | `WEB`        |
| A2        | application    | `fT1LyFiV` | `API`        |
| FI1       | implementation | `nohQ5AGV` | `WEB-FI-1`   |
| SI1       | implementation | `Bx7XLPmA` | `WEB-SI-1`   |
| FI2       | implementation | `tkmy3YZP` | `API-FI-1`   |
| T7        | task           | `petlR1xr` | `PRODUCT-2`  |
| T1        | task           | `BqLmRHsZ` | `WEB-1`      |
| T2        | task           | `1RIDmqjb` | `WEB-2`      |
| T3        | task           | `1wEfiKSe` | `API-1`      |
| T4        | task           | `dcgGvEgL` | `WEB-3`      |
| T5        | task           | `FEpwBUVt` | `PRODUCT-1`  |
| T6        | task           | `lAeMgN2x` | `API-2`      |
| D1        | document       | `2c6d5PWW` | `DOC-1`      |
| D2        | document       | `41MjJLiP` | `DOC-2`      |
| D3        | document       | `gH37VD2p` | `DOC-3`      |
| D4        | document       | `rWAFHFES` | `DOC-4`      |
| P1        | work-plan      | `PBs9PxtI` | `PLN-1`      |
| P2        | work-plan      | `U6n9Fcmy` | `PLN-2`      |
| P3        | work-plan      | `wXJTOi38` | `PLN-3`      |
| R1        | release        | `lBU4v5LJ` | `REL-1`      |
| R2        | release        | `KqS5H3XR` | `REL-2`      |
