# Relay Server

`@oim-dev/relay-server` предоставляет REST API, SSE, Swagger и готовый Web-интерфейс
к проектным данным Relay. Требуется Node.js 22+. Команда пакета — `relay-server`.

Из каталога инициализированного проекта или workspace:

```bash
npx @oim-dev/relay-server --open
```

Сервер найдёт ближайшую конфигурацию. Если порт занят, автоматически перейдёт
к следующему свободному порту, выведет фактический адрес и откроет его в браузере.
Он слушает только loopback; `Ctrl+C` завершает процесс и подписки.
Запуск не инициализирует отсутствующий проект и не запускает агентов или CI/CD.

- [Запуск, параметры, Web и устранение ошибок](https://github.com/oim-dev/relay/blob/main/apps/server/docs/USAGE.md)
- [Конфигурация и подключения](https://github.com/oim-dev/relay/blob/main/packages/project-runtime/docs/CONFIGURATION.md)
- [REST API](https://github.com/oim-dev/relay/blob/main/packages/server-runtime/docs/API.md)
- [Начало работы с Relay](https://github.com/oim-dev/relay/blob/main/docs/guides/GETTING_STARTED.md)
- [Разработка и проверка поставки](https://github.com/oim-dev/relay/blob/main/apps/server/docs/DEVELOPMENT.md)

Ссылки ведут на ветку `main` и могут отличаться от установленной версии.
Параметры своей команды проверяйте через `npx @oim-dev/relay-server --help`.
Исходники: <https://github.com/oim-dev/relay>.
