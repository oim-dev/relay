# physical3-3875aee

Замороженная база Relay, созданная реальными операциями CLI/Core коммита
`3875aee1f873d591330a5ebc2749d05acb1a3c10` (2026-09-26, «refactor: удалить общий аудит и перейти на встроенное хранение v3»).
Первый содержащий тег: `v0.7.0`. Номер релиза не приписывается коммиту без тега.

## Формат

Формат 3, оболочка `schemaVersion = 2`: `receipts[]` в каждой записи, `planningEvents` у планов/релизов, `comments`/`commentSequence` у задач, без `history/`/`operations/`. Единственный коммит, который пишет формат 3 (bebaa32 уже пишет 4); в релизы не попал (теги начинаются с v0.7.0 = формат 4).

Маркер: `{"format":"relay-entities","schemaVersion":3,"productId":"X0Av3YgF"}`.
Виды версии (`entities types` той же версии): `work-plan`, `release`, `project`, `product`, `feature`, `scenario`, `application`, `implementation`, `board`, `task`, `document`.

## Охват

Как physical2-v0.6.1.

Отсутствующее в версии: Нет plan-stage/release-snapshot*.

## Особенности

Базовый перенос на 4321233 успешен (35 сущностей).

## Файлы

- `base.json.gz` — побайтный снимок дерева проекта (каталог с `.relay/`): 111 файлов,
  230 каталогов, 681302 байт; sha256 архива `adf9644458e324810d05648504cb5981048222cf8175039a0affbf0aacc6ee38`.
  Разворачивается `../restore-tree.mjs`. Каталогом в Git хранить нельзя: `.gitignore` со строкой `*`
  внутри `.relay/runtime`, `.relay/transactions`, `.relay/.indexes` скрыл бы файлы, пустые каталоги теряются.
- `oracle.json` — независимый oracle: входные значения генератора (тексты, ключи, ID из ответов
  старого CLI, ожидаемые связи, удаления, алиасы), без чтения результата мигратора.
- `steps.jsonl` — журнал шагов генерации (аргументы, длинные тексты заменены длиной).
- `provenance.json` — SHA, генератор, состав коллекций, версии оболочек и данных.

## Генерация

```sh
git worktree add --detach <wt> 3875aee && (cd <wt> && pnpm install --frozen-lockfile)
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
| `applications`    | 2       | 0         | 2             | 1           |
| `boards`          | 4       | 0         | 2             | 1           |
| `documents`       | 4       | 1         | 2             | 1           |
| `features`        | 3       | 1         | 2             | 1           |
| `implementations` | 3       | 0         | 2             | 1           |
| `products`        | 1       | 0         | 2             | 1           |
| `projects`        | 1       | 0         | 2             | 1           |
| `releases`        | 2       | 0         | 2             | 2           |
| `scenarios`       | 3       | 0         | 2             | 1           |
| `scopes`          | 2       | 0         | 2             | 1           |
| `tasks`           | 7       | 1         | 2             | 1           |
| `work-plans`      | 3       | 0         | 2             | 2           |

## Ключевые сущности oracle

| Псевдоним | Вид            | ID         | Ключ         |
| --------- | -------------- | ---------- | ------------ |
| project   | project        | `X0Av3YgF` | ``           |
| passport  | product        | `passport` | `PRODUCT`    |
| F1        | feature        | `2ZfL8KyD` | `FEATURE-1`  |
| F2        | feature        | `G2JmBJV0` | `FEATURE-UX` |
| F3        | feature        | `8WZWSTMg` | `FEATURE-3`  |
| S1        | scenario       | `GkLo4B8o` | `SCENARIO-1` |
| S2        | scenario       | `X8VNvhPU` | `SCENARIO-2` |
| S3        | scenario       | `GF3BMZZC` | `SCENARIO-3` |
| A1        | application    | `rCCBhIWS` | `WEB`        |
| A2        | application    | `FG9UTlZB` | `API`        |
| FI1       | implementation | `N2fDcHd7` | `WEB-FI-1`   |
| SI1       | implementation | `uZV5i4iz` | `WEB-SI-1`   |
| FI2       | implementation | `czvhada3` | `API-FI-1`   |
| T7        | task           | `XEqJaxjx` | `PRODUCT-2`  |
| T1        | task           | `TWteHmrB` | `WEB-1`      |
| T2        | task           | `Y9BV3V3U` | `WEB-2`      |
| T3        | task           | `bkMBuO7u` | `API-1`      |
| T4        | task           | `utSYJbj6` | `WEB-3`      |
| T5        | task           | `pcQuSQNh` | `PRODUCT-1`  |
| T6        | task           | `OGpcn9sH` | `API-2`      |
| D1        | document       | `qeeMBGXf` | `DOC-1`      |
| D2        | document       | `o4GVCNGi` | `DOC-2`      |
| D3        | document       | `H5ZQeYLo` | `DOC-3`      |
| D4        | document       | `rHrXRmjq` | `DOC-4`      |
| P1        | work-plan      | `tDJyV0TI` | `PLN-1`      |
| P2        | work-plan      | `m6FZ5yIV` | `PLN-2`      |
| P3        | work-plan      | `w8NOCHOn` | `PLN-3`      |
| R1        | release        | `ZdQE7eUR` | `REL-1`      |
| R2        | release        | `wbXzQk9w` | `REL-2`      |
