# Дизайн-система Web

Документ описывает фактическую визуальную систему Relay Web: тему, токены, общие
UI-юниты, шаблоны экранов, галерею и допустимые исключения. Владельцы слоёв и путь
данных — в [архитектуре Web](ARCHITECTURE.md), запуск и проверки — в
[разработке](DEVELOPMENT.md). Вход в приложение — [README](../README.md).

Характер интерфейса: спокойные нейтральные поверхности, одна светлая сцена на внешнем
фоне, крупная типографика только у сводных показателей и один брендовый акцент —
ультрамарин. Основное действие нейтральное (графит в светлой теме, светлое в тёмной);
акцент показывает текущую работу, выбор, ссылку и акцентный прогресс. Ошибка,
предупреждение и успех имеют собственные смысловые цвета и всегда дублируются текстом
или значком. Декор не несёт обязательного смысла.

Стек не расширяется: Mantine, CSS Modules с PostCSS, Inter Variable из
`@fontsource-variable/inter` и иконки lucide-react. Второй шрифт, библиотека
компонентов, Storybook и анимированные градиенты не используются.

## Тема

Тема принадлежит юниту [ui/themes](../src/ui/themes); `app` подключает только его
`ThemeProvider`. Схему (light/dark/auto) выбирает Mantine, по умолчанию `auto`;
`useThemeColorScheme` — публичный хук переключения. Тема устроена в три слоя.

1. **Палитры и шкалы Mantine** — только в
   [theme.config.ts](../src/ui/themes/config/theme.config.ts): нейтральные `gray` и `dark`,
   акцент `ultramarine` (`#3e5bff`, в тёмной схеме оттенок 4), `jade` для выполнения,
   прежняя `teal`, стандартные `orange`, `red`, `blue`, `grape` и `cyan`. Смысловые имена
   `accent`, `success`, `danger`, `warning`, `info` — те же палитры для свойства `color`.
   Hex-значения существуют только здесь.
2. **Цветовые роли `--tasks-*`** вычисляет `cssVariablesResolver` в
   [color-roles.config.ts](../src/ui/themes/config/color-roles.config.ts) для каждой схемы.
   Производные смешиваются в sRGB при создании темы (`helpers/srgb-color.ts`) и выдаются
   обычными hex/`rgba()`: роли не зависят от `light-dark()` и `color-mix()` в браузере.
3. **Геометрия, типографика и движение** — CSS-токены в
   [variables.css](../src/ui/themes/styles/variables.css); адаптивные значения меняются
   там же по `@custom-media` из [media.css](../src/ui/themes/styles/media.css).

### Цветовые роли

| Группа         | Роли                                                                                                                                                                                                   |
| -------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Поверхности    | `canvas`, `chrome`, `surface`, `surface-quiet`, `raised`, `subtle`, `border`, `border-strong`, `selected`, `selected-border`                                                                           |
| Уровни сцены   | `backdrop` (внешний фон), `stage` (сцена), `card` (панель), `tile`, `tile-hover`, `tile-border` (строка), `tile-translucent`                                                                           |
| Текст          | `ink`, `muted`, `soft`, `neutral-text`; инверсия — `inverse-surface`, `inverse`, `inverse-muted`, `inverse-accent`                                                                                     |
| Акцент         | `accent`, `accent-hover`, `accent-ink`, `accent-subtle`, `accent-contrast`; ссылки `highlight*` на акцент                                                                                              |
| Действия       | `action-primary`, `action-primary-hover`, `action-primary-text`, `action-disabled`, `action-disabled-text`, `action-disabled-border`                                                                   |
| Поля           | `field-border` — граница поля и неотмеченного checkbox, не ниже 3:1 к заливке поля и к панели `card` (светлая 4.0/3.34, тёмная 5.21/5.86)                                                              |
| Состояния      | `success`, `warning`, `danger`, `info` с `-surface` и `-border`; `status-contrast` — текст на их заливке; `tone-<тон>-filled-hover` и `tone-<тон>-light-hover` — наведение вариантов Mantine           |
| Взаимодействие | `focus-ring`, `selection`, `search-mark`, `nav-current-surface`, `nav-current-ink`                                                                                                                     |
| Данные         | `column-inbox`, `column-ready`, `column-in-progress`, `column-review`, `column-done`, `column-cancelled`, `column-cancelled-fill`, `completed`, `blocked`, `chart-track`, `progress`, `progress-track` |
| Показатели     | `icon-chip-highlight`, `icon-chip-hatch`, `icon-chip-inverse` — подложки иконок метрик                                                                                                                 |
| Декор          | `feature-surface`, `feature-image`, `feature-fade-image`, `hatch-surface`, `hatch-image`, `card-fade-image`                                                                                            |
| Тени           | `card-shadow`, `card-hover`, `raised-shadow`                                                                                                                                                           |

