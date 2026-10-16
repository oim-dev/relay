# Схемы и типы Contracts

Эта страница объясняет применение и развитие переносимой модели, а не маршруты REST.
Транспортный контракт находится у [Server runtime](../../server-runtime/docs/API.md),
поведение — в [предметной модели](../../../docs/domain/README.md).
Точка входа пакета и команды сборки — в [README](../README.md).

## Карта публичных модулей

`package.json` экспортирует корень `@relay/contracts` и wildcard `@relay/contracts/*`.
Условие `tasks-source` выбирает `src`, обычный runtime — `dist`, типы — `dist/*.d.ts`.
Не импортируйте из чужого `src` и не считайте корневой модуль экспортом всех схем.

| Импорт                                   | Назначение                                                                                                          |
| ---------------------------------------- | ------------------------------------------------------------------------------------------------------------------- |
| `@relay/contracts`                       | `src/index.ts`: общие DTO, контекст проекта/сервера, `ApiResponse`, `PageMeta`, `ServerEvent`, константы API        |
| `@relay/contracts/primitives`            | Текст, автор, timestamp, ключ, внешний адрес, correlation `requestId`                                               |
| `@relay/contracts/entities`              | Реестр основных видов, данные, карточки, фильтры, схемы общих действий и удаления                                   |
| `@relay/contracts/entities/*`            | Предметные схемы продукта, досок, задач, документов, графа и настроек                                               |
| `@relay/contracts/document-library`      | Страницы прикреплений и разделов библиотеки, точечные изменения под ревизией владельца                              |
| `@relay/contracts/planning`              | Планы, вложенные этапы, запросы и результаты планирования                                                           |
| `@relay/contracts/releases`              | Релизы и их операции                                                                                                |
| `@relay/contracts/progress`              | Предметные показатели и выборки прогресса                                                                           |
| `@relay/contracts/product`               | Совместимые типы продуктовых представлений                                                                          |
| `@relay/contracts/product-query`         | Проверка продукта, адресуемые рекомендации lint и отдельная страница карты обзора                                   |
| `@relay/contracts/product-participation` | Компактный состав, атомарный выбор прежних и новых вкладов, полная реализация с savedStatus                         |
| `@relay/contracts/server-context`        | Runtime-схемы каталога Server и его успешного конверта                                                              |
| `@relay/contracts/storage`               | Переносимые оболочки хранения, ключевые пространства и карточки; не дисковый движок                                 |
| `@relay/contracts/storage-maintenance`   | Результаты `storage status`, `storage migrate --dry-run` и `storage migrate`, коды ошибок совместимости с exit code |

Список видов и поддерживаемых действий берите из `entityDefinitions` и связанных
схем, а не из фиксированного числа в README. Разрешённый схемой вид не означает,
что для него реализованы все общие действия или все интерфейсы Relay.

## Ввод и результат Zod

Тип входа — `z.input<typeof schema>`, тип после успешного `parse` —
`z.output<typeof schema>`; `z.infer` соответствует output.
Coercion и defaults делают эти типы различными:

```ts
import { z } from "zod";
import { entityPageQuerySchema } from "@relay/contracts/entities";

type PageInput = z.input<typeof entityPageQuerySchema>;
type ParsedPage = z.output<typeof entityPageQuerySchema>;

const input: PageInput = {};
const page: ParsedPage = entityPageQuerySchema.parse(input);
// page.offset === 0, page.limit === 40
```

Внешний query может требовать преобразования строки в число; внутреннему сервису после
`parse` нужен гарантированный числовой результат. Не объявляйте принимаемый ввод
через output только потому, что поля совпадают в простом примере.
JSON Schema результата и JSON Schema аргумента тоже различаются:
`EntityEngine.describe` использует `z.toJSONSchema(schema, { io: "input" })`
для create/update и обычное представление для данных.

Для частичного изменения отсутствие поля означает «не менять» только там, где это
предусмотрено схемой и сервисом. `optional`, `nullable`, пустая строка и пустой массив
не взаимозаменяемы. Например, нельзя автоматически заменить пропущенную цель на `null`
или пропущенный состав на `[]`: это может превратить чтение формы в удаление данных.
Defaults входа создания не следует механически копировать в patch-схему.
Строгие объекты отклоняют незнакомые поля, а не тихо принимают новую возможность.

