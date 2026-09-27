# Совместный выпуск Relay

Канонический процесс сборки, проверки и публикации самого Relay: CLI, Server и MCP.
Это инженерная поставка npm-пакетов, а не [проектные записи релизов](../../docs/domain/RELEASES.md)
в пользовательской памяти Relay. Подготовка окружения — в [инструкции разработки](../README.md).
Коммиты, push и публикация выполняются только по отдельному запросу согласно
[общим правилам репозитория](../../AGENTS.md); подготовка архивов этих действий не выполняет.

## Состав и источник версии

| Пакет                   | Манифест                                 | Каталог готового архива       |
| ----------------------- | ---------------------------------------- | ----------------------------- |
| `@oim-dev/relay-cli`    | [CLI](../../apps/cli/package.json)       | `apps/cli/.artifacts/npm/`    |
| `@oim-dev/relay-server` | [Server](../../apps/server/package.json) | `apps/server/.artifacts/npm/` |
| `@oim-dev/relay-mcp`    | [MCP](../../apps/mcp/package.json)       | `apps/mcp/.artifacts/npm/`    |

Все три пакета выпускаются с одной полной версией, включая prerelease-суффикс,
даже если изменился только один компонент. Текущая версия определяется манифестами,
а не номером в этой инструкции:

```bash
pnpm run release:check
```

Опорной служит версия CLI; Server и MCP должны совпадать с ней. Общий Git-тег —
`v<version>`, имя архива — `oim-dev-relay-<component>-<version>.tgz`.
Стабильная версия публикуется в `latest`, предварительная — в `next`.
Смешанные версии не считаются проверенным совместимым комплектом.
Корень и workspaces `@relay/*` приватны и отдельно не публикуются.

Основной путь — событие GitHub **release.published** и npm Trusted Publishing через
OIDC. Ручная публикация с локальной авторизацией — fallback, не обязательный первый
этап каждого выпуска. Настройки доступа npm/GitHub не подтверждаются наличием workflow.

## Подготовка версии и окружения

Все команды ниже запускаются из корня Relay. `<version>`, `<commit>` и `<bundle-dir>`
— заменяемые значения, не выбранные версия, коммит или каталог. Аргументы `pnpm run`
передаются без дополнительного `--`.

