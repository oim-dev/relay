# @relay/project-runtime

Приватный Node.js-пакет конфигурации, реестра проектов и общих адаптеров CLI/MCP.
Принимает явные параметры; env, аргументы, форматирование и жизненный цикл приложений
остаются у потребителей. Автоматического запуска API здесь нет.

- [Конфигурация, режимы и подключение](docs/CONFIGURATION.md) — пользовательский контракт.
- [REST API](../server-runtime/docs/API.md) — транспортный справочник.
- [Применение SDK](../rest-sdk/docs/DEVELOPMENT.md) — технический клиент и его границы.

## Модули и адаптеры

- `config` — поиск и чтение конфигурации без создания базы, выбор проекта, пути и URL.
- `registry` — создание и атомарное изменение реестра под межпроцессной блокировкой.
- `backend/types` — `Backend`, типизированный через методы сервисов Core.
- `backend/local` — прямые экземпляры сервисов Core для локального CLI.
- `backend/http` — адаптация SDK к Backend, проверка ответов, проектное подключение.
- `backend/server` — отдельный клиент серверного реестра, без выбранного проекта.

Backend охватывает настройки проекта, продукт, сущности, граф, доски и задачи,
критерии и комментарии, планы, релизы, прогресс и validation. `projectSettings.get()`
читает актуальные настройки, `projectSettings.save({name, slug, ifRevision})` сохраняет
полную пару имени/slug через Core либо REST `/context/settings`. Если потребителю нужна
частичная правка, он дополняет отсутствующее поле прочитанным значением, сохраняя исходную
пользовательскую `ifRevision`; адаптер не перечитывает ревизию и не повторяет запись.
Разделы `documentSections` изменяются через generic `entities.update`, а не settings.
`deletion.preview({ref, kind})` возвращает полный предпросмотр, а
`deletion.delete({ref, kind, ifVersion, requestId, actor?}, defaultActor)` подтверждает
его через `EntityDeletionService` либо существующие REST-операции удаления. Типы
ввода, предпросмотра и квитанции принадлежат `@relay/contracts/entities`; адаптер
сохраняет исходный `ifVersion`, автора тела (иначе `defaultActor`) и `requestId`.
Правила шести поддержанных видов и каскада доски приложения — в
[контракте удаления](../../docs/domain/STORAGE.md#удаление-с-полным-предпросмотром).
Самостоятельное удаление доски не поддерживается. HTTP проверяет полный ответ
схемой, использует закреплённый ID проекта и не повторяет подтверждение удаления.
Покрытие интерфейсов — в [матрице](../../docs/CAPABILITIES.md).

Экспорты `@relay/project-runtime/config`, `registry`, `backend/types`, `backend/local`,
`backend/http`, `backend/server` выбирают ESM и декларации из `dist`; условие
`tasks-source` предоставляет TypeScript. Адаптеры не копируют бизнес-правила Core.

Для чтения конфигурационного контекста без подготовки legacy-каталогов используйте
`createLocalBackend(cwd, config?, { createLegacyDirectories: false })`. Значение по
умолчанию — `true`. Опция передаётся `openWorkspace`: актуальная проекция PROJECT,
проверки совместимости и recovery обычного WAL сохраняются. Она не делает Backend
read-only и не отменяет возможные записи при последующих предметных операциях.

`Backend.workspace.projectId` сообщает ID, за которым закреплён HTTP Backend после
проверки `/context.projectId`, даже если legacy `config.projectId` отсутствует.
Local Backend передаёт только существующий `config.projectId`, без вычисляемого ID.
Сам `workspace.config` сохраняет конфигурационную проекцию без подстановки этого поля.

## Разработка

Из корня репозитория, с актуальными сборками зависимостей:

```bash
pnpm --filter @relay/project-runtime run build
pnpm --filter @relay/project-runtime run typecheck
pnpm --filter @relay/project-runtime run test
```

`build` очищает `dist` и запускает TypeScript. Собственного lint-скрипта нет.
При изменении Backend сверяйте local и HTTP вместе; `test/config.test.ts` не покрывает
весь HTTP-адаптер. Для затронутых потребителей дополнительно нужны `pnpm run test:cli`
и `pnpm run test:mcp`; потеря ответа записи проверяется без предположения о дедупликации.
