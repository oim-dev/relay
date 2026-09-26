# Relay MCP

`@oim-dev/relay-mcp` подключает AI-агентов к Relay Server через Streamable HTTP.
Требуется Node.js 22+.

[Контракт приложения](https://github.com/oim-dev/relay/blob/main/docs/product/applications/mcp/README.md) ·
[Состояние реализации](https://github.com/oim-dev/relay/blob/main/docs/engineering/implementation/applications.md) ·
[Протокол разработки](https://github.com/oim-dev/relay/blob/main/docs/development/PROTOCOL.md).

Ссылки ведут на документацию целевой ветки `main` в GitHub.
Она может отличаться от установленной версии пакета. Параметры установленной команды
проверяйте через `--help`.

```bash
npx @oim-dev/relay-mcp --server-url http://127.0.0.1:4700
```

Адрес MCP по умолчанию — `http://127.0.0.1:4710/mcp`.
`--server-url` переопределяет `RELAY_SERVER_URL`. Без явного адреса настройки
подключения читаются из ближайшего `.relay/config.json` или `relay.workspace.json`.
Relay Server должен уже работать.

`projects_list` показывает режим и доступные проекты. В local `project` можно
опустить. В workspace он обязателен для проектных операций даже при одной регистрации.

```text
board_task_get({ project: "a", reference: "PRODUCT-1" })
```

Порт MCP: `--port`, затем `RELAY_MCP_PORT`, конфиг и `4710`.
Проекты регистрируются на Relay Server. MCP использует общий REST SDK и получает
изменения реестра без перезапуска. При недоступном сервере инструмент возвращает ошибку.

Исходники и справочник: <https://github.com/oim-dev/relay>.
Разработка: `pnpm run build:mcp`, `pnpm run test:mcp`, `pnpm run package:check`.
