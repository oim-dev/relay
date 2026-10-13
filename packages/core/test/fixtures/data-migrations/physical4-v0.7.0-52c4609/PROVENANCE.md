# physical4-v0.7.0-52c4609

Замороженная база Relay, созданная реальными операциями CLI/Core коммита
`52c46098fc7035937f7247be3a08eefc3c83b59e` (2026-09-27, «Merge pull request #3 from oim-dev/release/0.7.0», тег `v0.7.0`).
Первый содержащий тег: `v0.7.0`. Номер релиза не приписывается коммиту без тега.

## Формат

Формат 4, оболочка 3 — текущий физический формат; коммит тега v0.7.0.

Маркер: `{"format":"relay-entities","schemaVersion":4,"productId":"dcgT1V1G"}`.
Виды версии (`entities types` той же версии): `work-plan`, `release`, `project`, `product`, `feature`, `scenario`, `application`, `implementation`, `board`, `task`, `document`.

## Охват

Как physical2-v0.6.1; база старой версии приложения без изменений дисковых схем до HEAD (см. HISTORY-VARIANTS.md).

Отсутствующее в версии: —

## Особенности

Базовый `storage migrate` на 4321233 возвращает `migrated: false`. Используется как исторический вход для no-op/формата 4 (A02/A05-контроль), а не как старый dataVersion: реальной базы формата 4 со старым dataVersion в истории нет.

## Файлы

- `base.json.gz` — побайтный снимок дерева проекта (каталог с `.relay/`): 107 файлов,
  218 каталогов, 545699 байт; sha256 архива `ecc39bfa40d89fa863db8f53051f371ae85b09b367bf8f03856dabc238dd8e4f`.
  Разворачивается `../restore-tree.mjs`. Каталогом в Git хранить нельзя: `.gitignore` со строкой `*`
  внутри `.relay/runtime`, `.relay/transactions`, `.relay/.indexes` скрыл бы файлы, пустые каталоги теряются.
- `oracle.json` — независимый oracle: входные значения генератора (тексты, ключи, ID из ответов
  старого CLI, ожидаемые связи, удаления, алиасы), без чтения результата мигратора.
- `steps.jsonl` — журнал шагов генерации (аргументы, длинные тексты заменены длиной).
- `provenance.json` — SHA, генератор, состав коллекций, версии оболочек и данных.

## Генерация

```sh
git worktree add --detach <wt> 52c4609 && (cd <wt> && pnpm install --frozen-lockfile)
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
| `applications`    | 2       | 0         | 3             | 1           |
| `boards`          | 4       | 0         | 3             | 1           |
| `documents`       | 4       | 1         | 3             | 1           |
| `features`        | 3       | 1         | 3             | 1           |
| `implementations` | 3       | 0         | 3             | 1           |
| `products`        | 1       | 0         | 3             | 1           |
| `projects`        | 1       | 0         | 3             | 1           |
| `releases`        | 2       | 0         | 3             | 2           |
| `scenarios`       | 3       | 0         | 3             | 1           |
| `scopes`          | 2       | 0         | 3             | 1           |
| `tasks`           | 7       | 1         | 3             | 1           |
| `work-plans`      | 3       | 0         | 3             | 2           |

## Ключевые сущности oracle

| Псевдоним | Вид            | ID         | Ключ         |
| --------- | -------------- | ---------- | ------------ |
| project   | project        | `dcgT1V1G` | ``           |
| passport  | product        | `passport` | `PRODUCT`    |
| F1        | feature        | `UPT2mb0b` | `FEATURE-1`  |
| F2        | feature        | `Fsx1e2t4` | `FEATURE-UX` |
| F3        | feature        | `FI66u5qv` | `FEATURE-3`  |
| S1        | scenario       | `cx9NSaaq` | `SCENARIO-1` |
| S2        | scenario       | `BHwMsQKH` | `SCENARIO-2` |
| S3        | scenario       | `n663tbbM` | `SCENARIO-3` |
| A1        | application    | `8hkRD7Af` | `WEB`        |
| A2        | application    | `mLcXWhjK` | `API`        |
| FI1       | implementation | `pDhnXY7Q` | `WEB-FI-1`   |
| SI1       | implementation | `Q13TLikI` | `WEB-SI-1`   |
| FI2       | implementation | `Pyzp1KmZ` | `API-FI-1`   |
| T7        | task           | `eF4XoKGT` | `PRODUCT-2`  |
| T1        | task           | `qMAuLXyt` | `WEB-1`      |
| T2        | task           | `xSr7h5k3` | `WEB-2`      |
| T3        | task           | `w9Zk7EiZ` | `API-1`      |
| T4        | task           | `xcm2I4V1` | `WEB-3`      |
| T5        | task           | `RYu248IB` | `PRODUCT-1`  |
| T6        | task           | `ApFmBhWr` | `API-2`      |
| D1        | document       | `vqSqvP0v` | `DOC-1`      |
| D2        | document       | `mRMJWHO5` | `DOC-2`      |
| D3        | document       | `clUmCkYP` | `DOC-3`      |
| D4        | document       | `BCbrVeLO` | `DOC-4`      |
| P1        | work-plan      | `v0OoGqrW` | `PLN-1`      |
| P2        | work-plan      | `kCG6gly0` | `PLN-2`      |
| P3        | work-plan      | `7SuPqR8b` | `PLN-3`      |
| R1        | release        | `7exSGxCi` | `REL-1`      |
| R2        | release        | `gpuKOEaA` | `REL-2`      |