## Описания и текст

`.describe()` объясняет по-русски назначение действия, параметра и вложенного поля:
смысл, единицу измерения, ограничения, значение отсутствия/очистки и способ адресации.
Описание должно работать в OpenAPI/MCP без чтения исходников. Оно не заменяет
`refine` или проверку Core: ограничение, написанное только в тексте, не валидируется.

`primitives.text` ограничивает UTF-8 в байтах через `TextEncoder` и отклоняет непарные
суррогаты. `singleLine` проверяет однострочность и обрезает края заголовков/метаданных.
Не переносите это преобразование на полный Markdown: его форматирование значимо.
Краткое описание — обычная строка, полное содержание — строка Markdown на внешней границе.
Массив строк появляется только в кодеке хранения Core.

`requestIdSchema` описывает корреляцию запроса и ответа. Нельзя документировать его
как ключ дедупликации или обещать сохранённый результат при повторе: вызов исполняется
заново. Тип квитанции в ответе не означает постоянное хранение квитанций.

## Три представления и граница транспорта

1. **Предметный ввод/результат** — переносимая форма действия и данных.
2. **HTTP DTO** — конверт и транспортное представление, принадлежащее Server runtime.
   Используйте общую предметную схему, не создавайте независимую копию того же поля.
3. **Дисковая запись** — оболочка, `dataVersion` и закодированное содержимое.
   Contracts описывает переносимую оболочку, Core определяет пути, кодеки,
   блокировки и миграцию. Подробности — в [формате Core](../../core/docs/FORMAT.md).

`src/index.ts` содержит также обычные TypeScript interfaces: их наличие не создаёт
runtime-валидатор. Там, где схема существует, выводите тип из неё.
Не возвращайте `StoredEntity.data` как публичный DTO: Markdown на диске имеет другую форму.

`server-context.ts` задаёт строгие runtime-схемы `relayProjectSchema`,
`serverContextSchema` и `serverContextResponseSchema` без coercion и defaults.
Проверяются `mode`, серверный `configPath`, `defaultProject` (строка либо null),
весь массив проектов и успешный конверт `ok: true`. Строка недоступной регистрации
не подтверждает её `id` как идентичность базы; отсутствие `slug` допустимо.

Серверные страницы и адресные квитанции — добавочные схемы того же модуля:

- `serverCapabilitiesSchema`: только `capabilities: string[]`; discovery не содержит
  каталога. `PROJECT_CATALOG_CAPABILITY` — `relay-project-catalog-v1`.
- `projectCatalogPageQuerySchema`: coercion числовых query offset/limit, defaults 0/20,
  limit 1–100, optional непустая version. Без version нет проверки исходного каталога.
- `projectCatalogPageSchema`: `catalog: ServerContext`, `total`, `nextOffset`, `version`.
  Projects внутри catalog — только страница; total относится ко всем регистрациям,
  включая недоступные. Guard охватывает весь каталог, не только выбранные строки.
- `projectRegistrationReceiptSchema`: `action: register`, `key`, серверный `configPath`
  и `entry` с path/config (хотя бы одно поле). Это сохранённое подключение, не данные
  проекта и не проверка доступности после записи.
- `projectUnregistrationReceiptSchema`: `action: unregister`, `key`, серверный
  `configPath`, `removed`; false означает уже отсутствующую регистрацию, не потерю базы.

