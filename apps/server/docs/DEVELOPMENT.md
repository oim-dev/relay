# Разработка и поставка Server

Приложение владеет командой `relay-server`, env/flags, выводом адреса и PID,
открытием браузера, сигналами остановки и доставкой Web. HTTP-реализация находится
в [server-runtime](../../../packages/server-runtime/docs/DEVELOPMENT.md),
пользовательский запуск — в [USAGE](USAGE.md).

## Точки изменения

- `src/main.ts` — Commander, приоритет env/flags, `startServer`, `--open`, SIGINT/SIGTERM.
- `scripts/environment.mjs` — окружение разработки, не настройки установленного пакета.
- `scripts/assets.mjs` — доставка Web в `dist/web`.
- `package.json` и `#manifest` — версия, bin и расположение ресурсов установленного пакета.
- Корневой `scripts/package.mjs` — проверка самостоятельной поставки.

README попадает в npm-пакет, каталог `docs` не входит в его `files`. Поэтому README
ссылается на HTTPS-адреса `github.com/oim-dev/relay/blob/main/...`, а не требует checkout.
Внутри документации репозитория используются относительные ссылки.

## Команды из корня репозитория

После установки зависимостей:

```bash
pnpm run dev:server
pnpm run build:server
pnpm --filter @oim-dev/relay-server run typecheck
pnpm run test:server
pnpm run package:check:server
```

`dev:server` запускает процесс разработки. `build:server` через Turbo собирает зависимости
и Web, затем assets сервера. `test:server` запускает тесты приложения и server-runtime,
но не project-runtime. Пакетные `build`, `clean`, `dev`, `start`, `typecheck`, `test`
и `package:check` определены в manifest; собственного lint нет. `start` требует готовый `dist`.
Проверка упаковки — не команда публикации.

## Что проверять

`test/server-command.test.ts`, `test/dev-server.test.ts`, `test/production-server.test.ts`
проверяют команду и собранное приложение. Для изменения поставки нужна также проверка
установленного архива вне исходников: поиск local/workspace, Web и assets, прямой SPA-адрес,
ошибка неизвестного API, фактический динамический порт, текстовый/JSON-вывод и остановка.
Успешная сборка или запуск в checkout не заменяет такой проверки.

Не зашивайте личную базу и dev-пути в пакет. Параметры окружения приложения передаются
runtime явно; настройки пользователя не принадлежат SDK.
