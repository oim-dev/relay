import type { ReactNode } from "react";
import type { DocumentRelation } from "domains/documents";

/** Параметры единого выборщика материалов библиотеки. */
export type MaterialPickerProps = {
  /** Окно открыто. */
  opened: boolean;
  /** Сущность, к которой прикрепляются материалы. */
  target: DocumentRelation["target"];
  /** Подпись сущности для заголовка: вид и название. */
  targetLabel: string;
  /** Закрывает окно; фокус возвращается к вызвавшей кнопке. */
  onClose: () => void;
  /** Окно полностью закрыто (после анимации); родитель возвращает фокус. */
  onExited?: () => void;
  /** Сообщает число материалов, прикреплённых последней отправкой. */
  onAttached: (count: number) => void;
  /** Содержимое предпросмотра материала по его ID. */
  renderPreview: (materialId: string) => ReactNode;
};
