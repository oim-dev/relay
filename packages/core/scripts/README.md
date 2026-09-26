# Адресный перенос подтверждённых orphan planning events

`migrate-approved-planning.mts` — внутренний maintenance-вход Core, не новая команда
CLI/MCP/REST. Он вызывает `StorageService.migrate(options)`. Без опции миграция
по-прежнему останавливается при отсутствующем владельце `record-audit`.

Разрешение передаётся отдельным проверенным JSON, **вне каталога `.relay`**:

- `orphanPlanning.projectId` — постоянный ID единственного живого проекта;
- `events[]` — точные `operationId`, `owner: {kind,id}`, `key`, `eventHash`;
- `receipts[]` — точные `operationId`, `namespace`, `actor`, `requestId`,
  `requestHash`, `resultHash` исходных команд.

`eventHash` — `digest(jsonValue(event))` для полного `indexed`-события из
`readUnifiedMigrationSources`, включая группы. `resultHash` — `digest(operation.result)`.
`requestHash` копируется из исходной операции, а не пересчитывается. Все события
должны быть явно согласованы: нельзя автоматически разрешать всё найденное у
отсутствующего владельца. Сам runner не составляет allowlist.

В разрешении допустимы только `work-plan`, прежний `plan-stage` и `release`.
Существующая сущность, tombstone, текущий адрес или связь запрещают исключение.
Изменённый, лишний, пропавший или повторный элемент приводит к отказу до публикации.
Квитанции не удаляются: выбранные исходные команды сохраняются в `receipts` проекта
с прежними identity/hash/result. План, этап, релиз и резерв адреса из audit не создаются.

Запуск из корня репозитория **сначала на отдельной копии**:

```sh
node --conditions=tasks-source --import tsx packages/core/scripts/migrate-approved-planning.mts \
  --project /absolute/path/to/project-copy \
  --approval /absolute/path/to/reviewed-approval.json \
  --apply --reindex
```

`--apply` обязателен. Ищется только указанный `.relay/config.json`, не конфигурация
родительского проекта. ID конфига должен совпасть с разрешением. Символьные ссылки
в выбранной базе останавливают runner. `--reindex` отдельно перестраивает индексы
после миграции; без него оставшиеся старые производные сегменты могут занимать место.

Вывод содержит результат и размеры файлов `.relay` в байтах до миграции,
после миграции и после необязательного reindex. `persistentBytes` исключает
`.indexes`, `runtime` и `transactions`; внешний файл разрешения в размеры не входит.

`orphanPlanning.discardedEvents` сообщает число исключений **в этом вызове**.
После recovery уже опубликованного v3 повтор не исключает события заново:
возвращается `migrated: false`, `discardedEvents: 0`, а `preservedReceipts`
подтверждает наличие исходных квитанций в проекте. В БД не создаётся журнал разрешений.

Переключение и удаление известных источников выполняются одним WAL. Явные проверки
отсутствия файлов владельцев остаются в pending-пакете: появившийся чужой файл
останавливает recovery, а не удаляется. Неизвестные файлы не являются кандидатами
удаления. Применение к реальной базе требует отдельного разрешения после проверки копии.
