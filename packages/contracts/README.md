# Contracts — переносимые схемы и типы Relay

`@relay/contracts` задаёт общий язык данных для Core и его потребителей: Zod-схемы
предметных полей, действий и результатов, переносимые оболочки хранения, DTO и
константы API. Пакет зависит только от Zod, без Core, Node.js, NestJS или React.
Схема проверяет форму данных, но не заменяет предметную операцию Core.

```ts
import type { ApiResponse } from "@relay/contracts";
import { entitiesQuerySchema } from "@relay/contracts/entities";
```

- [Схемы, типы и изменение контракта](docs/API.md) — карта exports, input/output,
  описания, граница DTO и хранения, проверки потребителей.
- [Предметная модель](../../docs/domain/README.md) — смысл данных и действий.
- [REST API](../server-runtime/docs/API.md) — канонический транспортный справочник;
  Contracts не поддерживает вторую таблицу маршрутов.
- [Каталог возможностей](../../docs/CAPABILITIES.md) — единственное место общего покрытия.

## Разработка

Из корня репозитория после установки зависимостей:

```sh
pnpm run build:contracts
pnpm --filter @relay/contracts run typecheck
pnpm run test:contracts
```

Обычные импорты используют `dist`; условие `tasks-source` выбирает исходники.
Сборка очищает `dist` и запускает TypeScript. Пакетные `typecheck` и `test` оба выполняют
`tsc -p tsconfig.test.json`: это проверка типов, **не runtime-тесты Zod**.
Корневой `test:contracts` через Turbo предварительно собирает пакет. Отдельного
lint-скрипта нет. Runtime-поведение схем проверяйте в сценариях Core и потребителей.
