# Предметный прогресс

Прогресс вычисляется при чтении из согласованных данных выбранного проекта. Он не меняет
колонки, критерии, историю или связи. Поддержаны задача, реализация, сценарий, фича,
приложение, продукт, план работ и релиз.

`work-plan` возвращает состояние, этапы, задачи, полные счётчики, `canStart/canComplete`
и `diverged`. `release` возвращает актуальные планы и их готовность даже после выпуска.
Факт выпуска задаётся статусом, датой и автором релиза. У задачи `planning` содержит
текущее участие либо null. Предметные команды проверяют те же правила под блокировкой.
CLI: `progress work-plan <ref>`, `progress release <ref>`; MCP: `work_plan_progress`,
`release_progress`. Параметры страниц общие с остальными прогрессами.

## Выполнение и состав

Задача выполнена, только если её колонка `done`, критерии отмечены и фактически выполнены
все прямые подзадачи и зависимости. Правило применяется до конца цепочки, включая
инфраструктурные доски. `canComplete` проверяет обязательства без требования своей колонки.
Повторное открытие зависимости снимает фактическое выполнение, но не перемещает зависимые
карточки. Отмена не является выполнением.

SI учитывает прямые задачи, FI — свои задачи и активные SI той же фичи/приложения.
Сценарий учитывает активные реализации и прямые задачи, фича — свои проектные сценарии,
активные FI и прямые задачи. Приложение агрегирует активные реализации, продукт — фичи.
Пустой обязательный состав не готов; снятые реализации не входят в активный каскад.
Адресный ответ снятой реализации имеет `active=false`, `completed=false`, причину `INACTIVE`.

`counts` — уникальные задачи собственного полного состава. Внешняя зависимость влияет
на выполнение, но сама не становится собственной задачей каждой цели. Общие задачи
не суммируются повторно при нескольких путях. У приложения `businessTasks` считает задачи
его досок с продуктовыми целями, `allTasks` — все задачи его досок. Счётчики не доказывают
готовность пустых соседних реализаций или фактическую поставку.

## REST

Local: `GET /api/v1/progress/<вид>`; workspace:
`GET /api/v1/projects/<проект>/progress/<вид>`. Выбор проекта соответствует остальным API.

| Вид              | Ответ                    | Составляющие                                                                    |
| ---------------- | ------------------------ | ------------------------------------------------------------------------------- |
| `task`           | `TaskProgress`           | column, canComplete, acceptance, criteria, children, dependencies               |
| `implementation` | `ImplementationProgress` | implementationKind (FI/SI), active, application, target, tasks, implementations |
| `scenario`       | `ScenarioProgress`       | tasks, implementations                                                          |
| `feature`        | `FeatureProgress`        | tasks, scenarios, implementations                                               |
| `application`    | `ApplicationProgress`    | implementations, businessTasks, allTasks                                        |
| `product`        | `ProductProgress`        | features                                                                        |
| `work-plan`      | `WorkPlanProgress`       | status, stages, tasks, canStart, canComplete, diverged                          |
| `release`        | `ReleaseProgress`        | status, plans, readiness                                                        |

Все ответы содержат `kind`, `entity` (kind/id/key/title), `completed`, `version`, `reasons`.
Все, кроме задачи и релиза, содержат `counts`; релиз считает планы через `readiness`.
Для всех, кроме продукта, требуется query `ref` —
ключ, ID либо `kind:ID`. Продукт выбирается областью проекта и не принимает `ref`.
Используется обычный конверт `{ok:true,data}`. Схемы находятся в OpenAPI и
`packages/contracts/src/progress.ts`.

## Страницы и ошибки

`offset` — 0 по умолчанию, `limit` — 20, максимум 100. Одна позиция применяется к каждому
списку ответа; каждый содержит `items`, полный `total`, собственный `nextOffset` или null.
Итоговые счётчики и готовность всегда полные.
Списки строятся в стабильном порядке ID исходных записей; критерии, зависимости и состав
реализаций сохраняют свой предметный порядок. Причины идут от условий сущности к составляющим.
Для следующей страницы передайте `version`
первой страницы, тот же вид, сущность и limit. Версия привязана к проекту и всему снимку.
При изменении данных или области — `PROGRESS_CHANGED` (HTTP 409), чтение начать заново.
Продолжение без версии — `INVALID_ARGUMENT` (400). Снимок текущего прогресса не хранится;
готовность выпущенного релиза также вычисляется из актуальных планов.

Причина содержит `code`, русское `message`, адрес `source`, при необходимости `criterionId`.
Коды: `NOT_DONE`, `CRITERION_INCOMPLETE`, `CHILD_INCOMPLETE`, `DEPENDENCY_INCOMPLETE`,
`COMPONENT_INCOMPLETE`, `NO_WORK`, `INACTIVE`. Раскрывайте прогресс источника отдельным
запросом. Полные Markdown читаются штатными операциями сущности/критерия.
Планирование добавляет `PLAN_NOT_COMPLETED`, `PLAN_CANCELLED`, `STATE_DIVERGED`,
`MISSING_PLAN`; они различают состояние, актуальную готовность и недоступный состав.

Неизвестный адрес — `ENTITY_NOT_FOUND` (404), неверный вид — `ENTITY_KIND_MISMATCH` (409),
неоднозначный ключ — `AMBIGUOUS_ENTITY_REFERENCE` (409). Потерянная обязательная ссылка —
`INVALID_REFERENCE`, цикл завершения — `DEPENDENCY_CYCLE` с адресами (409).
Прежние карточки/каталоги остаются доступны для ремонта старого цикла и не считают его выполненным.

## CLI и MCP

CLI: `relay-cli progress task <ref>`, аналогично `implementation`, `scenario`, `feature`,
`application`; для продукта — `relay-cli progress product`. Параметры:
`--offset`, `--limit`, `--snapshot-version`; последний передаёт version снимка, а глобальный
`--version` показывает версию CLI. Общие параметры выбора проекта и `--format json` сохранены.
Человеческий вывод показывает итоги, причины, таблицы и команды продолжения.

MCP: `task_progress`, `implementation_progress`, `scenario_progress`, `feature_progress`,
`application_progress`, `product_progress`. Параметры `ref` (кроме продукта),
`offset/limit/version`, общие `project/maxBytes`. Все операции только читают.

```bash
relay-cli progress product --format json
relay-cli progress feature FEATURE-1
relay-cli progress task API-1 --limit 20
```

См. [продуктовый контракт](PRODUCT.md) и [канбан](KANBAN.md).
