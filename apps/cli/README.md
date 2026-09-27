# Relay CLI

`@oim-dev/relay-cli` — интерфейс памяти проекта Relay прежде всего для агентов,
также для человека в терминале. Читает знания, задачи, планы и связи, сохраняет
предметные изменения через Core или необязательный HTTP-сервер. Требуется Node.js 22+.

Первый запуск для агента: установите Relay skill, затем подготовьте проект.
Подробности — [начало работы](https://github.com/oim-dev/relay/blob/main/docs/guides/GETTING_STARTED.md).

```bash
npx skills add oim-dev/relay
npx @oim-dev/relay-cli init
```

Далее агент сохраняет и уточняет знания проекта, а затем создаёт задачи на их основе.
Skill — подготовка агентского сценария, не runtime-зависимость CLI: обычное чтение
и ручное обслуживание доступны без него. Например, проверить чтение списка можно так:

```bash
npx @oim-dev/relay-cli task list --format json
```

После установки `npm install -g @oim-dev/relay-cli` те же команды доступны как
`relay-cli`. `--help` работает без проекта. Агенту следует явно выбирать
`--format json`: успех имеет вид `{ok:true,data,meta?}`, ошибка — `{ok:false,error}`.
Человеческий вывод включается через `--format text`.

`init` создаёт `.relay/config.json` и хранилище в текущем проекте. Конфиг ищется
вверх от рабочего каталога. Для уже настроенного workspace нужен выбранный проект;
сервер с Web запускается отдельно пакетом `@oim-dev/relay-server`.

```bash
npx @oim-dev/relay-cli a task list
npx @oim-dev/relay-cli --server-url http://127.0.0.1:4700 --project a task get PRODUCT-1
```

Автор предметной записи — `--actor` или `RELAY_ACTOR`; обновление требует прочитанной
ревизии. После потери ответа сначала прочитайте состояние: `requestId` — корреляция,
не гарантия безопасного повтора. Для обычного локального проекта `--local` и
`--config` не нужны; они полезны для обслуживания или выбора нестандартной базы.

- [Полный справочник команд и параметров](https://github.com/oim-dev/relay/blob/main/apps/cli/docs/CLI.md)
- [Терминальное представление](https://github.com/oim-dev/relay/blob/main/apps/cli/docs/TERMINAL.md)
- [Разработка и расширение CLI](https://github.com/oim-dev/relay/blob/main/apps/cli/docs/EXTENDING.md)
- [Продукт](https://github.com/oim-dev/relay/blob/main/docs/PRODUCT.md),
  [возможности](https://github.com/oim-dev/relay/blob/main/docs/CAPABILITIES.md),
  [предметные правила](https://github.com/oim-dev/relay/blob/main/docs/domain/README.md)

Справочники также входят в каталог `docs` npm-пакета. HTTPS-ссылки ведут на `main`
и могут отличаться от установленной версии; её синтаксис проверяйте через `--help`.
