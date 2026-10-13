# legacy-c1c353f

Замороженная база Relay, созданная реальными операциями CLI/Core коммита
`c1c353f102d0ffa65681439da8286a58f3c647fe` (2026-09-20, «refactor: удалить легаси разделов проекта»).
Первый содержащий тег: `v0.6.1`. Номер релиза не приписывается коммиту без тега.

## Формат

Legacy-раскладка до единого хранения: `config.json`, `product/` (passport.json, features/, scenarios/, applications/<id>/…, documents/), `boards/<slug>/board.json` и `boards/<slug>/tasks/*.json` (`version: 3`, без `acceptanceCriteria`), граф v2 в `relations/` (current/history/requests/meta.json). Нет `storage.json`.

Маркер: отсутствует (legacy).
Виды версии (`entities types` той же версии): `project`, `product`, `feature`, `scenario`, `application`, `implementation`, `board`, `task`, `document`.

## Охват

project (без documentSections), паспорт, фичи (одна переименована → алиас), сценарии, 2 приложения с досками и scope, реализации FI/SI, неактивная реализация (scope replace []), задачи (зависимость, related, перенос на другую доску → алиас ключа), документы со старым полем `links` (без relations/разделов/состояния), диагностические связи графа active и revoked.

Отсутствующее в версии: В этой версии ещё нет: критериев приёмки (a89d923), подзадач `parentId` при создании (a8aa457), комментариев и task-activity (927e945), удаления сущностей и надгробий (6e141e1), document relations/sections/status/pinned (5c7265b), планов и релизов (43d683b). Доказательство — `provenance.json.entityKindsOfVersion` из `entities types` той версии и даты коммитов в `git log --first-parent`.

## Особенности

Пустые каталоги (`tasks/`, `boards/*/tasks`) сохранены записями `dir`. Базовый перенос на 4321233 (`storage migrate`) успешен (28 сущностей) — это наблюдение, не oracle.

## Файлы

- `base.json.gz` — побайтный снимок дерева проекта (каталог с `.relay/`): 44 файлов,
  42 каталогов, 33854 байт; sha256 архива `3b446c36106bcd9dbe88f0437cc98c0e48cf97d5eca71d3c4e0aa89ca6925870`.
  Разворачивается `../restore-tree.mjs`. Каталогом в Git хранить нельзя: `.gitignore` со строкой `*`
  внутри `.relay/runtime`, `.relay/transactions`, `.relay/.indexes` скрыл бы файлы, пустые каталоги теряются.
- `oracle.json` — независимый oracle: входные значения генератора (тексты, ключи, ID из ответов
  старого CLI, ожидаемые связи, удаления, алиасы), без чтения результата мигратора.
- `steps.jsonl` — журнал шагов генерации (аргументы, длинные тексты заменены длиной).
- `provenance.json` — SHA, генератор, состав коллекций, версии оболочек и данных.

## Генерация

```sh
git worktree add --detach <wt> c1c353f && (cd <wt> && pnpm install --frozen-lockfile)
cp generators/fixture-delete.mts <wt>/apps/cli/
WORKTREE=<wt> node generators/generate-unified.mjs <relay-bin> <db>/relay-fixture <out>/oracle.json <wt> legacy-early
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
| project   | project        | `tYqE8JTY` | ``           |
| passport  | product        | `passport` | `PRODUCT`    |
| F1        | feature        | `CKfHYrux` | `FEATURE-1`  |
| F2        | feature        | `07sAAWTe` | `FEATURE-UX` |
| F3        | feature        | `nGT0nyZ6` | `FEATURE-3`  |
| S1        | scenario       | `WVVHuoER` | `SCENARIO-1` |
| S2        | scenario       | `J699j0KP` | `SCENARIO-2` |
| S3        | scenario       | `iDKajobS` | `SCENARIO-3` |
| A1        | application    | `jBVuk2QQ` | `WEB`        |
| A2        | application    | `cMy0mIcN` | `API`        |
| FI1       | implementation | `J02SWrYi` | `WEB-FI-1`   |
| SI1       | implementation | `nYfLqPjh` | `WEB-SI-1`   |
| FI2       | implementation | `1KJJ9kEd` | `API-FI-1`   |
| T7        | task           | `BdRlRKRD` | `PRODUCT-2`  |
| T1        | task           | `IpHEq2yg` | `WEB-1`      |
| T2        | task           | `fk1AulMd` | `WEB-2`      |
| T3        | task           | `4FnF2coG` | `API-1`      |
| T4        | task           | `75oH2TXt` | `WEB-3`      |
| T5        | task           | `yjLgOooV` | `PRODUCT-1`  |
| T6        | task           | `b0lSMCK0` | `API-2`      |
| D1        | document       | `FzPipwPt` | `DOC-1`      |
| D2        | document       | `7k3zMZAq` | `DOC-2`      |
