/** Навигационный контрол каркаса. */
export type KitNavControl = "item" | "child" | "group" | "icon" | "select";

/** Показываемое состояние контрола. */
export type KitNavState =
  "default" | "hover" | "current" | "expanded" | "current-group" | "disabled" | "focus";

/** Свойства статичного образца навигации. */
export type KitNavSampleProps = {
  /** Контрол каркаса. */
  control: KitNavControl;
  /** Состояние, зафиксированное в образце. */
  state: KitNavState;
};
