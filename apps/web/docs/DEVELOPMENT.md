# Разработка Web

Эта страница помогает запустить и проверить SPA. Для обычной работы используйте
Web в поставке [Relay Server](../../server/README.md), а не отдельный frontend-сервис.
Владельцы кода описаны в [архитектуре](ARCHITECTURE.md), пользовательские пути — в [USAGE](USAGE.md).
Обязательные правила для исполнителей, включая QA, закреплены в [AGENTS.md](../AGENTS.md):
строгое применение React Reference и Unit Architecture, подготовка, генерация и приёмка.
Ниже приведены способы установки, запуска и проверки, а не отдельный набор обязательств.

## Окружение и зависимости

Для разработки используйте Node.js 24 и pnpm из корневого `packageManager`.
Точные версии и команды принадлежат [корневому manifest](../../../package.json)
и [manifest Web](../package.json), а не копии списка зависимостей в инструкции.

Текущий стек: React, TypeScript/Vite, Mantine Core/Form/Hooks/Notifications,
React Router, SWR, dnd-kit, CodeMirror, react-markdown/remark-gfm, React Flow,
ELK, lucide-react, Zod и Day.js. Contracts и REST SDK — workspace-зависимости.
PostCSS и ESLint входят в инструменты сборки. Наличие технологии в общем reference
не означает её установки в Web: например, отдельный Zustand store здесь не требуется.

## Запуск на своих данных

Из корня репозитория:

```bash
pnpm install --frozen-lockfile
RELAY_CONFIG=/absolute/path/to/project/.relay/config.json pnpm run dev
```

