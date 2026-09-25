# Tasks REST SDK

Приватный workspace `@relay/rest-sdk` предоставляет технический клиент Relay API
для браузера и Node.js. `src/` полностью принадлежит
`@gromlab/rest-api-codegen@5.2.4`; источник контракта — OpenAPI сервера.

SDK экспортирует собранный ESM и декларации из `dist`. Публичные пути:
корень пакета, `http-client`, `create-api-client`, `data-contracts`,
`operations-tree`, `operations` и `operations/<имя-операции>`.
Для частичного клиента импортируйте конкретные операции по их subpath.

## Генерация и сборка

Из корня репозитория:

```bash
pnpm --filter @relay/rest-sdk run generate
pnpm --filter @relay/rest-sdk run build
```

`generate` сначала выполняет `pnpm run openapi:export`: поднимает изолированный сервер
без прослушивания порта на временной базе, получает OpenAPI через inject и закрывает его.
Источник — `.artifacts/openapi.json`; пользовательский сервер не требуется.
Для явно выбранного внешнего источника выполните из `packages/rest-sdk`:

```bash
pnpm dlx @gromlab/rest-api-codegen@5.2.4 --input http://127.0.0.1:3011/api/openapi.json --output src
```

Сборка очищает `dist` и компилирует сохранённые исходники. Turbo собирает SDK перед приложениями-потребителями;
скрипт `dev` приложения также собирает SDK перед запуском Vite. Условие
`tasks-source` предоставляет исходники для CLI под tsx; обычные exports используют `dist`.

Экспорт использует профиль TypeScript Server Runtime и явные схемы HTTP. После генерации
обязательно проверяйте diff и типы параметров: отсутствие метаданных декораторов не должно
превращать параметры пути в `any`. Изменение описания не должно менять сигнатуры операций.

## Подключение

Настроенный экземпляр, адрес и политика запросов принадлежат приложению:

```ts
import { createApiClient } from "@relay/rest-sdk/create-api-client";
import { HttpClient } from "@relay/rest-sdk/http-client";
import { operationsTree } from "@relay/rest-sdk/operations-tree";

const httpClient = new HttpClient({ baseUrl: "", timeout: 15_000 });
export const tasksApi = createApiClient(httpClient, operationsTree);
```

В `apps/web` экземпляр находится в `infra/tasks-api`. Домены используют его фасет
и адаптируют DTO к своим моделям; React-компоненты получают предметные данные
через публичные доменные API. SSE имеет отдельный жизненный цикл в
`infra/workspace-events`.

В `packages/project-runtime/src/backend/http.ts` создаётся отдельный клиент с серверным origin,
тайм-аутом и политикой повторов. Он адаптирует SDK к общему контракту CLI и MCP,
передаёт автора каждой мутации и ключ идемпотентности записи. Адрес и автор
не сохраняются в SDK. Актуальная схема API 1 содержит 157 операций и 739 моделей:
полный контекст, удаление сущностей, критерии приёмки, движок одиннадцати сущностей,
граф, предметный прогресс, планы и релизы с их проектными маршрутами.
Этапы вложены в план и изменяются под его ревизией. Состав релиза читается актуальным;
операций снимка выпуска в SDK нет. Точные контракты — [планы](../../docs/reference/PLANNING.md)
и [релизы](../../docs/reference/RELEASES.md).

MCP всегда вызывает этот SDK и подключается к отдельно запущенному Relay Server.
Адрес берётся из явного URL или выбранной конфигурации. Сгенерированные операции
и контракты остаются едиными для web, CLI и MCP.
