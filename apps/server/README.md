# Relay Server

`@oim-dev/relay-server` предоставляет REST API, SSE, OpenAPI, Swagger и готовый
веб-интерфейс. Команда: `relay-server`. Требуется Node.js 22+.

[Контракт приложения](https://github.com/oim-dev/relay/blob/refactor/application-rebuild/docs/product/applications/server/README.md) ·
[Состояние реализации](https://github.com/oim-dev/relay/blob/refactor/application-rebuild/docs/engineering/implementation/applications.md) ·
[Протокол разработки](https://github.com/oim-dev/relay/blob/refactor/application-rebuild/docs/development/PROTOCOL.md).

Ссылки ведут на документацию ветки `refactor/application-rebuild` в GitHub.
Она может отличаться от установленной версии пакета. Параметры установленной команды
проверяйте через `--help`.

```bash
npx @oim-dev/relay-server --open
npx @oim-dev/relay-server --config ./relay.workspace.json --port 3001
```

Сервер ищет конфигурацию вверх от текущего каталога:

- `.relay/config.json` — local, один проект;
- `relay.workspace.json` — workspace, несколько независимых проектных баз.

В ближайшем каталоге workspace имеет приоритет. Явный `--config` переопределяет
`RELAY_CONFIG` и поиск. Все пути в конфиге относительны к этому файлу.

Порт: `--port` → `RELAY_PORT` → `server.port` → `4700`.
Автор интерфейса: `--actor` → `RELAY_ACTOR` → `human`.
`--format json` выводит адрес и PID процесса; `Ctrl+C` завершает сервер и подписки.

| Адрес                               | Назначение                                  |
| ----------------------------------- | ------------------------------------------- |
| `/`                                 | Веб-интерфейс с выбором проекта в workspace |
| `/api/v1/server`                    | Режим и доступные проекты                   |
| `/api/v1/projects`                  | Реестр сервера                              |
| `/api/v1/projects/:project/context` | Конфигурация выбранного проекта             |
| `/api/v1/projects/:project/tasks`   | Задачи проекта                              |
| `/api/v1/projects/:project/events`  | SSE проекта                                 |
| `/api/docs`                         | Swagger                                     |
| `/api/openapi.json`                 | OpenAPI 3.1                                 |

В local проектные операции также доступны непосредственно под `/api/v1`.
Workspace требует адресации проекта. Сервер слушает `127.0.0.1`.

Runtime принадлежит `packages/server-runtime`; приложение отвечает за пользовательскую
точку входа и поставку Web в `dist/web`. Каждый запрос имеет собственный контекст,
наблюдатели разделяются только внутри одной базы. Реестр перечитывается без перезапуска.

Разработка: `pnpm run dev:server`, `pnpm run build:server`, `pnpm run test:server`.
Поставка: `pnpm run package:check` из корня монорепозитория.
Исходники: <https://github.com/oim-dev/relay>.
