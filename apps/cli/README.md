# Relay CLI

`@oim-dev/relay-cli` — терминальный клиент Relay. Команда: `relay-cli`.
Требуется Node.js 22+.

[Контракт приложения](https://github.com/oim-dev/relay/blob/refactor/application-rebuild/docs/product/applications/cli/README.md) ·
[Состояние реализации](https://github.com/oim-dev/relay/blob/refactor/application-rebuild/docs/engineering/implementation/applications.md) ·
[Протокол разработки](https://github.com/oim-dev/relay/blob/refactor/application-rebuild/docs/development/PROTOCOL.md).

Ссылки ведут на документацию ветки `refactor/application-rebuild` в GitHub.
Она может отличаться от установленной версии пакета. Параметры установленной команды
проверяйте через `--help`.

```bash
npx @oim-dev/relay-cli init
npx @oim-dev/relay-cli task create --board product --title "Первая задача" --actor human
npx @oim-dev/relay-cli task list
```

`.relay/config.json` выбирает local: прямой Core либо HTTP по `server.url`.
`relay.workspace.json` выбирает workspace: общий сервер и явный проект.

```bash
npx @oim-dev/relay-cli a task list
npx @oim-dev/relay-cli --project b task get PRODUCT-1
npx @oim-dev/relay-cli --server-url http://127.0.0.1:4700 --project a task get PRODUCT-1
```

`--config` переопределяет `RELAY_CONFIG` и поиск вверх. `--server-url` переопределяет
`RELAY_SERVER_URL` и конфиг. `--local` доступен для прямой работы с одним проектом.
Автор мутации: `--actor` или `RELAY_ACTOR`.

Сервер с Web запускается отдельным пакетом `@oim-dev/relay-server`.

Исходники: <https://github.com/oim-dev/relay>.
Разработка: `pnpm run build:cli`, `pnpm run test:cli`, `pnpm run package:check` из корня.
