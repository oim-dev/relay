# Исторические варианты дисковых данных

Сведения для readers и переходов миграции. Источник — `git log -p` по
`packages/contracts/src`, `packages/core/src/storage` (кодеки, registry, relations,
unified-adapter) в диапазоне `90d7b26..4321233`, включая коммиты слитых веток 3875aee и bebaa32.
Каждый вывод сверен с диффом, а для 43d683b дополнительно с фикстурой
`physical2-plan-v1-43d683b`. Это исследовательская запись к фикстурам. Каноническим
контрактом хранения она не является: действующие правила — в
[STORAGE](../../../../../docs/domain/STORAGE.md) и [FORMAT](../../../docs/FORMAT.md).

## Как декодируются записи

- `data` каждого вида проверяется строгой схемой `z.strictObject(...)`. Лишнее поле — ошибка.
  Вложенные схемы тоже строгие: relations документа, критерии, этапы, scope плана.
- Оболочки записи, надгробия, keyspace и файлов отношений строгие. `validate()` требует
  точного совпадения `dataVersion` с кодеком и литерала `schemaVersion`.
- Markdown хранится массивом строк, разбитым по `\n`; `\r` остаётся в конце строки.
  Алгоритм кодека за весь диапазон не менялся.

## A. Изменения без повышения `dataVersion` / `schemaVersion`

| #   | SHA     | Где                                                             | Отличие                                                                                                                                                                                                             | Признак старого варианта                                                                                                                       |
| --- | ------- | --------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------- |
| A1  | 43d683b | document `data.relations[*].target.kind`                        | В enum добавлены `work-plan`, `plan-stage`, `release`                                                                                                                                                               | Однозначного признака нет: старые записи — подмножество новых                                                                                  |
| A2  | 1afe138 | document `data.relations[*].target.kind`                        | Из строгого enum удалён `plan-stage`. Такой документ текущей схемой не декодируется                                                                                                                                 | Однозначный: `target.kind === "plan-stage"`. В фикстуре 43d683b это DOC-2                                                                      |
| A3  | 1afe138 | виды `plan-stage`, `release-snapshot`, `release-snapshot-entry` | Сняты с регистрации без перехода                                                                                                                                                                                    | Каталоги `entities/plan-stages`, `entities/release-snapshots`, `entities/release-snapshot-entries`. Текущий перенос даёт `UNKNOWN_ENTITY_KIND` |
| A4  | 1afe138 | keyspace                                                        | Схема та же, но может остаться `keyspaces/global-plan-stage.json` с `entityKind: "plan-stage"` (префикс STG)                                                                                                        | `entityKind === "plan-stage"`                                                                                                                  |
| A5  | 1afe138 | файлы отношений, слот `planning-membership`                     | Было `task → plan-stage` (`part-of`) у владельца `plan-stage` в `relations/plan-stages/<id>.json`. Стало `task → work-plan` у владельца `work-plan`. Версия файла отношений осталась 1                              | Каталог `relations/plan-stages/`, рёбра с концом `plan-stage`. Отсутствие membership у плана не признак: план мог быть пуст                    |
| A6  | 43d683b | состав управляемых рёбер                                        | Добавлены синхронизируемые рёбра: `product:passport → project` (`product-links`), `feature → passport` (`feature-links`), `part-of` сценарной реализации к реализации фичи, `planning-scope`, `release-composition` | Неоднозначно: это отсутствие рёбер до пересинхронизации, формат файла тот же                                                                   |
| A7  | 3875aee | производный индекс отношений                                    | В индексную запись добавлено поле `hash`                                                                                                                                                                            | Не каноничные данные: перестраивается reindex                                                                                                  |

Не менялись по существу (только форматирование или `describe`): project `{name, slug, documentSections?}`,
product/passport, feature, scenario, application, implementation, board, task и `acceptanceCriteria`,
scope `{applicationId, implementations}`, tombstone `deleted`, keyspace, stored edge и файлы
отношений inline/segments `schemaVersion: 1`. После bebaa32 до HEAD дисковые схемы,
кодеки, registry и relations не менялись. Поэтому фикстура v0.7.0 (52c4609) по содержимому
совпадает с текущим форматом.

Только DTO, не диск: `progress.ts`; схемы обзора (05604ca, e18d06d); `events` и `requests`
DTO legacy-адаптера; `entityEventSchema`, `graphHistory*`, `entitySummarySchema`; правки
`describe` у `requestId`.

## B. Изменения с повышением версии

| SHA     | Уровень                                     | Изменение                                                                                                                                            |
| ------- | ------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------- |
| 90d7b26 | manifest 1, оболочка 1, все `dataVersion` 1 | Исходный единый формат, служебные `operations/*.json`                                                                                                |
| 68124da | manifest 1→2                                | Сегменты `history/<stream>/*.json` вместо `operations/`; в событиях задач `contentOmitted: true`. Записи сущностей не менялись                       |
| 43d683b | новые виды, `dataVersion` 1                 | `work-plan`, `plan-stage`, `release` (`snapshotId`), `release-snapshot`, `release-snapshot-entry`                                                    |
| 1afe138 | work-plan/release `dataVersion` 1→2         | У плана `stages[]` `{id, title, summary, outcome[], completionConditions[], taskIds}`; у релиза удалён `snapshotId`. Шаг перехода не зарегистрирован |
| 3875aee | manifest 2→3, оболочка 1→2                  | `receipts[]`, `reservedKeys?`, `comments?`, `commentSequence?`, `planningEvents?` (последнее только у work-plan/release). История и аудит удалены    |
| bebaa32 | manifest 3→4, оболочка 2→3                  | Удалены `receipts`, `planningEvents`                                                                                                                 |

