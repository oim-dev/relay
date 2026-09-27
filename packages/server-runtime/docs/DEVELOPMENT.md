# Устройство и разработка server-runtime

Runtime предоставляет транспорт поверх Core. Пользовательский контракт находится
в [API](API.md); границы всей системы — в [архитектуре](../../../docs/ARCHITECTURE.md).
Не переносите сюда бизнес-правила, формулы прогресса или согласование предметных связей.

## Жизненный цикл и зависимости

`src/bootstrap.ts` экспортирует `createServer` без listener и `startServer` с запуском
на loopback. `ServerOptions` принимает `cwd`, `actor`, необязательные `config`, `port`,
`webRoot`, `allowedOrigins`. Приложение разбирает env/flags и передаёт их явно.
Встраивающий код обязан закрыть созданное Nest-приложение; `startServer` предоставляет
`close()` и фактический `url`. Ошибка инициализации/запуска закрывает приложение.

`src/app.module.ts` подключает HTTP-модули и опциональный ServeStaticModule.
Если `webRoot` не указан/false или нет `index.html`, остаются API, Swagger и SSE.
`common/http-policy.ts` сохраняет loopback Host/Origin-политику, JSON Content-Type,
исключение API и отсутствующих ресурсов из SPA fallback. Лимит тела задаётся Fastify.

Core импортируется через `@relay/core/*`, DTO/переносимые схемы — `@relay/contracts`.
Project runtime предоставляет конфигурацию и реестр. SDK является потребителем
экспортируемой OpenAPI, а исходники приложений не являются библиотекой runtime.

## Модули и контекст запроса

- `modules/workspace/catalog.ts`: `ProjectCatalog` перечитывает реестр, разрешает
  ключ/ID/slug, проверяет коллизии и доступность; `ProjectContext` закрепляет одну базу.
- `modules/workspace/workspace.module.ts`: `WorkspaceService` имеет `Scope.REQUEST`,
  разрешает один контекст на запрос; проект/автор не хранятся как общий активный выбор.
- `modules/workspace/routing.ts`: scoped-префикс переиспользует те же контроллеры
  через rewrite URL, сохраняя поток SSE.
- `modules/{entities,product,boards,board-tasks,planning,releases,progress,graph}`:
  транспортные адаптеры соответствующих сервисов Core.
- `modules/context`, `workspace/server.module.ts`, `health`, `project`:
  подключение/settings, реестр, доступность и validation.
- `common/validation.ts`, `common/errors.ts`: транспортная валидация и единый конверт ошибок.

Образец записи — `modules/planning/planning.module.ts`: разрешить Workspace и автора,
проверить ввод, вызвать сервис Core, после успеха уведомить EventsService, вернуть
`success(result)`. Связи согласует предметный сервис внутри Core. Второй запрос клиента
или повтор этой логики контроллером недопустимы. Settings/реестр имеют свои отдельные
пути и не должны механически копировать алгоритм предметной записи.

## События

`modules/events/events.service.ts` разделяет наблюдатель внутри одного конфигурационного
контекста, не между базами. Для текущего формата сигнал публикации — `.indexes/state.json`;
проверка изменённых постоянных файлов выполняется через Core. `fs.watch` дополняется
refresh для пропущенных событий и замены каталога, не полным чтением всех Markdown по таймеру.

Собственная публикация Core отличается от внешней правки: последняя может дать
`STORAGE_INDEX_STALE` до явного обслуживания. Не превращайте ошибку в пустую базу.
Удаление/переназначение регистрации освобождает прежние ресурсы, остановка закрывает
watcher/timer/stream и ожидает незавершённый refresh. Проверяйте восстановление после
замены конфига/каталога и переподключение после ошибки. Контракт доставки — в [API](API.md#sse).

## OpenAPI и изменение транспорта

`openapi/schemas.ts` регистрирует схемы, `endpoint.ts` описывает конверты, query/body
и ошибки, `setup.ts` создаёт OpenAPI 3.1 и scoped-копии `ForProject`.
`project-selector.ts` реализует выбор проекта в Swagger.

При новом семействе меняйте регистрацию модуля, список projectRouting и OpenAPI вместе.
Описание scoped-операции без реального маршрута недостаточно. Описания операций,
параметров и ошибок — русские; path-параметры документируются явно. Различайте
Zod input/output, defaults/coercion и обязательность. Новый код ошибки Core требует
согласованного HTTP-отображения, не произвольного успешного пустого ответа.

После изменения источника API обновляется [SDK](../../rest-sdk/docs/DEVELOPMENT.md),
затем адаптеры и потребители. OperationId и tags определяют имена/группы SDK.
Typescript не доказывает соответствие фактическому wire contract. В схемах могут
сохраняться прежние описания: не переносите из них обещания истории/дедупликации,
которые противоречат текущему [контракту хранения](../../../docs/domain/STORAGE.md).

## Проверки из корня репозитория

```bash
pnpm run build:server
pnpm --filter @relay/server-runtime run typecheck
pnpm --filter @relay/project-runtime run typecheck
pnpm --filter @oim-dev/relay-server run typecheck
pnpm run test:server
pnpm --filter @relay/project-runtime run test
```

Прямые пакетные проверки требуют актуальных сборок зависимостей; корневые Turbo-команды
строят граф. Собственного lint нет. При изменении API выполняйте также generate,
typecheck и build SDK по его руководству; затронутые CLI/MCP/Web проверяйте отдельно.

- `test/contract-types.ts` включён в typecheck и проверяет часть DTO/схем.
- `test/openapi.test.ts` проверяет реальные local/scoped запросы и ответы через AJV,
  operationId и отсутствие удалённых маршрутов.
- `test/project-selection.test.ts` проверяет идентичность при замене регистрации.
- `test/events.test.ts` — SSE после прямой записи Core и ошибки/восстановление.
- `test/swagger-project.test.ts` — выбор проекта в Swagger.
- `test/health-context.test.ts` — API/статика и политика запросов.

Проверяйте пустой результат, неверный ввод, конфликт, большой ответ, сохранность Markdown,
параллельные проекты/авторов и потерю ответа записи без автоматического повторения.
Успешная сборка не доказывает читаемость Swagger или готовность установленной поставки;
последняя проверяется у [приложения Server](../../../apps/server/docs/DEVELOPMENT.md).
