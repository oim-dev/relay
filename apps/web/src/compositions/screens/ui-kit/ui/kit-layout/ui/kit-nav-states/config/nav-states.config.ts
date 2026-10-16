import type {
  KitNavControl,
  KitNavState,
} from "../ui/kit-nav-sample/types/kit-nav-sample-props.type";

/** Одно состояние в таблице образцов. */
type NavStateEntry = {
  /** Контрол образца; по умолчанию — контрол строки. */
  control?: KitNavControl;
  /** Зафиксированное состояние. */
  state: KitNavState;
  /** Название состояния. */
  label: string;
  /** Как состояние объявлено и показано. */
  note: string;
};

/** Строка таблицы: контрол каркаса и его состояния. */
type NavControlEntry = {
  /** Название контрола. */
  title: string;
  /** Контрол каркаса. */
  control: KitNavControl;
  /** Показываемые состояния. */
  states: NavStateEntry[];
};

/** Состояния навигационных контролов каркаса проекта. */
export const NAV_CONTROLS: NavControlEntry[] = [
  {
    title: "Пункт раздела",
    control: "item",
    states: [
      { state: "default", label: "Покой", note: "Иконка и подпись без плашки" },
      { state: "hover", label: "Наведение", note: "nav-hover поверх подложки" },
      { state: "current", label: "Текущий", note: "aria-current, nav-current-surface, вес 600" },
      { control: "group", state: "expanded", label: "Раскрыт", note: "aria-expanded, chevron" },
      {
        control: "group",
        state: "current-group",
        label: "Текущая группа",
        note: "Начертание группы и текущий вложенный пункт",
      },
      { state: "disabled", label: "Недоступен", note: "disabled: приглушён, без действия" },
      { state: "focus", label: "Фокус", note: "Контур focus-ring 2px" },
    ],
  },
  {
    title: "Вложенный пункт",
    control: "child",
    states: [
      { state: "default", label: "Покой", note: "Вложенность отступом, без линий" },
      { state: "hover", label: "Наведение", note: "nav-hover" },
      { state: "current", label: "Текущий", note: "aria-current, nav-current-surface" },
      { state: "disabled", label: "Недоступен", note: "disabled" },
      { state: "focus", label: "Фокус", note: "Контур focus-ring" },
    ],
  },
  {
    title: "Кнопка-иконка",
    control: "icon",
    states: [
      { state: "default", label: "Покой", note: "subtle: без рамки и фона, иконка muted" },
      { state: "hover", label: "Наведение", note: "nav-hover, иконка ink" },
      {
        state: "current",
        label: "Текущая",
        note: "variant light и aria-current: заливка, цвет и контур текущего пункта",
      },
      {
        state: "expanded",
        label: "Раскрыта",
        note: "aria-haspopup и aria-expanded: заливка наведения и контур selected-border",
      },
      { state: "disabled", label: "Недоступна", note: "disabled" },
      { state: "focus", label: "Фокус", note: "Контур focus-ring" },
    ],
  },
  {
    title: "Выбор проекта",
    control: "select",
    states: [
      { state: "default", label: "Покой", note: "Название и chevron без рамки" },
      { state: "hover", label: "Наведение", note: "nav-hover" },
      { state: "expanded", label: "Раскрыт", note: "aria-expanded: nav-hover, список поверх" },
      {
        state: "disabled",
        label: "Недоступен",
        note: "disabled; недоступный проект — отключённый пункт списка",
      },
      { state: "focus", label: "Фокус", note: "Рамка и кольцо focus-ring" },
    ],
  },
];
