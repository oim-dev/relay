# Relay Playground

Локальный проект для проверки Relay на данных в `apps/playground/.relay`.
Команда `playground` запускает CLI из текущих исходников репозитория: достаточно
установленных зависимостей workspace, предварительная сборка не нужна.

## Запуск из корня репозитория

```bash
pnpm --silent run playground --help
pnpm --silent run playground overview
pnpm --silent run playground project get
pnpm --silent run playground task list
```

Аргументы CLI передаются сразу после `playground`, без дополнительного `--`.
`--silent` убирает служебный вывод pnpm.

## Запуск из каталога apps/playground

Укажите путь к корню, где находится скрипт:

```bash
pnpm --dir ../.. --silent run playground project get
pnpm --dir ../.. --silent run playground overview
pnpm --dir ../.. --silent run playground session context --help
```

## Сессии и восстановление контекста

Следующие примеры выполняются из корня репозитория. Сначала найдите ветку:

```bash
pnpm --silent run playground session list \
  --unfinished
```

Замените `S-token` фактическим ключом из списка:

```bash
pnpm --silent run playground session get S-token
pnpm --silent run playground session context S-token \
  --limit 10
pnpm --silent run playground session intents S-token
```

`get` читает полную карточку, `context` — поручение и страницу полных материалов,
`intents` — открытые намерения, включая старые. Для следующей страницы передавайте
полученный курсор той же команде через `--cursor`.

## Подключение и формат

По умолчанию скрипт выбирает `apps/playground/.relay/config.json`.
Установленный `RELAY_CONFIG` переопределяет этот путь; явный `--config` имеет
приоритет над переменной. Действующее подключение можно посмотреть так:

```bash
pnpm --silent run playground config get
```

Для прямого чтения локальной базы независимо от HTTP-настроек добавьте `--local`:

```bash
pnpm --silent run playground project get \
  --local
```

Обычный ответ — текст. Машинный формат включается явно:

```bash
pnpm --silent run playground session list \
  --format json
```

Для записи передавайте автора через `--actor` или `RELAY_ACTOR`. Параметры конкретной
команды доступны через `--help`.

- [Подготовка окружения и команды разработки](../../scripts/README.md)
- [Справочник CLI](../cli/docs/CLI.md)
- [Текстовый вывод и страницы](../cli/docs/TERMINAL.md)
