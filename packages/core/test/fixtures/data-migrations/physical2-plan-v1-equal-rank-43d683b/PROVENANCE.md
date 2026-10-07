# physical2-plan-v1-equal-rank-43d683b

Замороженная база Relay, созданная реальными операциями CLI/Core коммита
`43d683be11cda57f8861468c20ae14b18cc9e419` (2026-09-24, «feat: планы и релизы (часть 1)»).
Первый содержащий тег: `v0.6.1`. Номер релиза не приписывается коммиту без тега.

## Формат

Как physical2-plan-v1-43d683b (формат 2, отдельные plan-stage), минимальный состав: 1 план active, 3 этапа с задачами.

Маркер: `{"format":"relay-entities","schemaVersion":2,"productId":"KaYK2iaG"}`.
Виды версии (`entities types` той же версии): `work-plan`, `plan-stage`, `release`, `project`, `product`, `feature`, `scenario`, `application`, `implementation`, `board`, `task`, `document`.

## Охват

Проверка tie-break порядка этапов при равном `rank`.

Отсутствующее в версии: Операции 43d683b не создают равные rank (create: последний+1; move перенумеровывает 0..n-1), поэтому это производная фикстура.

## Особенности

**Ручная правка:** после генерации реальными командами у всех трёх `entities/plan-stages/*.json` `data.rank` заменён на 5 (ревизии, даты, авторы не менялись), затем выполнен `storage reindex` той же версии; порядок подтверждён старым reader `plan stages` (oracle `oldReaderOrderAfter`). Правило старого reader: `a.rank - b.rank || a.id.localeCompare(b.id)` (`application/planning/model.ts@43d683b`). ID подобраны так, что `localeCompare` (`fAVWvbdH, FhpruDYL, Z261Bz7a`) отличается от порядка code point (`FhpruDYL, Z261Bz7a, fAVWvbdH`) и от порядка создания.

## Файлы

- `base.json.gz` — побайтный снимок дерева проекта (каталог с `.relay/`): 52 файлов,
  128 каталогов, 121673 байт; sha256 архива `d16fd27a69c1639c16368e0702e4a2b4fc763eb38d2f886cf99d83382ecf2e77`.
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
WORKTREE=<wt> node generators/generate-equal-rank.mjs <relay-bin> <db>/relay-fixture <out>/oracle.json
node generators/pack-tree.mjs <db>/relay-fixture base.json.gz stats.json
```

`<relay-bin>` — обёртка по образцу `generators/relay-bin.sh.example`; автор по умолчанию `fixture-author`,
Node v24.3.0. Повторная генерация даёт другие ID и даты: фикстуру не перегенерируют,
тесты генератор не исполняют.

## Коллекции записей

| Коллекция     | Записей | Надгробий | schemaVersion | dataVersion |
| ------------- | ------- | --------- | ------------- | ----------- |
| `boards`      | 2       | 0         | 1             | 1           |
| `plan-stages` | 3       | 0         | 1             | 1           |
| `products`    | 1       | 0         | 1             | 1           |
| `projects`    | 1       | 0         | 1             | 1           |
| `tasks`       | 4       | 0         | 1             | 1           |
| `work-plans`  | 1       | 0         | 1             | 1           |

## Ключевые сущности oracle

| Псевдоним       | Вид | ID  | Ключ |
| --------------- | --- | --- | ---- |
| см. oracle.json |     |     |      |
