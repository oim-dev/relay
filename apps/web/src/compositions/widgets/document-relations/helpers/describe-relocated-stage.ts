import type { EntityRelocation } from "domains/entities";

/** Человекочитаемое описание связи с прежним этапом плана. */
type RelocatedStageText = {
  /** Заголовок строки связи. */
  title: string;
  /** Доступное имя перехода к плану-владельцу. */
  ownerLinkLabel: string;
};

/**
 * Называет прежний этап по сведениям о переносе: ключ этапа и название плана, если план
 * уже прочитан; без сведений — нейтральное «Прежний этап плана», а не сырой ID.
 */
export const describeRelocatedStage = (
  relocation: EntityRelocation | undefined,
  planTitle: string | undefined,
): RelocatedStageText => {
  const stage = relocation?.key ?? null;
  if (stage !== null && planTitle !== undefined)
    return {
      title: `Этап ${stage} плана «${planTitle}»`,
      ownerLinkLabel: `Открыть план «${planTitle}»`,
    };
  if (stage !== null)
    return { title: `Прежний этап ${stage}`, ownerLinkLabel: `Открыть план этапа ${stage}` };
  if (planTitle !== undefined)
    return {
      title: `Прежний этап плана «${planTitle}»`,
      ownerLinkLabel: `Открыть план «${planTitle}»`,
    };
  return { title: "Прежний этап плана", ownerLinkLabel: "Открыть план прежнего этапа" };
};
