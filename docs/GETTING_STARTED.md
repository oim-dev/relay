# Первый проект Relay

[Документация](README.md) → Первый проект

Примеры npm рассчитаны на опубликованный комплект пакетов в `@oim-dev`.
До первого ручного выпуска используйте [запуск из исходников](DEVELOPMENT.md#запуск).

## Локальный проект

Из каталога кода выполните:

```bash
npx @oim-dev/relay-cli init
npx @oim-dev/relay-cli task create --board product --title "Первая задача" --actor human
npx @oim-dev/relay-cli task list
```

Создаются `.relay/config.json`, постоянный ID проекта и системные доски в `.relay/boards`.
Для интерфейса и общего API запустите отдельный процесс:

```bash
npx @oim-dev/relay-server --open
```

Web доступен на `http://127.0.0.1:4700`, Swagger — на `/api/docs`.
Без URL CLI использует прямой Core; для HTTP:

```bash
npx @oim-dev/relay-cli --server-url http://127.0.0.1:4700 task get PRODUCT-1
```

Постоянное подключение задаётся `server.url` в `.relay/config.json`.

## Workspace

Инициализируйте каждый проект. В общем каталоге создайте `relay.workspace.json`:

```json
{
  "version": 1,
  "mode": "workspace",
  "projects": {
    "a": { "path": "./A" },
    "b": { "path": "./B" }
  },
  "server": { "port": 4700, "url": "http://127.0.0.1:4700" }
}
```

```bash
npx @oim-dev/relay-server --open
npx @oim-dev/relay-cli a task list
npx @oim-dev/relay-cli b task create --board product --title "Задача Б" --actor human
```

Один сервер работает с обеими базами, во фронтенде доступен переключатель проектов.
Workspace CLI использует только сервер. Запуск CLI внутри А автоматически выбирает
ближайший проектный конфиг. Для другого контекста передайте `--config` явно.

## Агенты через MCP

```bash
npx @oim-dev/relay-mcp --server-url http://127.0.0.1:4700
```

Подключите клиента к `http://127.0.0.1:4710/mcp`, вызовите `projects_list`.
В workspace передавайте `project` вместе с ID задачи; в local проект можно опустить.
Оркестратор назначает работу и принимает результат, субагент читает поручение и пишет отчёты.

Для существующей установки см. [смену портов](reference/CONFIGURATION.md#смена-портов-существующего-проекта).

Далее: [конфигурация](reference/CONFIGURATION.md), [CLI](reference/CLI.md),
[MCP](reference/MCP.md), [архитектура](ARCHITECTURE.md).
