# Документация Relay

Relay — рабочая память проекта: требования, задачи, документы и отношения между ними
помогают человеку и агентам продолжать работу с общим пониманием цели и результата.
Начните с [назначения и рабочего цикла](PRODUCT.md).

## Что читать

- [Продукт](PRODUCT.md) — для кого Relay, что он сохраняет и где заканчивается его роль.
- [Каталог и матрица возможностей](CAPABILITIES.md) — предметные возможности,
  их доступность в интерфейсах и границы подтверждённого покрытия.
- [Предметная модель и общий контракт Core](domain/README.md) — сущности,
  отношения, правила чтения и изменения данных.
- [Сквозные руководства](guides/README.md) — как выполнить рабочий сценарий
  и проверить его результат.
- [Архитектура](ARCHITECTURE.md) — границы Core, приложений, транспорта и хранения.
- [Правила документации](https://github.com/oim-dev/relay/blob/main/docs/DOCUMENTATION.md) — где поддерживать знания и как
  отличать требование от реализации и проверки.

## Маршруты

**Начать пользоваться:** продукт → нужная возможность → руководство.
Для запуска выбранного интерфейса откройте README
[Web](https://github.com/oim-dev/relay/blob/main/apps/web/README.md), [CLI](https://github.com/oim-dev/relay/blob/main/apps/cli/README.md),
[MCP](https://github.com/oim-dev/relay/blob/main/apps/mcp/README.md) или [Server](https://github.com/oim-dev/relay/blob/main/apps/server/README.md).

**Разобраться в поведении:** матрица возможностей → предметный контракт →
локальный справочник интерфейса. Наличие операции в одном интерфейсе не означает
её доступности во всех остальных.

**Изменить Relay:** архитектура → контракт затронутой возможности → README
приложения или пакета. Общие знания обновляются здесь, локальные подробности —
рядом с владельцем реализации по правилам документации.

## Документация компонентов

| Область               | Точка входа                                                                                                                                                                          | Что находится у владельца                                      |
| --------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | -------------------------------------------------------------- |
| Ядро                  | [Core](https://github.com/oim-dev/relay/blob/main/packages/core/README.md)                                                                                                           | Предметные сервисы, расширение ядра, хранение и восстановление |
| Общие схемы           | [Contracts](https://github.com/oim-dev/relay/blob/main/packages/contracts/README.md)                                                                                                 | Переносимые типы и схемы, правила изменения контрактов         |
| Сервер                | [Server](https://github.com/oim-dev/relay/blob/main/apps/server/README.md), [Server runtime](https://github.com/oim-dev/relay/blob/main/packages/server-runtime/README.md)           | Запуск, REST, OpenAPI, события и серверное устройство          |
| Подключение и SDK     | [Project runtime](https://github.com/oim-dev/relay/blob/main/packages/project-runtime/README.md), [REST SDK](https://github.com/oim-dev/relay/blob/main/packages/rest-sdk/README.md) | Конфигурация, выбор проекта, local/HTTP и генерация клиента    |
| Интерфейс человека    | [Web](https://github.com/oim-dev/relay/blob/main/apps/web/README.md)                                                                                                                 | Пользовательские действия, маршруты и архитектура Web          |
| Команды агента        | [CLI](https://github.com/oim-dev/relay/blob/main/apps/cli/README.md)                                                                                                                 | Команды, параметры, вывод и добавление операций                |
| Инструменты агента    | [MCP](https://github.com/oim-dev/relay/blob/main/apps/mcp/README.md)                                                                                                                 | Подключение, инструменты, аргументы и разработка сервиса       |
| Разработка и поставка | [Инструменты репозитория](https://github.com/oim-dev/relay/blob/main/scripts/README.md)                                                                                              | Окружение, сборка, проверки и выпуск Relay                     |

Точный пользовательский синтаксис: [CLI](interfaces/CLI.md),
[MCP](interfaces/MCP.md), [REST API](interfaces/API.md).
Настройки подключения описаны в [конфигурации](interfaces/CONFIGURATION.md).
Эти справочники дополняют общие правила, а не задают отдельную предметную модель.
