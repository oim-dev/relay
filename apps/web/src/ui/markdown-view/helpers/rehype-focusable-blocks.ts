/** Читаемая часть HTML-дерева, подготовленного Markdown-рендерером. */
type HtmlNode = {
  /** Вид узла HTML-дерева. */
  type: string;
  /** Имя HTML-элемента. */
  tagName?: string;
  /** Атрибуты элемента после разбора Markdown. */
  properties?: Record<string, unknown>;
  /** Вложенные узлы. */
  children?: HtmlNode[];
};

/**
 * Даёт клавиатурный доступ к таблицам и блокам кода в режиме чтения широких материалов.
 */
export const rehypeFocusableBlocks = (): ((tree: HtmlNode) => void) => {
  /**
   * Дополняет только атрибуты представления, сохраняя содержимое и семантику таблицы.
   */
  const visit = (node: HtmlNode): void => {
    if (node.type === "element" && (node.tagName === "pre" || node.tagName === "table")) {
      node.properties = { ...node.properties, tabIndex: 0 };
      if (node.tagName === "pre") {
        node.properties.role = "region";
        node.properties.ariaLabel = "Блок кода";
      }
    }
    for (const child of node.children ?? []) visit(child);
  };
  return visit;
};
