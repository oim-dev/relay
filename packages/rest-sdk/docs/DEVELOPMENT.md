# Генерация и применение REST SDK

`@relay/rest-sdk` — общий технический клиент браузера и Node.js, не владелец предметных
правил и не подключение конкретного пользователя. Канонический транспортный справочник —
[API](../../server-runtime/docs/API.md). Общий CLI/MCP Backend использует SDK через
[project-runtime](../../project-runtime/README.md), Web настраивает собственный клиент.

## Источник и генерация

1. Измените схемы/декораторы собственного API в server-runtime, получающие модель
   из Contracts/Core. Исправление generated-типов не исправляет источник.
2. Из корня репозитория выполните:

   ```bash
   pnpm --filter @relay/rest-sdk run generate
   pnpm --filter @relay/rest-sdk run typecheck
   pnpm --filter @relay/rest-sdk run build
   ```

3. Проверьте diff исходника OpenAPI и результата, затем обновите потребителей удалённых
   или переименованных операций. Для CLI генератора используйте Node.js 24+.

`generate` включает `pnpm run openapi:export`: `scripts/export-openapi.mts` создаёт
временную базу, инициализирует server-runtime **без listener**, получает
`/api/openapi.json` через inject, закрывает приложение и удаляет временную базу.
Результат — `.artifacts/openapi.json`. Пользовательский Server и конфиг не требуются,
но операция действительно создаёт временные файлы/базу: не запускайте её при запрете
на такую работу. Экспорт использует TypeScript-профиль server-runtime и `tasks-source`.

Manifest закрепляет `@gromlab/rest-api-codegen@5.2.4`. Генератор заменяет весь `src/`,
включая `data-contracts.ts`, `http-client.ts`, `create-api-client.ts`, `operations-tree.ts`,
`operations/*` и экспорты; удаляет устаревшие операции. **Не редактируйте эти файлы руками
и не помещайте helpers внутрь `src/`.** Настройки и адаптация остаются у потребителя.

`build` очищает `dist` и компилирует сохранённые исходники, не запускает генератор.
Пакет не имеет собственных test/lint-скриптов. Проверки фактического транспорта
выполняются в server-runtime и приложениях-потребителях.

## Экспорты

Пакет выдаёт ESM и TypeScript-декларации из `dist`. Условие `tasks-source` предоставляет
исходники среде разработки. Публичные пути:

| Импорт                                   | Назначение                                  |
| ---------------------------------------- | ------------------------------------------- |
| `@relay/rest-sdk`                        | Общие экспорты типов, клиента и операций    |
| `@relay/rest-sdk/http-client`            | `HttpClient`, `ApiError`, транспортные типы |
| `@relay/rest-sdk/create-api-client`      | Связывание дерева операций с клиентом       |
| `@relay/rest-sdk/data-contracts`         | Сгенерированные DTO                         |
| `@relay/rest-sdk/operations-tree`        | Полное дерево групп операций                |
| `@relay/rest-sdk/operations`             | Экспорты операций                           |
| `@relay/rest-sdk/operations/<имя-файла>` | Прямая операция для частичного клиента      |

Не обещайте гарантированный tree-shaking общего barrel. Если нужна малая часть API,
импортируйте конкретные операции и собирайте собственное дерево. Имена функций,
групп и файлов проверяйте по свежей генерации: их определяют operationId и первый tag.

## Настроенный клиент

Клиент создаётся у потребителя, а не в общем SDK. Пример полного браузерного клиента
на том же origin, где работает Server:

```ts
import { HttpClient } from "@relay/rest-sdk/http-client";
import { createApiClient } from "@relay/rest-sdk/create-api-client";
import { operationsTree } from "@relay/rest-sdk/operations-tree";

const http = new HttpClient({ baseUrl: "", timeout: 15_000, redirect: "error" });
const api = createApiClient(http, operationsTree);
const response = await api.context.getContextForProject({ project: selectedProjectId });
```

`selectedProjectId` здесь — ранее выбранный ID сервера; пример не выполняет handshake
за потребителя. Node.js-клиенту нужен абсолютный origin из конфигурации без API-префикса.
Ответ содержит `{ok:true,data}`; не теряйте этот контракт при адаптации.
Generated-типы не проверяют данные во время исполнения: используйте схемы
Contracts/Core в подходящем адаптере и отдельно обрабатывайте `ApiError`/ошибку конверта.

Текущие владельцы настроек:

- `packages/project-runtime/src/backend/http.ts` — CLI/MCP, handshake и привязка по ID,
  Zod-проверки ответов, timeout и политика чтений;
- `packages/project-runtime/src/backend/server.ts` — операции реестра;
- `apps/web/src/infra/tasks-api` — клиент Web;
- `apps/web/src/infra/workspace-events` — отдельный жизненный цикл SSE.

Origin, автор, timeout, retry, отмена и настроенный экземпляр не принадлежат SDK.
Не храните изменяемый общий проект/автора между параллельными клиентами. Соблюдайте
ограничения Host/Origin сервера, не добавляйте вымышленную auth-схему.

## Политика запросов

Генерация предоставляет механизм HTTP, но не разрешает повторять все операции.
В Relay `requestId` — корреляция, не ключ идемпотентности. **Автоматического retry
изменяющих запросов быть не должно**, в том числе после timeout/5xx. После потери
ответа запись могла завершиться: перечитайте данные и согласуйте дальнейшее действие.
409 требует нового чтения и согласования ввода, не новой ревизии для старого тела.

HTTP Backend допускает ограниченные повторы только чтений, включая read-only
`POST /releases/preview`. Не классифицируйте безопасность только по HTTP-глаголу.
Точные параметры текущего адаптера и его ошибки — в
[CONFIGURATION](../../project-runtime/docs/CONFIGURATION.md#http-адаптер-и-восстановление-подключения).
Не переносите эту политику автоматически на все SDK-клиенты.

Сохраняйте Markdown строками, различия отсутствия/null/пустого набора, автора,
ревизии и проект. Параметры страниц и токены версии принадлежат конкретной операции;
универсального `meta.nextCursor` нет. SDK не делает второй запрос синхронизации графа
после предметной записи. SSE не используется для получения сохранённого результата команды.

## Проверка изменения

- Сверьте path/query/body и обязательность, input/output, nullable/defaults; не допускайте
  неожиданного `any` из-за потери метаданных декораторов при экспорте.
- Сравните local и `ForProject` операции. Смена русского описания сама по себе
  не должна менять сигнатуру.
- Проверьте реальные запросы/ответы тестами server-runtime, а не только TypeScript.
- После обновления выполните нужные проверки потребителей: `pnpm run test:cli`,
  `pnpm run test:mcp`, `pnpm run typecheck:web` из корня репозитория.
- Не считайте отсутствие старого файла после генерации доказательством обновления
  всех вызовов, и не используйте наличие SDK-метода как доказательство готового UI.

Команды и экспорт сверяются с [manifest пакета](../package.json),
[экспортом OpenAPI](../../../scripts/export-openapi.mts) и
[регистрацией схем](../../server-runtime/src/openapi/schemas.ts).