`warning-ink` — совместимый псевдоним `warning`. Семантика колонок задач: «Входящие» —
нейтральная, «К выполнению» — grape, «В работе» — акцент, «На проверке» — warning,
«Готово» — success, «Отменено» — бледная нейтральная с отличием формы.

Резолвер также связывает с ролями переменные Mantine: текст, поверхности, `dimmed`,
`placeholder`, `anchor`, `error`, `success`, `disabled`, нейтральную заливку `gray` и
виртуальные цвета палитр состояний (`-filled`, `-light`, `-outline`, `-text`). Поэтому
`color="danger"` у Button, Badge, Alert, Notification и `c="danger"` у текста дают роль
`danger`; прежние имена палитр отображаются так же (`red` → `danger`, `orange`/`yellow` →
`warning`, `green`/`jade`/`teal` → `success`, `blue` → `info`, `ultramarine` → `accent`).
`c="dimmed"` — роль `muted`. Новый код использует смысловые имена.

Правила:

- CSS Modules и свойства компонентов используют роли и токены, без hex/rgb/hsl,
  `light-dark()`, `color-mix()` и прямых `--mantine-color-*`. Локальная переменная
  допустима как ссылка на роль: `--stage-color: var(--tasks-column-done)`.
- Прозрачность и смешение задаются в теме отдельной ролью, а не в компоненте.
- Новая роль добавляется в `buildColorRoles` со значениями обеих схем, получает пример в
  галерее и проверку контраста: обычный текст ≥4.5:1, крупный текст, значимые границы
  контролов, индикаторы и фокус ≥3:1. Декоративная граница двух панелей не обязана иметь 3:1.
- Смена акцента — правка записи `ACCENT` или палитры `ultramarine`: производные
  (`accent-*`, `inverse-accent`, `selection`, `search-mark`, `progress-track`, градиент
  главной панели, `highlight*`, `column-in-progress`) пересчитываются без правки экранов.

### Типографика, геометрия и движение

| Назначение          | Токен или шкала                                                   | Значение                                 |
| ------------------- | ----------------------------------------------------------------- | ---------------------------------------- |
| Заголовок страницы  | `h1`, `--tasks-font-size-page-title`                              | 28px, от 768px 32px; 1.15; 700           |
| Заголовок панели    | `h2`/`h3`, `--tasks-font-size-panel-title`                        | 18px, от 768px 20px; 1.25; 700           |
| Заголовок записи    | `h4`, `--tasks-font-size-record-title`                            | 15px; 1.35; 650                          |
| Интерфейс и подписи | `fontSizes` Mantine `md`/`sm`/`xs`                                | 14 / 13 / 12px; 12px — нижняя граница    |
| Чтение Markdown     | `--tasks-font-size-reading`, `--tasks-reading-measure(-max)`      | 15px; 1.7; 70ch, максимум 80ch           |
| Главное число       | `--tasks-font-size-metric-min/max`, `--tasks-line-height-metric`  | 28–36px, от 1024px 36–44px; tabular-nums |
| Расстояния          | `--tasks-space-1…12`, `spacing` Mantine                           | 4, 8, 12, 16, 20, 24, 32, 40, 48px       |
| Радиусы             | `--tasks-radius-control/compact/row/metric/panel/stage/pill`      | 8 / 12 / 16 / 20 / 24 / 24→32px / pill   |
| Контролы            | `--tasks-control-height(-compact)`, `--tasks-touch-target`        | 36 / 32px; область нажатия 44px          |
| Длительности        | `--tasks-duration-control/panel/chart`, `--tasks-easing-standard` | 140 / 200 / 300ms                        |
| Поля страницы       | `--tasks-page-gutter`                                             | 16px, от 768px 32px                      |
| Запас под панелью   | `--tasks-sticky-actions-clearance`                                | 160px, от 768px 96px                     |

