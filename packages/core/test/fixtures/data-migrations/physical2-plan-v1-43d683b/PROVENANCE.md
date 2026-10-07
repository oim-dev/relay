# physical2-plan-v1-43d683b

Замороженная база Relay, созданная реальными операциями CLI/Core коммита
`43d683be11cda57f8861468c20ae14b18cc9e419` (2026-09-24, «feat: планы и релизы (часть 1)»).
Первый содержащий тег: `v0.6.1`. Номер релиза не приписывается коммиту без тега.

## Формат

Единое хранение, `schemaVersion = 2` (`history/<stream>/<16 цифр>.json`), оболочка 1, все виды `dataVersion = 1`, включая work-plan v1, отдельные `plan-stage`, release v1 со `snapshotId`, технические `release-snapshot` и `release-snapshot-entry`. Единственный коммит с планом v1 (1afe138^ = 43d683b); ни один тег его не содержит без 1afe138.

Маркер: `{"format":"relay-entities","schemaVersion":2,"productId":"8NNpzkYx"}`.
Виды версии (`entities types` той же версии): `work-plan`, `plan-stage`, `release`, `project`, `product`, `feature`, `scenario`, `application`, `implementation`, `board`, `task`, `document`.

## Охват

Всё из physical1 плюс: PLN-1 completed (результат с CRLF, scope, участники) с этапами STG-1/STG-4/STG-3 (rank 0/1/2 после `stage move`), удалённый этап STG-2 (надгробие, ключ STG-2 зарезервирован), PLN-2 active (STG-5, STG-6; T1 одновременно в закрытом PLN-1 и активном PLN-2), PLN-3 cancelled без этапов, REL-1 released (snapshotId, 19 записей снимка), REL-2 planned. Документ DOC-2 связан с work-plan и с plan-stage (`relations[].target.kind = plan-stage`). Keyspace `global-plan-stage` (STG). `relations/plan-stages/*` с membership-рёбрами `task → plan-stage` (`part-of`, слот `planning-membership`).

Отсутствующее в версии: —

## Особенности

После выпуска REL-1 тело DOC-4 изменено: прежний текст остаётся только в `release-snapshot-entries` (oracle `D4.bodyOnlyInReleaseSnapshot`). Базовый перенос на 4321233 отклоняет базу: `UNKNOWN_ENTITY_KIND`. Комментарии — только в сегментах `history/`.

## Файлы

- `base.json.gz` — побайтный снимок дерева проекта (каталог с `.relay/`): 153 файлов,
  278 каталогов, 1924358 байт; sha256 архива `7dc38cf7902f65366bd3cd14f617d2353ba0b1f99c4139bb958ce31d87858276`.
  Разворачивается `../restore-tree.mjs`. Каталогом в Git хранить нельзя: `.gitignore` со строкой `*`
  внутри `.relay/runtime`, `.relay/transactions`, `.relay/.indexes` скрыл бы файлы, пустые каталоги теряются.
- `oracle.json` — независимый oracle: входные значения генератора (тексты, ключи, ID из ответов
  старого CLI, ожидаемые связи, удаления, алиасы), без чтения результата мигратора.
- `steps.jsonl` — журнал шагов генерации (аргументы, длинные тексты заменены длиной).
- `provenance.json` — SHA, генератор, состав коллекций, версии оболочек и данных.

## Генерация

```sh
git worktree add --detach <wt> 43d683b && (cd <wt> && pnpm install --frozen-lockfile)
cp generators/fixture-delete.mts <wt>/apps/cli/
WORKTREE=<wt> node generators/generate-unified.mjs <relay-bin> <db>/relay-fixture <out>/oracle.json <wt> f2-stages
node generators/pack-tree.mjs <db>/relay-fixture base.json.gz stats.json
```

`<relay-bin>` — обёртка по образцу `generators/relay-bin.sh.example`; автор по умолчанию `fixture-author`,
Node v24.3.0. Повторная генерация даёт другие ID и даты: фикстуру не перегенерируют,
тесты генератор не исполняют.

## Коллекции записей

| Коллекция                  | Записей | Надгробий | schemaVersion | dataVersion |
| -------------------------- | ------- | --------- | ------------- | ----------- |
| `applications`             | 2       | 0         | 1             | 1           |
| `boards`                   | 4       | 0         | 1             | 1           |
| `documents`                | 4       | 1         | 1             | 1           |
| `features`                 | 3       | 1         | 1             | 1           |
| `implementations`          | 3       | 0         | 1             | 1           |
| `plan-stages`              | 6       | 1         | 1             | 1           |
| `products`                 | 1       | 0         | 1             | 1           |
| `projects`                 | 1       | 0         | 1             | 1           |
| `release-snapshot-entries` | 19      | 0         | 1             | 1           |
| `release-snapshots`        | 1       | 0         | 1             | 1           |
| `releases`                 | 2       | 0         | 1             | 1           |
| `scenarios`                | 3       | 0         | 1             | 1           |
| `scopes`                   | 2       | 0         | 1             | 1           |
| `tasks`                    | 7       | 1         | 1             | 1           |
| `work-plans`               | 3       | 0         | 1             | 1           |

## Ключевые сущности oracle

| Псевдоним | Вид            | ID         | Ключ         |
| --------- | -------------- | ---------- | ------------ |
| project   | project        | `8NNpzkYx` | ``           |
| passport  | product        | `passport` | `PRODUCT`    |
| F1        | feature        | `zKjqEjmh` | `FEATURE-1`  |
| F2        | feature        | `TbNyWdzQ` | `FEATURE-UX` |
| F3        | feature        | `9i5adQkx` | `FEATURE-3`  |
| S1        | scenario       | `xYsWPthw` | `SCENARIO-1` |
| S2        | scenario       | `5Ck5OTut` | `SCENARIO-2` |
| S3        | scenario       | `F8Vr5xa7` | `SCENARIO-3` |
| A1        | application    | `fxHrKQmM` | `WEB`        |
| A2        | application    | `XBEeM5Fw` | `API`        |
| FI1       | implementation | `AUaE1Ycu` | `WEB-FI-1`   |
| SI1       | implementation | `HtuxspOp` | `WEB-SI-1`   |
| FI2       | implementation | `3rvFtASi` | `API-FI-1`   |
| T7        | task           | `QHDPMdM5` | `PRODUCT-2`  |
| T1        | task           | `EpUnaTlR` | `WEB-1`      |
| T2        | task           | `FPZNpG13` | `WEB-2`      |
| T3        | task           | `kTYIv5xr` | `API-1`      |
| T4        | task           | `5qUbPYuC` | `WEB-3`      |
| T5        | task           | `sTpvbPrj` | `PRODUCT-1`  |
| T6        | task           | `Et5b3tiH` | `API-2`      |
| D1        | document       | `oSePV22H` | `DOC-1`      |
| D2        | document       | `L6pOAPyj` | `DOC-2`      |
| D3        | document       | `jEG8H8P1` | `DOC-3`      |
| D4        | document       | `GCTDNqtv` | `DOC-4`      |
| P1        | work-plan      | `rJAii497` | `PLN-1`      |
| P2        | work-plan      | `8OIjAZR3` | `PLN-2`      |
| P3        | work-plan      | `Q2iWEWV1` | `PLN-3`      |
| R1        | release        | `W5DWIa3V` | `REL-1`      |
| R2        | release        | `ooMMPi1k` | `REL-2`      |
