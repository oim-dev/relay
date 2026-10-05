import type { ComponentPropsWithoutRef } from "react";

/** Параметры карточки внешнего ресурса. */
export type LinkResourceParams = {
  /** Сохранённый адрес ресурса. */
  url: string;
  /** Необязательное пояснение к ссылке (Markdown). */
  explanation: string;
};
/** Атрибуты корневого элемента. */
type RootAttrs = Omit<ComponentPropsWithoutRef<"section">, "children">;
/** Свойства карточки внешнего ресурса. */
export type LinkResourceProps = RootAttrs & LinkResourceParams;
