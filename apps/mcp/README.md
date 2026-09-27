# Relay MCP

`@oim-dev/relay-mcp` предоставляет агентам инструменты Relay через **stdio или Streamable HTTP**.
MCP обращается только к уже запущенному Relay Server, не открывает базу напрямую.
Нужны Node.js 22+ и npm; checkout Relay не требуется.

## Подключение

Первый шаг в корне вашего проекта — установить пользовательский скилл:

```bash
npx skills add oim-dev/relay
```

Выберите Relay и своего агента. Инициализация проекта и запуск Server описаны в
[начале работы](https://github.com/oim-dev/relay/blob/main/docs/guides/GETTING_STARTED.md).
Обычный агентский маршрут — проектный конфиг, по которому клиент запускает:

```bash
npx @oim-dev/relay-mcp --transport stdio --server-url http://127.0.0.1:4700
```

Не запускайте stdio вручную: [проектные конфиги клиентов](https://github.com/oim-dev/relay/blob/main/apps/mcp/docs/CLIENTS.md)
задают запуск через npx. После настройки перезапустите клиент и вызовите `projects_list({})`.
Совместимый запуск без `--transport` остаётся HTTP на `http://127.0.0.1:4710/mcp`;
он требует отдельно управляемого процесса и HTTP-подключения клиента.
В local поле `project` можно опустить; в workspace оно обязательно для проектных вызовов.

При записи передавайте своего `actor` и прочитанную ревизию, если действие её требует.
`requestId` — только корреляция, не дедупликация и не сохранённая квитанция.
После потери ответа сначала перечитайте состояние; не повторяйте запись вслепую.

## Документация

- [Подключение, все инструменты и аргументы](https://github.com/oim-dev/relay/blob/main/apps/mcp/docs/MCP.md).
- [Устройство и разработка MCP](https://github.com/oim-dev/relay/blob/main/apps/mcp/docs/DEVELOPMENT.md).
- [Конфигурация](https://github.com/oim-dev/relay/blob/main/packages/project-runtime/docs/CONFIGURATION.md).
- [Общий HTTP API](https://github.com/oim-dev/relay/blob/main/packages/server-runtime/docs/API.md).

Ссылки ведут на канонические страницы ветки `main`, которая может отличаться
от установленного пакета. Каталог `docs` не включён в npm `files` этого приложения;
документация читается по HTTPS. Параметры своей версии проверяйте через
`npx @oim-dev/relay-mcp --help`, инструменты — через discovery клиента.