Для workspace передайте путь к `relay.workspace.json`. Без `RELAY_CONFIG`
корневые `dev` и `dev:server` используют локальный тестовый проект
`apps/playground/.relay/config.json`; его нужно заранее инициализировать, запуск
не создаёт данные. Работа в UI меняет подключённые проектные данные, а не изолированный мок.
Подробнее — в [инструкции разработки](../../../scripts/README.md#запуск-из-корня-репозитория).
Инициализация и подключение проекта — в [начале работы](../../../docs/guides/GETTING_STARTED.md),
параметры — в [конфигурации runtime](../../../packages/project-runtime/docs/CONFIGURATION.md).

Можно запустить `pnpm run dev:server` и `pnpm run dev:web` в разных терминалах.
`dev:web` не запускает API. Vite по умолчанию слушает 5173 и проксирует `/api`
на `http://127.0.0.1:4700`; занятый Web-порт вызывает ошибку (`strictPort`).

- `RELAY_CONFIG` — серверная конфигурация проекта/workspace.
- `RELAY_PORT` — серверный порт.
- `RELAY_API_URL` — адрес назначения Vite-прокси.
- `RELAY_WEB_PORT` — порт Vite.

Пример с отдельными портами:

```bash
RELAY_CONFIG=/absolute/path/to/project/.relay/config.json RELAY_PORT=4711 RELAY_API_URL=http://127.0.0.1:4711 RELAY_WEB_PORT=5174 pnpm run dev
```

При раздельном запуске согласуйте эти переменные между процессами; `RELAY_WEB_PORT`
передавайте и серверу. Для проверок используйте временные данные и собственные свободные
порты, не процессы или профиль браузера другого пользователя.

## Источники инструкций и создание компонентов

Dev-навыки устанавливаются локально и не входят в чистый checkout. Подготовьте их
из корня репозитория:

```bash
pnpm run skills:install
```

Список восстановимых навыков и их источники закреплены в
[skills-lock.json](../../../skills-lock.json). Это навыки разработки, не пользовательский
Relay skill. После установки читайте следующие локальные пути от корня репозитория:

- React Reference — `.agents/skills/react-reference/SKILL.md`.
- Unit Architecture — `.agents/skills/unit-architecture/SKILL.md`.
- Профиль SPA — `.agents/skills/react-reference/reference/application/architecture/project-profile.md`.
- REST API Codegen — `.agents/skills/rest-api-codegen-ru/SKILL.md`, для REST-интеграции.

Исправления OpenAPI и генерация общего клиента описаны у
[REST SDK](../../../packages/rest-sdk/docs/DEVELOPMENT.md).
Не создавайте параллельный transport и не правьте generated-код вручную.

Для обязательной по [AGENTS.md](../AGENTS.md) генерации нового TSX используйте команды по
[локальным шаблонам](../.templates/README.md). Правила TSX после установки React Reference:
`.agents/skills/react-reference/reference/application/components/tsx-generation.md`.
До запуска прочитайте все файлы выбранного шаблона и проверьте отсутствие целевого каталога.
`ui-component` создаёт внутренний компонент, `ui-unit` — самостоятельный юнит с фасетом.
Для работы над шаблонами используйте навык `template-generation` по доступности:
`.agents/skills/template-generation/SKILL.md`. Его нет в `skills-lock.json`, поэтому
`skills:install` не гарантирует его наличия в чистом checkout. Это не отменяет
обязательного использования генератора и существующих локальных шаблонов.

Из корня репозитория через script `create`, закреплённый в manifest Web:

```bash
pnpm --filter @relay/web run create ui-component <имя> <каталог-владельца>
pnpm --filter @relay/web run create ui-unit <имя> <каталог-владельца>
```

Каталог владельца задаётся относительно `apps/web`. Адаптируйте назначение, props,
DOM, стили и экспорты сразу; не сохраняйте искусственную обёртку или неиспользуемый фасет.
Существующий TSX редактируется без перегенерации. Генератор не запускают поверх
существующей реализации. Script использует `@gromlab/create@0.2.0`;
из каталога `apps/web` тот же запуск доступен через `pnpm run create`.

## Проверки изменения приложения

Из корня репозитория:

```bash
pnpm run lint:web
pnpm run typecheck:web
pnpm run build:web
```

Turbo собирает необходимые зависимости; результат Web — `apps/web/dist`.
Поставка SPA принадлежит Server, Vite — только разработке. При уже собранных Contracts/SDK
для точечной проверки доступны `pnpm --filter @relay/web run lint` и
`pnpm --filter @relay/web run typecheck`.

ESLint проверяет hooks, доступность и часть стиля, но не доказывает корректность
свёрнутого графа Unit Architecture. Проверяйте владельцев, фасеты, циклы и CSS отдельно.
Сборка проверяет lazy-модули, PostCSS и Worker, но не выполнение пользовательского пути.
Автотесты фронтенда в общем случае не добавляются; не вводите Vitest только по общему
reference. Узкое исключение — браузерные регрессии экрана «Обзор», которые пользователь
явно потребовал для этой фичи; они описаны ниже. Исключение не разрешает unit-,
компонентные или snapshot-тесты Web и новый тестовый стек.

Для изменённого UI нужна отдельная браузерная приёмка через agent-browser:

```bash
pnpm --filter @relay/web run browser --help
pnpm --filter @relay/web run browser --session tasks-web-my-check open http://127.0.0.1:5174
pnpm --filter @relay/web run browser --session tasks-web-my-check snapshot -i
pnpm --filter @relay/web run browser --session tasks-web-my-check a11y
pnpm --filter @relay/web run browser --session tasks-web-my-check console
pnpm --filter @relay/web run browser --session tasks-web-my-check errors
pnpm --filter @relay/web run browser --session tasks-web-my-check close
```

Каждый запуск использует уникальное имя сессии и headless-конфигурацию
[agent-browser.json](../agent-browser.json). После действий получайте свежие refs;
при SSE ожидайте конкретное состояние, не `networkidle`.
Проверяйте обе темы, ширины 1440/1024/768/390, клавиатуру, фокус, Escape, reduced motion,
прямой URL и Back/Forward, reload, черновик, ошибку, конфликт, SSE и изоляцию A → B → A.
Для списков важны продолжение и сохранность показанного объёма/прокрутки.
Завершайте только свои сессии и процессы. Детальная справка — [agent-browser commands](https://agent-browser.dev/commands).

### Браузерные регрессии

Сценарии экрана «Обзор» проверяются автоматически в [test/e2e](../test/e2e) на `node:test`
и agent-browser: прямой URL и Back/Forward, обновление по SSE после записи через HTTP
и local CLI, объединение уведомлений, разрыв и переподключение, `workspace-error`,
поздний ответ и изоляция A → B → A, ошибки REST и невалидный ответ, сохранение фокуса
и прокрутки, ширины и темы, раскрытие групп «Требует внимания» до задач всех досок
и каталога досок сверх подборки, сохранение второй страницы каталога из более чем 50 досок
и фокуса при обновлении по SSE, чтение полного списка только по действию с ошибкой
и повтором, «Загрузить ещё» и сворачиванием, якоря плиток, проект без паспорта, архивные документы,
планы и релизы всех состояний, клавиатура Tab/Enter, отсутствие записи при чтении
и освобождение потоков.

```bash
pnpm exec agent-browser install
pnpm run test:web:e2e
```

Первая команда один раз устанавливает Chrome for Testing (на Linux — с `--with-deps`).
Корневая `test:web:e2e` собирает Server (вместе с Web) и CLI, затем запускает
`pnpm --filter @relay/web run test:e2e`; при готовых `dist` можно вызвать эту команду
напрямую. Suite не входит в `pnpm run test` и `check`; в CI его выполняет отдельная
обязательная стадия, см. [scripts](../../../scripts/README.md).

Каждый запуск поднимает собственные Server, Vite и управляющий HTTP-прокси на свободных
портах и создаёт временный workspace из пяти проектов в `.artifacts/web-e2e-*`.
Пользовательские базы, Playground и профиль браузера не используются; сессия
agent-browser — `tasks-web-overview-<pid>`. После прогона harness закрывает сессию
и процессы и удаляет временный workspace; скриншоты остаются в `.artifacts/web-e2e-screens`.

Дочерние процессы получают `NO_COLOR=1`: в CI переменная `CI` иначе включает цвета
в выводе Vite, и строка готовности не распознаётся. Если стенд не поднялся, шаг и хвосты
вывода Server/Vite/agent-browser сразу печатаются в stderr с префиксом `[web-e2e]`,
процесс без готовности (60 с) останавливается, а `after` независимо закрывает сессию браузера
(при необходимости завершая её демон), Vite, прокси, Server и остальные процессы — набор
падает за минуту-две и не зависает. Флаги Chrome при необходимости передаются через
`AGENT_BROWSER_ARGS`, например `--no-sandbox` в контейнере.
Новые регрессии добавляйте в тот же harness, не подключая другой тестовый стек.

## Проверки только документации

Markdown-изменение без изменения приложения не требует запуска серверов, баз или браузера.
Сверьте спорные подписи, actions и маршруты с исходниками и явно отделите статическую
сверку от проверенного исполнения. Запустите адресные проверки:

```bash
pnpm exec prettier --check apps/web/README.md apps/web/docs/*.md
git diff --check -- apps/web/README.md apps/web/docs
node --input-type=module -e 'import { checkDocumentation } from "./apps/cli/scripts/lib/documentation.mjs"; console.log(await checkDocumentation(process.cwd(), ["apps/web/README.md", "apps/web/docs/ARCHITECTURE.md", "apps/web/docs/ROUTING.md", "apps/web/docs/DEVELOPMENT.md", "apps/web/docs/USAGE.md"]));'
```

Общие правила и единственный реестр покрытия —
[DOCUMENTATION](../../../docs/DOCUMENTATION.md) и [CAPABILITIES](../../../docs/CAPABILITIES.md).
Локально описывайте путь человека и ограничения, не создавайте вторую матрицу готовности.