1. Выберите новую версию и канал, проверьте доступность номера у всех трёх пакетов:

   ```bash
   npm view @oim-dev/relay-cli versions dist-tags --json --registry https://registry.npmjs.org
   npm view @oim-dev/relay-server versions dist-tags --json --registry https://registry.npmjs.org
   npm view @oim-dev/relay-mcp versions dist-tags --json --registry https://registry.npmjs.org
   ```

   Только отсутствие пакета/версии (`404`) означает отсутствие; ошибка сети или доступа
   не означает свободный номер. Проверьте также, что новый Git-тег свободен и целевой
   dist-tag не указывает на более новую версию. Частично опубликованный комплект
   восстанавливается по [правилам повтора](#повтор-и-диагностика), а не как новый выпуск.

2. Если версия ещё не подготовлена, обновите три манифеста:

   ```bash
   pnpm run release:version <version>
   ```

   Команда принимает SemVer без build metadata (`+…`), но не проверяет свободу номера
   или его увеличение. Она не создаёт коммит или тег. Добавьте непустой раздел
   `## <version>` в каждый `apps/{cli,server,mcp}/CHANGELOG.md`; для неизменённого
   компонента опишите совместный выпуск.

3. Для окончательных проверок используйте отдельный чистый checkout выбранного
   релизного коммита, без прежних `dist` и `.artifacts`. Например, после подготовки
   коммита можно создать отдельный worktree:

   ```bash
   git worktree add --detach ../relay-release <commit>
   ```

   Перейдите в его корень. Не очищайте чужую рабочую копию через reset/clean.
   Используйте Node.js 24, pnpm из `packageManager` и npm 11.16.0, как в CI упаковки:

   ```bash
   git status --short
   git rev-parse HEAD
   node --version
   pnpm --version
   npm --version
   pnpm exec npm --version
   pnpm install --frozen-lockfile
   ```

   Ожидаются выбранный SHA и отсутствие локальных изменений. Нужны доступ к registry,
   Git, `tar`, место для сборки и свободные локальные порты для smoke.
   При несовпадении npm подготовьте нужную версию в выделенном окружении;
   `pnpm exec npm --version` проверяет именно npm, который использует обёртка публикации.

## Проверка и упаковка

```bash
pnpm run release:check v<version>
pnpm run release:notes v<version>
pnpm run agents:check
pnpm run skills:check
pnpm run build
pnpm run check
pnpm run package:check
git status --short
```

`release:check` проверяет состав публичных пакетов, версии и соответствие строки тега.
Он **не проверяет существование Git-тега или его привязку к коммиту**.
`release:notes` читает три CHANGELOG и выводит объединённое описание, но не создаёт
GitHub Release. Обе команды работают и напрямую через `node scripts/release/relay.mjs`
с действиями `check`/`notes`, без установки зависимостей.

Проверки сохранённых agents/skills выполняются до сборки, чтобы не скрыть drift.
Их содержание и восстановление описаны у [dev-agents](../../packages/dev-agents/README.md)
и [relay-skill](../../packages/relay-skill/README.md). `check` включает release-тесты,
форматирование, проверки генераторов и документации, lint, типизацию и тесты workspaces.

[Упаковщик](../package.mjs) читает скомпилированный JS из `dist`, сохраняя результаты
компиляции, в том числе серверные metadata декораторов. Используемые приватные runtime
пакеты включаются в bundle; внешние production-зависимости остаются в манифесте.
В поставке не должно быть `workspace:`, `file:`, `link:`, scripts и devDependencies.
Server включает Web в `dist/web`; CLI/MCP не включают серверный runtime.

Staging создаётся в `apps/<component>/.artifacts/package`, проверенный архив —
в `apps/<component>/.artifacts/npm`. Состав документации берётся из `files` манифестов
приложений; проверяются файлы и байты готовой поставки. CLI-документы обслуживаются
у [CLI](../../apps/cli/README.md), а не копируются вручную в staging.
Прямой prepack приложения останавливается с указанием штатной упаковки.

`package:check:cli`, `package:check:server`, `package:check:mcp` строят и упаковывают
отдельный компонент. Полный `package:check` дополнительно запускает
[smoke-relay.mjs](../smoke-relay.mjs): независимые npm-установки трёх архивов,
версии и bin-команды, документацию, CLI local/HTTP, Web/Swagger/API, workspace A/B,
MCP и отказ клиента после остановки Server. Проверка использует изолированные данные,
не пользовательский Playground.

Повтор установки уже готовых архивов без сборки:

```bash
pnpm run package:smoke
```

Эта команда не требует установки зависимостей монорепозитория, но требует готовых
архивов и окружения для их независимой установки. Она не заменяет остальные проверки.
Любое изменение исходников после QA требует нового проверенного комплекта.

## Публикация через GitHub Release

Точные механизмы: [ci.yml](../../.github/workflows/ci.yml),
[release.yml](../../.github/workflows/release.yml), [event.mjs](event.mjs),
[bundle.mjs](bundle.mjs), [publish.mjs](publish.mjs).

Push ветки и PR выполняют только проверки. Отправка тега и создание draft Release
не запускают npm publish. Сопровождающий создаёт GitHub Release отдельно для нового
`v<version>` выбранного коммита. До публикации Release проверьте:

```bash
git rev-parse HEAD
git rev-parse 'v<version>^{commit}'
```

SHA должны совпасть с выбранным релизным коммитом. Просмотрите workflow именно этого
коммита. Флаг GitHub prerelease должен быть выключен для stable и включён для prerelease.
Публикация Release запускает последовательность:

1. **metadata**: проверяет `release.published`, репозиторий, отсутствие draft,
   тег, версии, CHANGELOG, совпадение checkout с коммитом тега и prerelease-флаг.
2. **ci**: вызывает reusable CI. Job `check` на Node.js 24 проверяет генераторы,
   затем `build` и `check`. Job `package` после него выполняет `package:check`
   с Node.js 24 и npm 11.16.0.
3. **publish**: скачивает только артефакт по точному `artifact_id`, возвращённому
   этим CI. Проверяет событие и весь bundle, затем публикует готовые архивы без
   установки зависимостей монорепозитория, пересборки или повторной упаковки.

CI хранит один артефакт **npm-packages**: ровно три `.tgz` и `manifest.json`.
Ведомость содержит schema, commit SHA, тег, имена/версии пакетов, имена файлов и
SHA-512 integrity. Пустой ID запрещает загрузку; несовпадение digest при скачивании
останавливает job. Внутренняя проверка повторно сверяет ведомость, байты и метаданные
архивов. Артефакт хранится 14 дней; для отложенного retry сохраните весь исходный
комплект с ведомостью до истечения срока.

Publisher находится непосредственно в `release.yml`, использует environment `npm`.
Общие права workflow — `contents: read`; только publisher получает `id-token: write`.
`contents: write`, npm-токены и создание GitHub Release внутри publisher не нужны.
Цель публикации фиксирована: `https://registry.npmjs.org`, доступ `public`.
В GitHub Actions обёртка передаёт `--provenance`.

### Настройка доверия

Для каждого npm-пакета проверьте Trusted Publisher:

| Поле                 | Значение                       |
| -------------------- | ------------------------------ |
| Publisher            | GitHub Actions                 |
| Organization or user | `oim-dev`                      |
| Repository           | `relay`                        |
| Workflow filename    | `release.yml`                  |
| Environment name     | `npm`                          |
| Allow npm publish    | Включено для прямой публикации |

В GitHub должен существовать environment `npm`; фактические ограничения тегов
и reviewer-настройки проверяются в настройках репозитория, а не выводятся из его имени.
В каждом архиве `repository.url` должен быть `git+https://github.com/oim-dev/relay.git`.
Не добавляйте токены или `npm login` в publishing job: npm использует OIDC.
Не отключайте 2FA ради выпуска. Права npm и GitHub независимы.

Официальные требования и ограничения: [npm Trusted Publishing](https://docs.npmjs.com/trusted-publishers/),
[npm publish](https://docs.npmjs.com/cli/v11/commands/npm-publish),
[GitHub release event](https://docs.github.com/en/actions/reference/workflows-and-actions/events-that-trigger-workflows#release).
Успешные локальные тесты и `npm whoami` не проверяют OIDC-обмен.

## Проверенный bundle и ручной fallback

Для проверки сохранённого комплекта используйте checkout того же коммита:

```bash
node scripts/release/bundle.mjs verify "<bundle-dir>"
node scripts/release/bundle.mjs restore "<bundle-dir>"
pnpm run package:smoke
```

`verify` не пишет файлы. `restore` сначала проверяет весь комплект и только затем
копирует те же байты в каталоги архивов приложений, заменяя одноимённые файлы.
Используйте выделенный checkout. Если задан `RELEASE_TAG`, он должен соответствовать
ведомости; иначе тег определяется из манифестов. Проверка SHA в ведомости не доказывает
чистоту исходного checkout или выполнение QA сама по себе.

Для сохранения локально проверенных архивов можно выполнить:

```bash
node scripts/release/bundle.mjs create "<bundle-dir>"
```

Каталог должен быть пустым. `create` копирует архивы и создаёт ведомость, но **не
выполняет QA и не устанавливает достоверность происхождения**. Для retry сохранённого
CI-артефакта создавать новую ведомость не нужно.

При ручном fallback исключите параллельный CI/локальный publisher и проверьте
существующую авторизацию без чтения токена:

```bash
npm whoami --registry https://registry.npmjs.org
```

Аккаунт должен иметь право записи на каждый пакет; `whoami` этого не доказывает.
Не сохраняйте credentials в репозитории и не выводите значения токенов.
После подготовки и проверки исходных архивов команда публикации:

```bash
pnpm run release:publish v<version>
```

Она последовательно публикует CLI, Server и MCP из `apps/*/.artifacts/npm`, без сборки,
создания тега или GitHub Release. Используйте `pnpm run`: npm-обёртке нужен заданный
менеджером `npm_execpath`. Локально `RELAY_RELEASE_BUNDLE` **не переключает источник**
архивов — предварительно выполните `restore`. В CI эта переменная обязательна,
а `release:publish` сам проверяет и восстанавливает bundle перед публикацией.

До первой записи проверяются все архивы и registry. Уже существующая версия
пропускается лишь при совпадении integrity и канала. После публикации повторно
сверяются integrity и dist-tags всего комплекта. Quality gates сама команда не повторяет.
Не заменяйте этот процесс `npm publish` из каталогов приложений или workspaces.

## Подтверждение результата

После публикации проверьте именно выбранную версию:

```bash
npm view @oim-dev/relay-cli@<version> version dist.integrity --json --registry https://registry.npmjs.org
npm view @oim-dev/relay-server@<version> version dist.integrity --json --registry https://registry.npmjs.org
npm view @oim-dev/relay-mcp@<version> version dist.integrity --json --registry https://registry.npmjs.org
```

`dist.integrity` должен совпасть с SHA-512 исходного архива в формате
`sha512-<base64>`, а `latest`/`next` — с выбранной версией у всех пакетов.
Каналы проверяются командами `npm view … versions dist-tags` из подготовки.
Для OIDC-выпуска проверьте также provenance в npm и его связь с ожидаемым workflow
и коммитом; совпадение repository URL не заменяет provenance.

Обычные пользовательские точки входа вне checkout:

```bash
npx @oim-dev/relay-cli --help
npx @oim-dev/relay-server --help
npx @oim-dev/relay-mcp --help
```

Эти команды без версии проверяют текущий стандартный канал, а не обязательно
конкретный prerelease. Для приёмки выбранного выпуска установите именно его три
архива из registry в изолированное окружение и сверьте установленные версии.
Пользовательская эксплуатация описана у приложений; этот документ не заменяет её.
Зелёный CI, готовый артефакт или один опубликованный пакет не подтверждают весь выпуск.

## Повтор и диагностика

- **Частичная публикация или неясный сетевой сбой.** npm-публикация не атомарна.
  Сначала прочитайте состояние registry, сохраните исходные `.tgz` и ведомость.
  Повторяйте publisher с тем же `artifact_id` и байтами, не весь pipeline с новой
  упаковкой. Если точный артефакт недоступен, восстановите сохранённый bundle через
  `verify`/`restore` и используйте ручной fallback. Не запускайте публикации параллельно:
  группа CI `relay-npm-publish` не блокирует локальные процессы.
- **Integrity не совпала.** Остановитесь до новых записей. Повторно скачайте точный
  артефакт и проверьте его digest и ведомость; не редактируйте хеши ради прохождения
  проверки. Другие байты с уже опубликованным номером требуют новой версии.
- **Неизвестно происхождение архивов.** Имя файла, совпадение версии и свежая ведомость
  не доказывают QA. До первой публикации подготовьте комплект из выбранного чистого
  коммита и пройдите проверки. После частичной публикации не подменяйте утраченный
  комплект пересборкой: сначала установите происхождение сохранённых байтов и состояние
  registry; если это невозможно, остановите повтор и подготовьте новый выпуск.
- **Канал отличается или новее.** Скрипт не исправляет dist-tags автоматически
  и не откатывает канал. Выясните состояние выпуска; изменение канала — отдельная
  операция registry, после которой нужна повторная сверка всех пакетов.
- **Ошибка чтения registry после записи.** Она не доказывает отсутствие публикации.
  Не выбирайте новую версию и не пересобирайте архивы только из-за потерянного ответа.
- **Нет artifact ID, истёк срок или неверный commit/tag.** Не скачивайте все артефакты
  по имени и не меняйте SHA в ведомости. Найдите исходный комплект и checkout его
  коммита. Восстановление не должно подменять источник артефакта.
- **OIDC/provenance не подтверждены.** Сверьте publisher каждого пакета, workflow,
  environment, права job, npm и repository в архиве. Не добавляйте токен как скрытый
  обход и не объявляйте происхождение подтверждённым только по успешной загрузке.
- **Падает упаковка или smoke.** Диагностируйте компонент адресным `package:check:*`,
  затем повторите полную установочную проверку. Не публикуйте непроверенный комплект.