Схемы ответов строгие, без coercion и defaults. Новый DTO не заменяет прежний
ServerContextResponse. Маршруты, capability и продолжение — в
[REST-контракте каталога](../../server-runtime/docs/API.md#серверные-страницы-и-адресные-квитанции).

Выходные схемы используются клиентами для строгой проверки ответа (HTTP-адаптер
project-runtime, Web). Новое обязательное поле результата поэтому несовместимо
со старым сервером: так, `productOverviewSchema` требует `snapshotVersion`, `generatedAt`
и `snapshot`. Такое изменение согласуется как выпуск клиента и Server одной версией;
потребитель, которому нужна прежняя форма, выбирает поля явно, как MCP `product_overview`.
То же относится к обязательному блоку `snapshot.operator`: старый строгий клиент отклоняет
ответ нового сервера, поэтому Server, CLI, MCP и Web обновляются одной версией.

Детализация метрик оператора описана в `entities/product.ts`: `productOverviewMetricSchema`
(перечень метрик), `productOverviewMetricPageQuerySchema` (query без метрики: `blocker`,
`limit`, `cursor`, `version`), `productOverviewMetricQuerySchema` (вход Core с `metric`) и
`productOverviewMetricPageSchema` — discriminated union по `metric`, где элементы каждой
метрики имеют ту же схему, что элементы соответствующей подборки `snapshot.operator`.
`blocker` у `blocker-affected` — адрес раскрытого блокера, у остальных метрик — `null`.
Схема не проверяет связь `blocker` с метрикой и действительность курсора: это делает Core
(`INVALID_ARGUMENT`, `UNKNOWN_METRIC`, `INVALID_CURSOR`, `VERSION_CONFLICT`, `NOT_FOUND`).
Отсутствующая задача-блокер возвращает `NOT_FOUND` (exit 3) с `details`
`{ parameter: "blocker", reference: "<переданный ID или ключ>" }`: по ним клиент отличает
её от других `NOT_FOUND` — неизвестного маршрута или ресурса. `ApiFailure.error.details`
остаётся `unknown` в общей схеме; форма гарантирована только для этого случая.

`ApiSuccess<T>` допускает необязательное `meta`, но это не универсальное правило страниц.
Общие сущности возвращают `offset`-продолжение через `nextOffset`/`version`, другие сценарии
имеют cursor/snapshot; продуктовые списки имеют собственные ограничения. Размещение
полей в HTTP, SSE и ошибки описывает только [REST-справочник](../../server-runtime/docs/API.md).

`documentRelationSchema.target.kind` допускает `plan-stage` только для чтения: это сохранённая
до миграции связь документа с прежним адресом этапа плана. Схема общая для ввода и результата,
поэтому тип ввода тоже содержит это значение, но новое прикрепление к этапу отклоняет Core,
а не схема. В `documentRelationChangeSchema` такой адрес допустим только для `detach`
существующей связи: Core снимает её по сохранённой цели, attach/update дают `ENTITY_RELOCATED`. Клиент
не переходит к такой цели как к сущности; чтобы назвать план-владельца, он может разрешить
адрес `plan-stage:<id>` и разобрать `details` ответа `ENTITY_RELOCATED` по
`entityRelocatedDetailsSchema`.

Целевая модель не становится доступным полем до реализации. В частности, текущий
релиз использует `planIds`, без `applicationId`; принятое расширение описано отдельно
в [предметных правилах](../../../docs/domain/RELEASES.md).

### Каталог документов

Поля материала (`documentFormat`, `url`, `tags`) входят в `documentMetadataShape`
модуля `entities/document-library.ts`; их предметный смысл описан в
[документах](../../../docs/domain/DOCUMENTS.md). Схемы проверяют форму: допустимые
значения формата, абсолютный `http`/`https` адрес до 2048 символов, однострочный тег
до 50 символов и не более 20 тегов. Сочетание формата с адресом и непустым Markdown,
нормализацию и дедупликацию тегов и переход к `markdown` без адреса выполняет Core.
В `entityCreateDataSchemas.document` поле `body` имеет default `""` (для ссылки),
в update default нет: отсутствие `body` сохраняет текущее содержание.
В схемах `documentFormat` и `tags` необязательны (ввод прежних клиентов), но в хранилище
документ `dataVersion` 2 (профиль 3) содержит их всегда: прежние записи получают `markdown`
и `[]` явной миграцией Core ([формат](../../core/docs/FORMAT.md#перенос-документа-v1)),
поэтому `data` прочитанного документа включает оба поля.

`entitiesQuerySchema` дополнен фильтрами `documentFormat`, `tags` (все выбранные, AND)
и `unattached`. Карточка `entitySummarySchema.document` всегда содержит `format` и `tags`,
`url` — только у ссылки; `linkCount` учитывает и `relations`, и совместимые `links`.
Обязательные `format` и `tags` делают ответ прежнего сервера невалидным для нового
строгого клиента: Server и клиенты обновляются одной версией.

Модуль `entities/document-catalog.ts` содержит операции каталога поверх реестра сущностей:

| Схема                                                      | Назначение                                                  |
| ---------------------------------------------------------- | ----------------------------------------------------------- |
| `documentFacetsQuerySchema` / `documentFacetsSchema`       | Счётчики по полным данным; область каждой оси в `.describe` |
| `documentBulkSchema` / `documentBulkResultSchema`          | Массовое действие с поэлементными ревизиями и статусами     |
| `documentRelationChangeSchema`                             | `attach`/`update`/`detach` одной связи документа            |
| `entityDocumentsQuerySchema` / `entityDocumentsPageSchema` | Прямые материалы сущности с источником связи                |

Схема не проверяет, что `nextType` передан только для `update`, а `description` —
не для `detach`: это делает Core (`INVALID_ARGUMENT`). Результат массового действия —
частичный по контракту; `failed` не включает `unchanged`. Методы Core — `EntityEngine`
`documentFacets`, `documentBulk`, `relateDocument`, `entityDocuments`; транспорт и
доступность в интерфейсах фиксируются отдельно, не по наличию схемы.

Одноимённая `documentRelationChangeSchema` есть и в `document-library.ts` (ниже):
это другая форма (`link`/`unlink` с `source`) для `DocumentLibraryService.changeRelation`.
Модули не реэкспортируют друг друга; импорт выбирается по операции Core.

### Документная библиотека

`document-library.ts` переиспользует предметные поля из `entities/document-library.ts`,
не меняя их дисковую форму. Core-фасад — `DocumentLibraryService`:

- `documentLinksQuerySchema` / `DocumentLinksQuery`: `ref` документа и обычные
  `offset/limit/version`. `documentLinksPageSchema` / `DocumentLinksPage` возвращает
  `ref`, `key`, `title`, `revision`, `items`, `references`, `total`, `nextOffset`, `version`.
  Элемент `DocumentLinkItem` — `{source: "relations" | "links", target, type, description}`;
  references содержат только `{ref,key,title}` доступных уникальных целей страницы.
  Тела, аннотации целей и пояснения вне страницы не передаются. Прежний `plan-stage`
  остаётся адресом элемента без выдуманной карточки цели.
- `documentSectionsQuerySchema` / `DocumentSectionsQuery`: только пагинация выбранного
  проекта. `documentSectionsPageSchema` / `DocumentSectionsPage` —
  `{project, projectKey, revision, items, total, nextOffset, version}`; элементы —
  существующие `{id,name}` в порядке PROJECT. Ключ заголовка не требует второго get.
- Версии обеих страниц — `<ID владельца>:<ревизия>`, конфликт — `VERSION_CONFLICT`.
  Названия целей не получают отдельного snapshot guard. Пагинация сохраняет defaults
  `offset=0`, `limit=40`, максимум 100; отсутствие версии начинает новое чтение.
- `documentRelationChangeSchema` / `DocumentRelationChange`: общие
  `ref`, `target`, `ifRevision`, `requestId`, optional `actor`; строгие варианты:
  `source: "relations", action: "link", relation?, description?`,
  `source: "relations", action: "unlink", relation?` и
  `source: "links", action: "link" | "unlink"`. Тип modern по умолчанию `documents`.
  Отсутствующее пояснение сохраняет прежнее, для нового отношения означает `""`;
  `description: ""` очищает. Legacy не принимает тип/пояснение, unlink — пояснение.
- `documentSectionChangeSchema` / `DocumentSectionChange`: общие
  `id`, `ifRevision`, `requestId`, optional `actor`; строгие варианты:
  `action: "create" | "update", name`, `action: "move", before: string | null`
  и `action: "remove"`. `before: null` означает конец списка. Мутации возвращают
  прежний `EntitySaved` с `action: "update"`. Actor ввода приоритетнее автора вызова;
  `requestId` не гарантирует дедупликацию и no-op сохраняет новую ревизию.

`EntityDetail.metadata` — optional блок из четырёх обязательных полей
`createdAt`, `createdBy`, `updatedAt`, `updatedBy`; даты — `timestampSchema`,
авторы — `actorSchema`. Его заполняет чтение документов и продуктовых сущностей из настоящей
записи той же ревизии; FI/SI используют собственные метаданные, не дату scope.
Это не история; отсутствие блока не заполняется из mtime,
событий или текущего автора. Обязательные метаданные повреждённого файла не становятся
необязательными из-за optional DTO. Блок не входит в `EntitySummary` и storageCard.
Новый parser принимает прежний ответ без блока, но прежний строгий parser может
отклонить ответ с новым полем: Server/SDK/Backend/CLI обновляются согласованно.

`EntitySummary.updatedAt?` — собственная предметная дата для общей сортировки,
не полный блок metadata. При её отсутствии запись идёт после датированных;
равенство разрешается постоянным адресом. `EntitySummary.implementation?` содержит
`type: FI|SI` и `application`/`target` с `{ref,key,title}`.
`EntitiesQuery.implementationTarget` принимает `feature|scenario`; вместе с active
ограничивает смешанную выдачу реализациями, а section/documentKind/documentFormat/tags/
unattached/pinned — документами.
`EntityDetail.savedStatus?` — сохранённая ручная отметка реализации отдельно от
вычисленного `data.status`; старый ответ без поля не разрешает угадывать его значение.
Общий индексный каталог использует guard `entities-v2:<digest корней>`;
`documents-v1` ниже сохраняется для специализированного документного пути.

`EntitySummary.match?` — одно подтверждённое основание поиска при непустом q,
не новая аннотация и не полный список всех совпавших полей. Текущему ключу и названию
отдаётся предпочтение. `field` принимает `key`, `alias`, `address`, `id`, `title`,
`summary`, `context`, `description`, `body`, `url`, `tags`, `goal`, `version`, `application.key`,
`application.title`, `target.key`, `target.title`.
`text` — исходное значение или фрагмент вокруг первого совпадения, не более 240 единиц
UTF-16; регистр и исходное содержание сохраняются, многоточие и разметка выделения
не добавляются. Это не 240 байт или графем; длинное совпадение тоже может не поместиться.
`truncated: true` требует пометить текст как фрагмент, а false означает полноту
только значения этого поля, не сущности. `document.excerpt` сохранён для совместимости.
При отсутствии match нельзя вычислять или угадывать причину включения по q/title.

Для `EntityEngine.list({kind: "document"})` текущий индексный путь использует новую
непрозрачную версию `documents-v1:<SHA-256 отсортированных пар snapshotRoots>`.
Прежние курсоры дают `ENTITIES_CHANGED`; это не эквивалент прежнему хешу полных entries.
Guard консервативный, включая изменения других корней; dirty/legacy сохраняют старую
каталоговую версию. Это проверка текущего состояния, не исторический снимок и не
диагностика неиндексированных внешних правок файлов.

### Продуктовые чтения и замена состава

Новые схемы не сокращают прежние `ProductState`, `ProductEntity` и `ProductOverview`.
`ProductValidation` возвращает `valid: true`, число агрегатов `records` и `version`;
нарушение инвариантов — ошибка, не `valid: false`.

`ProductLintPage` содержит страницу `warnings` и полные `records`/`total`.
У замечания `ref`, `key`, `title`, `canonicalRef` адресуют публичную сущность;
`recordId` и `field` сохраняют техническое происхождение, у FI/SI — агрегат `scope`
и путь `contracts.ID.description`. `implementationTarget` различает FI/SI. Полные
тексты в рекомендациях не передаются. `ProductOverviewMapPage` содержит только
страницу карты с публичным `subject`; для строки scope это приложение, а не
самостоятельная пользовательская сущность.

`ProductParticipationPage` возвращает все FI/SI выбранного приложения страницами,
включая снятые, без description/basis. `revision` — ревизия состава (0 до создания),
`version` — продуктовая версия для записи, `snapshotVersion` — guard чтения, включая
задачи. У элемента собственная ревизия реализации, цель и фича, `active`, вычисленный
`status` и сохранённый `savedStatus`. Не подменяйте один статус другим.

`ProductParticipationReplace.selections` — полный набор до 10 000 элементов:
`{kind: "existing", ref}` сохраняет прежнее содержание, в том числе снятого вклада;
`{kind: "target", target, title, description, status?}` создаёт новую пару. Пустой
массив снимает всё участие. Core разрешает ссылки, проверяет обе исходные guards
(`ifRevision`, `ifVersion`), принадлежность, повторы и FI для выбранной SI под одним
замком. Результат `ProductParticipationSaved` — новая ревизия/версия и `selected`,
не полный состав и не постоянная квитанция для повторной выдачи.
Optional `key` сохраняется только из исходной квитанции предметной мутации состава.
Он не является публичным адресом scope и никогда не подменяется ключом приложения;
для адресного чтения используйте `application.ref`/`application.key` и страницу состава.

`ProductImplementationDetail` отдельно возвращает `savedStatus`, а `fields.status`
остаётся вычисленным. Полные Markdown, метаданные и собственная ревизия сохраняются.

Страницы принимают `offset`, `limit` (1–100, default 30), необязательную `version`.
Для lint передаётся продуктовая версия; для карты и состава — `snapshotVersion`.
Несовпадение даёт `VERSION_CONFLICT` (exit 4): начните чтение заново. Эти guards
не предоставляют историю. Состав HTTP-маршрутов и их capabilities определён только
в [REST-справочнике](../../server-runtime/docs/API.md), не наличием схемы здесь.

### Компактные рабочие проекции

`PlansCompactQuery`, `ReleasesCompactQuery`, `ReleaseCompositionCompactQuery` и
`ReleasePreviewCompact` требуют явный `projection: "compact"`. Это добавочные формы:
прежние схемы и ответы без проекции сохраняют полный DTO. PlanCompact оставляет
адрес, ревизию, название, summary, status, updatedAt, stageCount, counts, ready, nextStage;
ReleaseCompact — реквизиты, summary, состояние, даты и readiness без description/planIds.
Compact-состав релиза сохраняет readiness и элементы с обзорными plan либо null.
HTTP публикует эти проекции отдельными маршрутами, не union-ответом старого endpoint;
query и тело preview разделены транспортом. Точные адреса — в
[REST-справочнике](../../server-runtime/docs/API.md#планы-и-этапы).

`SaveReleaseByRefs`/`UpdateReleaseByRefs` заменяют planIds на 1–200 `plans` с ключами,
ID или work-plan:ID. Update — полное сохранение со status и ifRevision, не patch.
Разрешение целей и проверки принадлежат одной мутации Core; формы не меняют старую
операцию сохранения по ID и не добавляют автоматический повтор.

`TaskDependenciesPage` содержит только entity/items/total/nextOffset/version;
query наследует ref и пагинацию прогресса. Guard самостоятельный: проект, задача,
limit и состояние задач. Продолжение требует исходную version, не версию полного
TaskProgress; `PROGRESS_CHANGED` требует начать чтение заново. Зависимости имеют
адрес, title, column и completed, но не ревизию соседней задачи.

## Обслуживание хранилища

`storage.ts` описывает manifest единого хранилища: `schemaVersion` — физический формат,
`dataModelVersion` — профиль совместимости модели данных (целевые версии всех постоянных
владельцев). Поле отсутствует только у исторических баз профиля 1; manifest остаётся строгим,
поэтому прежний строгий parser отвергает manifest нового профиля. Перечень профилей,
переходы и правило «отсутствие поля — только исторический reader» принадлежат Core
([формат](../../core/docs/FORMAT.md)).

`storage-maintenance.ts` содержит переносимые схемы результатов обслуживания; их использует
локальный CLI и runner, REST и MCP их не исполняют:

- `storageStatusSchema` — статус `current | migration-required | recovery-required |
unsupported | invalid`, идентичность проекта, фактические и целевые версии по владельцам
  (live и надгробия по версиям), незавершённый WAL, первые 50 `blockers` и первые 50
  `warnings`, обязательные полные `blockersTotal` и `warningsTotal`; продолжения нет;
- `storageMigrationPlanSchema` — статус плюс упорядоченные шаги, изменения файлов по категориям,
  отношений и адресов, удаляемые по правилу структуры, бюджеты, место и `planFingerprint`;
- `storageMigrationResultSchema` — сохраняет `migrated`, `format`, `entities`, `operations: 0`
  и добавляет `schemaVersion`, `resumed`, профили, шаги, отпечаток, проверки и backup.
  `checks.indexes: passed` означает проверку: при переносе индексы перестроены,
  при no-op не изменены; непригодная база текущего профиля не возвращает успешный no-op.
  `entities` — действующие записи сущностей после переноса без надгробий и технических
  владельцев (`scope`, адреса совместимости `plan-stage`). `counts.checked` — записи и наборы,
  прошедшие полную проверку текущими схемами; `counts.changed` — файлы с иным байтовым
  содержанием после публикации; `counts.removedByRule` — удалённые распознанные исторические
  структуры; те же счётчики по видам и категориям — в `counts.owners`;
- `storageErrorDetailsSchema` — форма `details` ошибок хранилища: код, причина, шаг, владелец,
  версии, безопасный относительный путь или ID и `next`, без пользовательского текста и
  конфигурации. `ApiFailure.error.details` остаётся `unknown`; клиенты различают ошибки по `code`.
- `entityRelocatedDetailsSchema` — стабильная форма `details` ошибки `ENTITY_RELOCATED`
  (прежний адрес перенесён владельцу; сейчас только этап `plan-stage` в план). Строгий объект:
  `code: "ENTITY_RELOCATED"`, `from` — запрошенный прежний адрес `kind:id`
  (`plan-stage:<id>`, также при обращении по ключу `STG-N`), `to` — адрес плана-владельца
  `work-plan:<id>`, `stageId` — ID этапа в плане (равен ID прежней записи), `key` — прежний
  ключ `STG-N` или `null`, `next` — подсказка. Название и ключ плана не входят: их даёт чтение
  `to`. Все места Core, отвечающие этой ошибкой, формируют `details` одной функцией по схеме.

`STORAGE_MAINTENANCE_ERROR_EXIT_CODES` — единая таблица кода и exit code CLI для ошибок
совместимости (`STORAGE_MIGRATION_REQUIRED`, `STORAGE_VERSION_UNSUPPORTED`,
`STORAGE_TRANSITION_MISSING`, `STORAGE_REGISTRY_INVALID`, `STORAGE_PLAN_STALE`,
`STORAGE_BACKUP_REQUIRED`, `ENTITY_RELOCATED` и др.). HTTP-статусы назначает Server runtime.
Вид ошибки реестра переходов передаётся в `details.reason` (`storageRegistryIssueSchema`).

## Изменение контракта и проверка

1. Уточните смысл изменения в канонической предметной странице. Добавьте схему поля,
   вывода или действия у существующего владельца и опишите вложенные структуры.
2. Проверьте input/output, defaults, strictness, null/optional и байтовые ограничения.
   Для общих видов согласуйте определения и варианты discriminated union.
3. Реализуйте действие в Core, включая хранение, отношения и старые данные:
   [порядок расширения](../../core/docs/ARCHITECTURE.md). Одна схема не реализует сценарий.
4. При изменении HTTP согласуйте Server runtime: DTO и OpenAPI должны использовать
   ту же предметную семантику. После экспорта OpenAPI обновляется
   [REST SDK](../../rest-sdk/docs/DEVELOPMENT.md), затем затронутые потребители.
5. Запустите типовые проверки пакета из README; дополните runtime-сценариями
   Core/Server, в том числе ошибочными входами и сохранностью текста.

Проверки совместимости находятся в `packages/core/test/contract-compatibility.ts`
и `packages/server-runtime/test/contract-types.ts`. Ответы сервера проверяются в
`packages/server-runtime/test/openapi.test.ts`; экспорт — `pnpm run openapi:export`.
По изменяемым путям применимы `pnpm run test:core`, `pnpm run test:server`,
`pnpm run test:cli`, `pnpm run test:mcp`. Типизация Contracts не доказывает runtime-поведение
Zod или доступность нового действия в Web/CLI/MCP; покрытие фиксируется только
в [общем каталоге](../../../docs/CAPABILITIES.md).

Для правки только этой документации достаточно адресного Prettier, `git diff --check`
и `checkDocumentation` из `apps/cli/scripts/lib/documentation.mjs` с путями
`packages/contracts/README.md` и `packages/contracts/docs/API.md`.
