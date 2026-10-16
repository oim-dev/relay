/** Параметры визуальной области. */
export type GraphPointModalParams = {
  /** Изолированный проект. */
  projectId: string;
  /** Производный ID или прежняя ссылка CP. */
  pointRef: string;
  /** Закрытие с сохранением положения графа. */
  onClose: () => void;
  /** Адресное открытие связанного материала, не смена области графа. */
  onSelectPoint: (ref: string) => void;
};
/** Свойства визуальной области. */
export type GraphPointModalProps = GraphPointModalParams;