Радиус `md` Mantine (8px) — контрол и поле, `lg` — компактный контейнер, `xl` — строка;
pill — бейджи, счётчики и короткие переходы. Иконки: 16px в действиях, 18–20px в
навигации, 24px у крупного состояния; декоративные скрыты от accessibility tree.
Monospace — только для кода и технических ключей. Базовый размер браузера не меняется.
Переходы отключаются при `prefers-reduced-motion` глобально (`index.css`) и
`respectReducedMotion` Mantine; бесконечная декоративная анимация не используется.
Hover строки меняет фон и рамку, не сдвигая её.
Форма с липкой нижней панелью действий (`document-form`, `documentation-form`,
`application-scope-form`, `implementation-editor`) задаёт документу
`scroll-padding-bottom: var(--tasks-sticky-actions-clearance)` через `html:has(...)`:
фокус по Tab и `scrollIntoView` не уводят поле под панель; `MarkdownField` передаёт тот же
запас прокрутке курсора CodeMirror.

Breakpoints Mantine и custom media совпадают: `--sm` 480, `--md` 768, `--lg` 1024,
`--xl` 1200, `--2xl` 1440px. Значение `useMediaQuery` не должно расходиться с CSS.

### Декор и устойчивость

Сплошная основа и изображение — разные роли. Потребитель задаёт `background-color` и
`background-image` раздельно и не перекрывает их поздним shorthand `background`:
невалидное или отключённое изображение оставляет основу и читаемость.

- Главная панель: `--tasks-feature-surface` + `--tasks-feature-image` (155deg, тон
  акцента → cyan, непрозрачные sRGB stops). Градиент — не больше одной главной области
  экрана; формы, Markdown, диалоги и поля его не получают.
- Каталог: `SectionPanel tone="feature-header"` ограничивает градиент шапкой 10rem с
  затуханием в основу; тело выдачи и строки сплошные при любой длине.
- Штриховка — только у метрики «На проверке»: `--tasks-hatch-surface` + `--tasks-hatch-image`.
- Затухание прокрутки — `--tasks-card-fade-image` и `--tasks-feature-fade-image`:
  прозрачный вариант того же конечного цвета, `pointer-events: none`.
- В `forced-colors` и печати image-роли и тени становятся `none`; панели и строки
  получают системную границу `CanvasText`. Глобальное `forced-color-adjust: none` не используется.

Новый CSS-синтаксис включается через `@supports` конкретного свойства поверх рабочей базы.
Понижение `cssTarget` в `vite.config.ts` не является способом совместимости.

### Компоненты Mantine и слои

Настройки в `theme.config.ts` и [controls.module.css](../src/ui/themes/styles/controls.module.css)
применяются автоматически; потребители не передают эти классы сами:

- Button и поля — размер `sm` (36px); ActionIcon — 32px, `subtle`, с областью нажатия
  44px на `pointer: coarse` (псевдоэлемент; обрезка `overflow` Mantine на touch снята вне
  загрузки); пункт Menu на touch — не ниже 44px.
- Граница поля и checkbox — `field-border`; фокус поля — кольцо цвета `focus-ring`
  (у `MarkdownField` тоже: рамка и тень 1px, ошибка — рамка `danger` вне фокуса);
  описание и ошибка поля — не меньше 12px. Глобальный `:focus-visible` — контур 2px.
- Checkbox и Tabs — `accent`; Badge — pill, 12px, без верхнего регистра, по умолчанию
  `color="gray"` (заливка `action-primary`, текст `action-primary-text` в обеих схемах);
  Alert — `light`; Menu, Popover, Modal, Notification — общие радиусы, тени и длительности.
- Кнопка закрытия Modal и Drawer по умолчанию называется «Закрыть»
  (`ModalCloseButton`/`DrawerCloseButton` в теме); потребитель уточняет имя через
  `closeButtonProps`, когда закрытие означает другое действие («Остаться в редакторе»).
- Ссылка `Anchor` и ссылка Markdown — `accent-ink`; в читаемом тексте потребитель задаёт
  `underline="always"`, отдельный переход подчёркивается при наведении.
- `<Progress variant="accent">` — акцентная полоса величины из
  [progress.module.css](../src/ui/themes/styles/progress.module.css); остальные `Progress`
  нейтральные.

