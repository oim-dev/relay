/** Исход прикрепления одного выбранного материала. */
export type AttachOutcome = {
  /** ID материала. */
  id: string;
  /** Название на момент выбора. */
  title: string;
  /** Применено или причина отказа. */
  status: "applied" | "exists" | "conflict" | "error";
  /** Объяснение для человека. */
  message: string;
};
