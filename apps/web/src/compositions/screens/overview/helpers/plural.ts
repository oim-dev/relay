const PLURAL_RULES = new Intl.PluralRules("ru");

/**
 * Выбирает форму слова по числу: «одна задача», «две задачи», «пять задач».
 * @param forms Формы для 1, 2–4 и 5 и больше.
 */
export const pluralWord = (count: number, forms: readonly [string, string, string]): string => {
  const rule = PLURAL_RULES.select(count);
  if (rule === "one") return forms[0];
  if (rule === "few") return forms[1];
  return forms[2];
};