Legacy до 90d7b26 (раскладка `product/`, `boards/`) версионирует записи собственным полем
`version`. В фикстурах: задачи `version: 3` в c1c353f (без `acceptanceCriteria`) и
`version: 5` в 5c7265b. Записи продукта — `version: 3`; документы — `version: 3` в c1c353f
(со старым `links`) и `version: 4` в 5c7265b (relations, разделы, состояние). В 5c7265b есть
ещё 2 файла `version: 1` в `product/.document-links` (привязки отношений документов).

## O3. Одна задача в двух этапах одного плана (43d683b)

Сервис 43d683b такое не допускал.

- `readPlanningState` (`application/planning/model.ts`) для любого статуса плана бросает
  `DUPLICATE_VALUE`, если `task:<id>` повторяется в этапах одного плана.
- Для планов `draft`/`active` действует ещё одно правило: задача входит не более чем
  в один текущий план (`TASK_IN_PLAN`).
- `include` отклоняет задачу, уже включённую в текущий план, и предлагает явный `transfer`.
- Повтор внутри одного изменения состава отклоняется.

При этом задача может состоять в закрытом плане и одновременно в одном активном. В фикстуре
WEB-1 входит в PLN-1 (completed) и PLN-2 (active). Сочетание «дубликат в одном плане» корректная
база этой версии содержать не могла. Если оно встретилось, это повреждение, а не вариант.

## Порядок этапов (43d683b)

Сортировка `a.rank - b.rank || a.id.localeCompare(b.id)` встречается в `model.ts` и в
`service.ts`. Операции этой версии равных rank не создают:

- `create` присваивает последний rank + 1;
- `remove` оставляет разрыв;
- `move` перенумеровывает этапы в 0..n-1.

`localeCompare` зависит от ICU и не совпадает с порядком code point. В фикстуре
`physical2-plan-v1-equal-rank-43d683b` старый reader дал `fAVWvbdH, FhpruDYL, Z261Bz7a`,
а сортировка по code point — `FhpruDYL, Z261Bz7a, fAVWvbdH`.

## R2. Снимок выпуска v1 (43d683b)

- `release-snapshot.data`: `releaseId`, `capturedAt`, `capturedBy`, `entryIds[] (≤10000)`,
  `planEntryIds[] (≤200)`, `readiness {total, ready, missing, percent, canRelease}`. Ключа нет:
  `key: null`, запись техническая.
- `release-snapshot-entry.data`: `snapshotId`, `item {kind, id, key, revision, title, reason,
content}`, необязательный `plan` (сводка плана, `planSummarySchema`).

`content` — Markdown, сгенерированный кодом выпуска (`application/releases/snapshot.ts`
`entityContent`). Он рендерит заголовок, ключ, адрес, ревизию, состояние, краткое описание,
описание или тело документа, публикацию, прикрепления. Для задачи добавляются колонка, доска,
родитель, зависимости, цели, автор и даты, а также критерии с текстами и отметками выполнения.
`reason` — фиксированная фраза основания включения.

**Прямого авторского ввода в снимке нет:** пользователь не вводит ни одного поля только для
снимка. Но снимок хранит копию текстов на момент выпуска. Если сущность изменили или удалили
после выпуска, это единственный экземпляр прежнего текста. В фикстуре 43d683b тело DOC-4
изменено после выпуска REL-1, и прежнее тело сохранилось только в `release-snapshot-entries`.
Значит, снимок производный по происхождению, но не восстановим из текущих сущностей.
Удалять его как «доказанно производный» нельзя без решения по контракту.

## Источники, которые не воспроизведены

- Legacy `relations.json` (единый граф): его читает `graph.ts` (`legacyPath`), а начиная
  с f21bf71 есть `graph migrate`. Но ни один коммит истории этот файл не пишет: до f21bf71 графа
  нет, с f21bf71 граф пишется в раздельный v2. Воспроизвести его реальным кодом нельзя.
  Альтернатива — синтетическая фикстура по замороженной схеме `readLegacyGraph`, явно
  помеченная как синтетическая.
- Legacy до c1c353f (a0db8bb..3827e1c) использует другой CLI без `entities`, отдельные
  `tasks/` и другую раскладку продукта. Текущие readers (`ProductRepository`,
  `BoardTaskRepository`) рассчитаны на раскладку с `product/` и `boards/`. Поддерживается ли
  этот вариант, не объявлено. Фикстура не создавалась, нужно решение о минимальной
  поддерживаемой версии.
- Формат 4 со старым `dataVersion`: в истории его нет, планы v2 появились раньше формата 4.
  Такой сценарий проверяется синтетическим тестовым профилем, а не исторической фикстурой.

## Неопределённости

- A6 зависит от правил синхронизации рёбер при чтении и reindex. Пересинхронизация старых
  наборов не проверялась.
- Поля с `.default(...)`, например `productLinks`, на диске могут отсутствовать. Это свойство
  исходного формата, а не изменение в диапазоне.