Порядок слоёв задают средства Mantine: содержимое < sticky-шапка каркаса
(`--mantine-z-index-app`, 100) < Modal и Drawer (200) < выпадающие списки (300, в том числе
внутри диалога) < уведомления (`getDefaultZIndex("max")`). Подтверждение поверх окна —
второй Modal без собственного `zIndex`; Escape и фокус координирует владелец внешнего окна.
Экранные компоненты не задают глобальные z-index; допустимые локальные значения перечислены
в [исключениях](#обоснованные-исключения).

## Общие UI-юниты

Юниты `ui` не знают проектов, маршрутов, DTO и предметных статусов: подписи, ссылки,
действия и маппинг статуса на тон передаёт владелец. Импорт — через фасет `ui/<юнит>`.

| Юнит                                                                                                                           | Назначение и API                                                                                                                                                                                                                                                                                                                                                                                                    |
| ------------------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| [page-stage](../src/ui/page-stage)                                                                                             | Внешний фон и сцена шириной до 90rem. `layout="default"` — по высоте содержимого, в колонке каркаса не короче остатка окна; `"workspace"` — от 768px заполняет остаток высоты окна под шапкой каркаса, прокрутка принадлежит содержимому. Одна сцена на экран, без вложения                                                                                                                                         |
| [page-header](../src/ui/page-header)                                                                                           | Единственный h1: `title`, `titleRef` (программный фокус при входе), `meta` над заголовком, `description`, `actions` в раскладке `stack` (сведения и действия справа), `inline` (действия записи) или `toolbar` (поиск, фильтры, создание каталога)                                                                                                                                                                  |
| [section-panel](../src/ui/section-panel)                                                                                       | Смысловая панель: `title`, `titleAs` h2/h3, `titleRef`, `count` (ноль показывается), `countLabel`, `actions`, `description`, `tone` default/feature/feature-header, `density` default/compact                                                                                                                                                                                                                       |
| [record-row](../src/ui/record-row)                                                                                             | Строка записи: `title`, `code` (моноширинный ключ), `leading` (checkbox, значок), `meta`, `trailing` (бейдж, сведения, действия), `selected`, `component` div/li/article. Переход — ссылка внутри `title`, а не вся строка                                                                                                                                                                                          |
| [status-badge](../src/ui/status-badge)                                                                                         | Бейдж состояния: `tone` neutral/info/success/warning/danger, подпись (может содержать скрытый префикс), декоративная `icon`                                                                                                                                                                                                                                                                                         |
| [filter-chips](../src/ui/filter-chips)                                                                                         | Однозначный фильтр списка: группа кнопок `aria-pressed` с доступным `label`, `options` (подпись и необязательное число), `value`, `onChange`                                                                                                                                                                                                                                                                        |
| [state-panel](../src/ui/state-panel)                                                                                           | Состояние раздела: `state` loading/empty/error, `title`, `titleAs` h1/h2, `description`, `action`. Ошибка — `alert` со значком и тоном `danger`, загрузка — занятая область                                                                                                                                                                                                                                         |
| [markdown-view](../src/ui/markdown-view), [markdown-field](../src/ui/markdown-field), [markdown-link](../src/ui/markdown-link) | Чтение Markdown с мерой строки, редактор CodeMirror на ролях темы (`required` — звёздочка у подписи и `aria-required`, `withAsterisk` — только звёздочка, как у Mantine Input; `error` даёт `aria-invalid` и `aria-describedby`; `data-path` из `getInputProps` стоит на редактируемой области, поэтому `form.getInputNode(path)?.focus()` переводит фокус в редактор), внутренние ссылки через провайдер владельца |
| [input-draft](../src/ui/input-draft)                                                                                           | `useInputDraft(value, onCommit)` — локальный черновик поля, значение которого хранит адрес: быстрый ввод не теряет символы, внешние изменения (Back/Forward, ссылка, сброс) заменяют черновик. Все поля поиска каталогов используют его                                                                                                                                                                             |
| [kanban-dnd](../src/ui/kanban-dnd)                                                                                             | Столкновения и клавиатурные координаты перетаскивания доски                                                                                                                                                                                                                                                                                                                                                         |

### Правила выбора

- **Панель или строка.** Связанная информация собирается в `SectionPanel`; каждая запись
  каталога — `RecordRow` на тихой подложке панели. Каждую строку текста не превращают в карточку.
- **Навигация, действие, выбор.** Переход — ссылка, действие — кнопка, выбор — checkbox.
  Строка не становится кнопкой с вложенными кнопками и не обрабатывает клик целиком:
  текст строки остаётся выделяемым, действия в `trailing` — отдельными.
- **Фильтр.** `FilterChips` — одно значение фильтра каталога из короткого набора (до ~6)
  с числами, видимое сразу на панели (статус планов, релизов). `SegmentedControl` Mantine —
  переключение режима вида или области внутри панели и формы (граф/список, «все/выбранные»).
  `Checkbox` — независимые признаки, которые сочетаются, и массовый выбор строк.
- **Состояние.** `StatePanel` — первичная загрузка, пустота, отсутствие совпадений или
  записи и ошибка чтения. Обновление уже показанных данных не заменяет их полноэкранным
  состоянием; отказ записи сообщает `Alert` или уведомление сценария после ответа сервера.
- **Выдача прежнего фильтра.** Пока новый фильтр не получил ответа, прежняя выдача остаётся
  на месте с `aria-busy`, приглушена и без действий, счётчика, продолжения и пустого состояния.
  Ошибка нового фильтра показывается вместо прежних данных: их не выдают за результат.
- **Тон статуса.** `StatusBadge` получает только визуальный тон. Различие между колонкой
  «Готово», выполнением критериев и готовностью релиза сохраняется отдельными подписями.

### Владельцы тонов и отсутствующих записей

| Смысл                               | Владелец                                                                                                     |
| ----------------------------------- | ------------------------------------------------------------------------------------------------------------ |
| Статус материала                    | `DOCUMENT_STATUS_TONES` в `domains/documents`                                                                |
| Статус плана, задачи плана и релиза | `PLAN_STATUS_TONES`, `PLANNING_TASK_TONES` в `domains/planning`; `RELEASE_STATUS_TONES` в `domains/releases` |
| Колонка задачи                      | `tone` в `KANBAN_COLUMNS`/`TASK_COLUMNS` в `domains/board-tasks`                                             |
| Статус сущности графа               | `getEntityStatusTone` в `domains/entities`                                                                   |
| Материал не найден                  | `DocumentNotFoundError` в `domains/documents`                                                                |
| Запись продукта не найдена          | `ProductNotFoundError` в `domains/product`                                                                   |
| Задача не найдена                   | `BoardTaskNotFoundError` в `domains/board-tasks`                                                             |

Отсутствующая запись показывается `StatePanel` с возвратом к списку и без «Повторить»:
повтор чтения не вернёт удалённую запись. «Повторить» остаётся для сбоя сети или сервера.
Состав релиза показывает два бейджа: статус плана и фактическое выполнение
(`ReleasePlanItem.isReady` из `plan.ready` сервера), а не вычисляет готовность в Web.

## Шаблоны экранов

Каркас [project](../src/compositions/layouts/project) — flex-колонка на высоту окна:
липкая шапка с выбором проекта и индикатором подключения, хлебные крошки, боковая
навигация от 1024px и Drawer ниже. Экран внутри каркаса начинается с `PageStage`.

| Шаблон            | Композиция                                                                                                                       | Экраны                                                                                                                                                  |
| ----------------- | -------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Сводка            | `PageStage` → `PageHeader` → показатели → сетка `SectionPanel`; одна главная панель `feature`                                    | `overview`, `product-passport`                                                                                                                          |
| Каталог           | `PageStage` → `PageHeader actionsLayout="toolbar"` → разделы и выдача `SectionPanel` из `RecordRow` → продолжение                | `product-documents`, `product-features`, `product-applications`, `plans` и `releases` (каталог с деталями), `infrastructure`, `project-relations`       |
| Детали и редактор | `PageStage` → `PageHeader` с действиями записи → содержание → свойства и связи (aside 18–22rem на широком экране, ниже на узком) | `product-document`, `product-document-editor`, `product-feature`, `product-application(-scope)`, `product-entity`, `product-editor`, `project-settings` |
| Рабочее поле      | `PageStage layout="workspace"` или сцена без лишней рамки → шапка и контролы → поле с собственной прокруткой                     | `project-board` с окном задачи, `relation-context`                                                                                                      |

`relay` — выбор проекта вне каркаса проекта. `product-work` реализован, но не подключён
к дереву URL: его судьба — продуктовое решение. Доска и граф не ограничиваются шириной
читаемого документа, но их прокрутка не создаёт горизонтальную прокрутку страницы.
Собственный scroll допустим у длинного «Требует внимания» на desktop, боковой навигации,
содержимого Drawer и рабочих полей; остальные списки используют прокрутку страницы.

## Галерея

В dev-сборке маршрут `/dev/ui-kit` ([ui-kit](../src/compositions/screens/ui-kit)) показывает
реальные компоненты на фиксированных props без Server: пары ролей текст/фон, роли данных,
контролы Mantine в состояниях loading/disabled/invalid, `PageStage`,
`PageHeader`, варианты `SectionPanel`, `RecordRow` с checkbox и меню, `StatusBadge`,
`FilterChips` и `SegmentedControl`, `StatePanel`, Alert и уведомления, Modal, Drawer и
подтверждение поверх окна, Markdown, ссылки, крошки с длинным путём, прогресс и образцы
декора (сплошной, градиент, невалидное изображение) с переключателями схемы и декора,
а также `MarkdownField` с признаком обязательности.
Каждый пример указывает назначение, импорт и правило выбора варианта.

Маршрут подключается динамически только при `import.meta.env.DEV`, не входит в навигацию
и production-сборку. Новый общий компонент или роль добавляется в галерею вместе с
состояниями. `MarkdownField` загружает CodeMirror динамически при первом показе; его поведение
в форме дополнительно проверяется на экранах-редакторах.

## Обоснованные исключения

Остатки, найденные ревью-поиском по `color=`, `bg=`, hex, `--mantine-color-*`,
`light-dark`, `color-mix`, `gradient`, литеральным радиусам, мелким размерам шрифта,
длительностям и z-index, оставлены намеренно:

- **Тема.** Hex-палитры в `theme.config.ts`, `WHITE`/`BLACK` и вычисляемые градиенты в
  `color-roles.config.ts`, связывание `--mantine-color-*` с ролями в резолвере, числовые
  длительности Mantine (140/200ms) в `theme.config.ts`, совпадающие с токенами.
- **Галерея.** Атрибут `data-decor="gradient"` и образец невалидного изображения
  демонстрируют устойчивость декора.
- **Локальные слои.** z-index 1–5 внутри собственного контекста наложения владельца:
  липкие нижние панели форм редакторов (`document-form`, `documentation-form`,
  `application-scope-form`, `implementation-editor` — 5; `material-picker` — 1), липкая
  панель массовых действий библиотеки (2), липкие действия предпросмотра материала в
  Drawer (1), повтор поверх растянутой ссылки строки (`application-progress`, 1), ручка
  переноса карточки над её ссылкой (`task-card`, 1). Индикатор сохранения переноса
  доски — слой приложения Mantine, ниже окон.
- **Граф.** React Flow: `zIndex` рёбер 0/2 для выделенных связей, шаг сетки `Background`
  22px, толщины и прозрачность линий — геометрия рабочего поля; цвета — роли.
- **Доска.** `dropAnimation` dnd-kit принимает число: 200ms, как `--tasks-duration-panel`,
  отключается при reduced motion.
- **Формы точек.** `border-radius: 50%` у индикаторов и маркеров, 2px у квадратных
  маркеров этапов плана — форма данных, а не уровень вложенности.
- **Система.** `CanvasText` и другие системные цвета в `forced-colors`.
- **Forced colors на сводке.** Столбцы «Задачи по колонкам» на обзоре в режиме
  `forced-colors` не видны (заливка заменяется системным фоном); ограничение было до
  дизайн-системы, количество по колонкам остаётся в подписях.
- **Неустановленные платформы.** Реальные Safari (macOS/iOS), Windows с forced colors и
  Android не входят в автоматические проверки; результат для них фиксируется ручной
  приёмкой с версией и датой.

## Проверка изменения

Изменение темы, юнита `ui` или шаблона проверяется в галерее и у всех реальных
потребителей в обеих схемах на 1440/1024/768/390: контраст фактических пар, фокус,
клавиатура, touch 44px, reduced motion, длинный русский текст и большие числа, отключённый
декор. Команды и порядок браузерной приёмки — в [разработке](DEVELOPMENT.md#проверки-изменения-приложения).
