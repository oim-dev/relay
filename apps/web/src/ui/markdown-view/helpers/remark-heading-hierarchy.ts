/** Читаемая часть уже разобранного remark-дерева; Markdown повторно не разбирается. */
type MarkdownNode = {
  /** Вид узла, например heading или code. */
  type: string;
  /** Уровень только у heading-узла. */
  depth?: number;
  /** Дочерние узлы уже разобранного материала. */
  children?: MarkdownNode[];
};

/** Активный предок в исходной и представляемой иерархии. */
type HeadingAncestor = {
  /** Уровень в исходном Markdown. */
  sourceDepth: number;
  /** Уровень заголовка внутри контейнера. */
  outputDepth: number;
};

/**
 * Нормализует только heading-узлы remark: первый реальный заголовок начинает заданный уровень,
 * потомки идут без пропусков, а одноуровневые заголовки остаются одноуровневыми.
 * Изменяется дерево представления, не исходная строка; содержимое code-узлов не затрагивается.
 */
export const remarkHeadingHierarchy = (startLevel: number = 1): ((tree: MarkdownNode) => void) => {
  return (tree: MarkdownNode): void => {
    const ancestors: HeadingAncestor[] = [];
    /**
     * Обходит реальные узлы в порядке чтения, сохраняя относительное родительство заголовков.
     */
    const visit = (node: MarkdownNode): void => {
      if (node.type === "heading" && typeof node.depth === "number") {
        const sourceDepth = node.depth;
        let parent = ancestors.at(-1);
        while (parent !== undefined && parent.sourceDepth >= sourceDepth) {
          ancestors.pop();
          parent = ancestors.at(-1);
        }
        const outputDepth = parent === undefined ? startLevel : Math.min(parent.outputDepth + 1, 6);
        node.depth = outputDepth;
        ancestors.push({ sourceDepth, outputDepth });
      }
      for (const child of node.children ?? []) visit(child);
    };
    visit(tree);
  };
};
