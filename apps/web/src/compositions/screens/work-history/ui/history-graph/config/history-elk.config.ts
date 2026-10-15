/** Проверенная модель: временные partitions и interactive phases, реальные ортогональные routes. */
export const HISTORY_ELK_OPTIONS = {
  "org.eclipse.elk.algorithm": "layered",
  "org.eclipse.elk.direction": "UP",
  "org.eclipse.elk.edgeRouting": "ORTHOGONAL",
  "org.eclipse.elk.randomSeed": "7",
  "org.eclipse.elk.separateConnectedComponents": "false",
  "org.eclipse.elk.spacing.nodeNode": "40",
  "org.eclipse.elk.spacing.edgeNode": "12",
  "org.eclipse.elk.spacing.edgeEdge": "8",
  "org.eclipse.elk.layered.spacing.nodeNodeBetweenLayers": "16",
  "org.eclipse.elk.layered.spacing.edgeNodeBetweenLayers": "12",
  "org.eclipse.elk.layered.spacing.edgeEdgeBetweenLayers": "8",
  "org.eclipse.elk.layered.considerModelOrder.strategy": "NODES_AND_EDGES",
  "org.eclipse.elk.layered.crossingMinimization.strategy": "INTERACTIVE",
  "org.eclipse.elk.layered.crossingMinimization.forceNodeModelOrder": "false",
  "org.eclipse.elk.layered.crossingMinimization.greedySwitch.type": "OFF",
  "org.eclipse.elk.layered.nodePlacement.strategy": "INTERACTIVE",
  "org.eclipse.elk.layered.nodePlacement.favorStraightEdges": "true",
  "org.eclipse.elk.layered.crossingMinimization.semiInteractive": "false",
  "org.eclipse.elk.layered.layering.strategy": "NETWORK_SIMPLEX",
  "org.eclipse.elk.partitioning.activate": "true",
  "org.eclipse.elk.layered.interactiveReferencePoint": "CENTER",
  "org.eclipse.elk.layered.compaction.postCompaction.strategy": "NONE",
} as const;

/** Шаг входной подсказки ELK, не окончательная позиция в React Flow. */
export const HISTORY_LANE_HINT_PITCH = 64;

/** Общая толщина дорожки нужна и отрисовке, и стыку стрелки с её внешним краем. */
export const HISTORY_EDGE_WIDTH = 2.5;

/** Читаемый исходный вид; не зависит от длины загруженной истории. */
export const HISTORY_DEFAULT_VIEWPORT = { x: 96, y: 16, zoom: 1 };

/** Русские инструкции read-only React Flow; редактирование связей не предлагается. */
export const HISTORY_ARIA_LABELS = {
  "node.a11yDescription.default":
    "Точка истории. Enter открывает материал, стрелки вверх и вниз переходят по хронологии. Редактирование недоступно.",
  "node.a11yDescription.keyboardDisabled": "Точка истории. Материал открывается кнопкой маркера.",
  "edge.a11yDescription.default": "Линия истории. Редактирование недоступно.",
  "handle.ariaLabel": "Технический конец линии",
};
