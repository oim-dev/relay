# Общая конфигурация TypeScript

Приватный пакет `@relay/typescript-config` экспортирует [base.json](base.json)
для Node-потребителей Relay. Это настройки компилятора, не runtime-библиотека
и не самостоятельный npm-продукт. Собственных build/test scripts у пакета нет.

## Подключение

Потребитель объявляет `@relay/typescript-config` как `workspace:*` в devDependencies
и расширяет базу:

```json
{
  "extends": "@relay/typescript-config/base.json",
  "compilerOptions": {
    "rootDir": "src",
    "outDir": "dist"
  },
  "include": ["src/**/*.ts"]
}
```

База задаёт ES2023, NodeNext для модулей и разрешения импортов, типы Node,
строгую типизацию, `noUncheckedIndexedAccess`, `exactOptionalPropertyTypes`,
проверки неиспользуемых переменных и параметров, `verbatimModuleSyntax`.
Пути исходников/выходов, declarations, decorators и специальные dev/test-настройки
остаются у потребителей. База не задаёт межпакетный порядок сборки или алиасы исходников.

## Изменение и проверка

Текущие потребители: CLI, Server, MCP, Core, Contracts, project-runtime и server-runtime.
Web и REST SDK не следует считать потребителями автоматически: проверяйте их `extends`.
Общее изменение проверяется на всех наследующих конфигурациях:

```bash
pnpm run build
pnpm run typecheck
```

Для изменения, влияющего на испускаемый JavaScript, дополнительно выполните тесты
затронутых приложений; для runtime-поставки — `pnpm run package:check`.
Успешная типизация не проверяет поведение ESM или серверных metadata декораторов.
Ошибка разрешения базовой конфигурации обычно требует установки workspace-зависимостей,
а не копирования базы в приложение. Окружение и порядок задач — в
[инструкции разработки](../../scripts/README.md).
