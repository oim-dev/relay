# Как добавить команду

[Документация](../README.md) → Разработка → Расширение CLI

## Что мешало расширению

Обработчики замыкались на экземплярах Commander и повторяли разбор `opts()`,
извлечение аргументов и подключение справки. Описание поведения находилось
в документации, а в `--help` оставались однострочные подписи. Общие входы
комментариев и отчётов тоже настраивались отдельно.

Теперь `apps/cli/src/command.ts` задаёт единый формат `CommandDefinition<Options>`:

- `name` — имя и позиционные аргументы в синтаксисе Commander;
- `description` — короткое назначение для списка команд;
- `arguments` — объяснение каждого позиционного аргумента;
- `details` — условия и поведение команды;
- `examples` — пары «команда / объяснение» для `--help`;
- `configure` — опции, в том числе общие наборы;
- `run` — обработчик с готовым `CommandContext` и `CommandInput<Options>`.

`registerCommand` отвечает за подключение этих частей. Открытие проекта,
выбор формата, лимит ответа и печать остаются в общем адаптере `action`.
Обработчик возвращает `Result`, а не пишет в stdout.

## Пример

Добавьте определение в подходящий модуль `apps/cli/src/commands/`:

```ts
import { registerCommand } from "../command.js";

registerCommand<{ titleOnly?: boolean }>(program, runtime, {
  name: "inspect <id>",
  description: "Прочитать выбранные данные задачи",
  arguments: { id: "Числовой ID задачи, например 3" },
  details: "Читает одну задачу. --title-only возвращает только её название.",
  examples: [["relay-cli inspect 3 --title-only", "Выбрать название"]],
  configure: (command) => command.option("--title-only", "Только название"),
  async run(context, input) {
    const { task } = await context.tasks.document(input.argument());
    return {
      data: input.options.titleOnly ? { title: task.title } : task,
    };
  },
});
```

Это пример расширения, а не встроенная команда. CLI-адаптеру принадлежат
параметры и преобразование ввода. Если операция содержит бизнес-правила,
вынесите её в `packages/core/src/application/` и вызывайте из `run` через
экспорты `@relay/core/application/*`. Не используйте алиасы корневого tsconfig
или относительные импорты исходников другого workspace.

Команды обращаются к `context.tasks` и `context.backend.comments/logs/validate`.
Контракт `packages/project-runtime/src/backend/types.ts` реализован локальным Core и HTTP через
`@relay/rest-sdk`. Новая рабочая операция должна поддерживать оба адаптера;
файловый `Workspace` доступен только локальной служебной операции через `localWorkspace`.
Расширение API сопровождается OpenAPI и регенерацией SDK. Терминальное представление
и байтовая пагинация остаются в CLI; общие read models находятся в Core.

Для отдельного семейства создайте `registerXxx(program, runtime)` и подключите
его в `apps/cli/src/program.ts`. Вложенные команды регистрируются так же:

```ts
const group = commandGroup(program, {
  name: "report",
  description: "Отчёты проекта",
  details: "Выберите подкоманду. Для каждой доступна справка с примерами.",
  examples: [["relay-cli report list", "Посмотреть отчёты"]],
});

registerCommand(group, runtime, definition);
```

Вызов группы без подкоманды показывает справку. Ошибка неизвестной подкоманды
перечисляет допустимые варианты и указывает нужный `--help`.

## Повторно используемые части

| Набор                                | Назначение                                                        |
| ------------------------------------ | ----------------------------------------------------------------- |
| `fieldOptions` / `taskFields`        | Поля карточки, очистка значений, Markdown и ссылки                |
| `cursorOptions`                      | Независимые параметры `--limit` и `--cursor`                      |
| `pageOptions` / `pageFrom`           | Страницы групп, комментариев и отчётов; `--all` для целого ответа |
| `revisionOption` / `mutation`        | Автор записи и оптимистическая проверка версии                    |
| `textInputOptions` / `readTextInput` | Один источник тела: аргумент, stdin или файл                      |
| `logFilterOptions`                   | Автор, тип, сессия и период отчётов                               |
| `changed`                            | Короткий ответ записи `{id, revision}`                            |

`input.options` типизирован интерфейсом команды; преобразования аргументов
опций выполняет Commander. `input.argument(index)` возвращает обязательный
позиционный аргумент, `input.optionalArgument(index)` — необязательный.
Числовой ID проверяется через `parseTaskId` на границе прикладной операции.

У `list` параметр `--all` принадлежит фильтрам статусов, поэтому команда использует
`cursorOptions` и сама формирует `PageOptions`. Отсутствующее поле `limit` означает
страницу по байтовому бюджету. Общий `pageFrom` применяет `output.defaultLimit`
и используется списками групп, комментариев и отчётов.

Не удерживайте блокировку во время чтения stdin. Используйте `TaskService.mutate`
для изменения: он читает один актуальный снимок, проверяет revision и граф,
публикует JSON атомарно. Внутри transform разрешайте ссылки из переданного
`tasks` через `resolveTask`, чтобы не брать вложенную блокировку и не читать базу повторно.

`init` — специальный случай: проект ещё не существует. Он использует общий
`createCommand` для описания и справки, а затем инициализирует Workspace.

## Проверки

Для новой операции проверьте её пользовательский сценарий и существенные ошибки.
Общий тест `apps/cli/test/cli-ux.test.ts` обходит зарегистрированные команды и проверяет
справку без конфига. Изменения записи должны сохранять конкурентные гарантии;
изменения списка — байтовый бюджет и курсоры в обоих форматах.

Обновите [руководства](../guides/README.md) и [справочник команд](../reference/CLI.md),
затем выполните из корня репозитория:

```bash
pnpm run build
pnpm run docs:check
pnpm --filter @oim-dev/relay-cli run typecheck
pnpm --filter @oim-dev/relay-cli run test
```
