/** Пара «текст на фоне» для проверки читаемости роли. */
export type KitColorPair = {
  /** Роль фона без префикса --tasks-. */
  background: string;
  /** Роль текста без префикса --tasks-. */
  text: string;
  /** Где применяется пара. */
  usage: string;
};

/** Группа ролей галереи. */
export type KitColorGroup = {
  /** Название группы. */
  title: string;
  /** Пары группы. */
  pairs: KitColorPair[];
};

/** Роли темы, сгруппированные как в docs/DESIGN_SYSTEM.md. */
export const KIT_COLOR_GROUPS: KitColorGroup[] = [
  {
    title: "Поверхности и текст",
    pairs: [
      { background: "backdrop", text: "ink", usage: "Внешний фон экрана" },
      { background: "stage", text: "ink", usage: "Сцена страницы" },
      { background: "card", text: "muted", usage: "Панель и пояснение" },
      { background: "tile", text: "ink", usage: "Строка записи" },
      { background: "surface", text: "soft", usage: "Поле и слабая подпись" },
      { background: "feature-surface", text: "muted", usage: "Основа главной панели" },
      { background: "inverse-surface", text: "inverse", usage: "Один главный сигнал" },
    ],
  },
  {
    title: "Действия и взаимодействие",
    pairs: [
      { background: "action-primary", text: "action-primary-text", usage: "Главное действие" },
      { background: "action-disabled", text: "action-disabled-text", usage: "Недоступно" },
      { background: "accent", text: "accent-contrast", usage: "Акцентная заливка" },
      { background: "accent-subtle", text: "accent-ink", usage: "Текущее место навигации" },
      { background: "selection", text: "ink", usage: "Выделение текста" },
      { background: "search-mark", text: "ink", usage: "Совпадение поиска" },
    ],
  },
  {
    title: "Состояния",
    pairs: [
      { background: "info-surface", text: "info", usage: "Сведения" },
      { background: "success-surface", text: "success", usage: "Успех" },
      { background: "warning-surface", text: "warning", usage: "Предупреждение" },
      { background: "danger-surface", text: "danger", usage: "Ошибка" },
      { background: "danger", text: "status-contrast", usage: "Заливка состояния" },
    ],
  },
];

/** Роли данных: колонки задач, выполнение и прогресс. */
export const KIT_DATA_ROLES = [
  { role: "column-inbox", label: "Входящие" },
  { role: "column-ready", label: "К выполнению" },
  { role: "column-in-progress", label: "В работе" },
  { role: "column-review", label: "На проверке" },
  { role: "column-done", label: "Готово" },
  { role: "column-cancelled", label: "Отменено" },
  { role: "blocked", label: "Заблокировано" },
  { role: "progress-track", label: "Дорожка прогресса" },
];
