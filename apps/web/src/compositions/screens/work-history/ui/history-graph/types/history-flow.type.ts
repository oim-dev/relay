import type { Edge, Node, Position, XYPosition } from "@xyflow/react";
import type {
  WorkGraphPoint,
  WorkGraphBranch,
  WorkGraphRun,
  WorkGraphBoundary,
} from "domains/work-history";

/** Невидимый технический порт, координаты которого вернул ELK. */
export type HistoryPort = {
  /** ID порта ELK, не адрес события. */
  id: string;
  /** Сторона порта для React Flow. */
  side: Position;
  /** Локальная координата относительно ноды. */
  position: XYPosition;
};

/** Данные авторского маркера с локальной подсказкой. */
export type HistoryPointData = {
  /** Сохранённая точка на её настоящем времени. */
  point: WorkGraphPoint;
  /** Ветка маркера. */
  branch: WorkGraphBranch;
  /** Исторический автор именно этой точки. */
  run: WorkGraphRun | null;
  /** Точка продолжения незавершённой ветки. */
  isOpenEnd: boolean;
  /** Последняя точка старой ветки вне прочитанных страниц. */
  isOutsidePage: boolean;
  /** Роль цвета, стабильная по ID ветки. */
  color: string;
  /** Центр маркера внутри рассчитанного ELK bbox. */
  anchorOffset: XYPosition;
  /** Порты согласованных маршрутов. */
  ports: HistoryPort[];
  /** Открытый адрес из URL. */
  isSelected: boolean;
  /** Подсветка ветки, не фильтр. */
  isHighlighted: boolean;
  /** Открывает полный материал. */
  onSelect: (ref: string, source: HTMLButtonElement) => void;
  /** При ручном фокусе делает маркер видимым в камере. */
  onFocus: (nodeId: string) => void;
  /** Клавиатурная навигация по хронологии. */
  onNavigate: (nodeId: string, direction: "next" | "previous" | "first" | "last") => void;
};

/** Данные явной границы загруженного окна. */
export type HistoryBoundaryData = {
  /** Сохранённая точка за окном без её полного материала. */
  boundary: WorkGraphBoundary;
  /** Владелец линии. */
  branch: WorkGraphBranch;
  /** Роль цвета ветки. */
  color: string;
  /** Центр технического конца внутри ELK bbox. */
  anchorOffset: XYPosition;
  /** Невидимые порты ELK. */
  ports: HistoryPort[];
  /** Адресное открытие точки. */
  onSelect: (ref: string, source: HTMLButtonElement) => void;
  /** Видимость фокуса в read-only камере. */
  onFocus: (nodeId: string) => void;
};

/** Декоративная дата на настоящей оси проекта. */
export type HistoryDateData = {
  /** Исходное сохранённое время. */
  at: string;
  /** Начало календарной группы; пусто внутри дня. */
  dayLabel: string;
  /** Время текущей строки. */
  timeLabel: string;
  /** Порты оси. */
  ports: HistoryPort[];
};

/** Технический якорь линии, не событие и не tab stop. */
export type HistoryAnchorData = {
  /** Порты ELK для связи с настоящими точками. */
  ports: HistoryPort[];
};

/** Реальный маркер, включая последнюю точку незавершённой работы. */
export type HistoryPointNode = Node<HistoryPointData, "historyPoint">;
/** Адресная граница. */
export type HistoryBoundaryNode = Node<HistoryBoundaryData, "historyBoundary">;
/** Дата и технический якорь оси. */
export type HistoryDateNode = Node<HistoryDateData, "historyDate">;
/** Прозрачный технический якорь. */
export type HistoryAnchorNode = Node<HistoryAnchorData, "historyAnchor">;
/** Набор read-only нод React Flow. */
export type HistoryFlowNode =
  HistoryPointNode | HistoryBoundaryNode | HistoryDateNode | HistoryAnchorNode;

/** Только готовые sections ELK; renderer не вычисляет свой маршрут. */
export type HistoryEdgeGap = {
  /** Номер участка ELK. */
  section: number;
  /** Номер конечной точки прямого сегмента внутри участка. */
  segment: number;
  /** Расстояние от начала сегмента до пересечения. */
  offset: number;
  /** Половина визуального разрыва; координаты маршрута не меняются. */
  radius: number;
};

/** Только готовые sections ELK и визуальные разрывы в несвязанных пересечениях. */
export type HistoryFlowEdge = Edge<
  {
    /** Каждый независимый участок содержит startPoint, bendPoints и endPoint ELK. */
    sections: XYPosition[][];
    /** Предметный или технический вид линии. */
    kind: "sequence" | "fork" | "branch-end" | "root-start" | "root-end" | "axis";
    /** Роль цвета ветки/оси. */
    color: string;
    /** Явное продолжение за загруженное окно. */
    isBoundary: boolean;
    /** Пунктир принадлежит субагенту, а не искусственному продолжению. */
    isWorker: boolean;
    /** Линия незавершённой работы имеет приоритет над линией закрытой ветки. */
    isUnfinished: boolean;
    /** Разрывы отрисовки, не разрывы предметной связи. */
    gaps?: HistoryEdgeGap[];
  },
  "historyEdge"
>;
