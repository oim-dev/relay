/** Границы слов простого shell-вызова; содержимое слов не декодируется и не исполняется. */
function shellWords(source: string): { start: number; end: number }[] | undefined {
  const words: { start: number; end: number }[] = [];
  let start: number | undefined;
  let quote: "'" | '"' | undefined;
  for (let index = 0; index < source.length; index++) {
    const character = source[index];
    if (character === "\\" && quote !== "'") {
      if (index + 1 === source.length) return undefined;
      // Продолжение вне слова — разделитель, не начало нового слова.
      if (source[index + 1] !== "\n") start ??= index;
      index++;
      continue;
    }
    if (quote) {
      if (character === quote) quote = undefined;
      // Вложенный shell-синтаксис намеренно не разбираем.
      else if (quote === '"' && (character === "$" || character === "`")) return undefined;
      continue;
    }
    if (character === " " || character === "\t") {
      if (start !== undefined) words.push({ start, end: index });
      start = undefined;
      continue;
    }
    // Составные команды, подстановки, комментарии и перенаправления сохраняем как написаны.
    if ("\n\r;&|<>()$`#".includes(character!)) return undefined;
    start ??= index;
    if (character === "'" || character === '"') quote = character;
  }
  if (quote) return undefined;
  if (start !== undefined) words.push({ start, end: source.length });
  return words;
}

/** Только авторские examples в help, не данные пользователя и не nextCommand. */
export function formatHelpExample(example: string, indent = ""): string {
  const words = shellWords(example);
  if (!words) return indent + example;
  const breaks: { start: number; end: number }[] = [];
  for (let index = 1; index < words.length; index++) {
    const word = words[index]!;
    const raw = example.slice(word.start, word.end);
    if (raw === "--") break;
    // Кавычки/escapes не снимаем: похожее на флаг значение не становится границей.
    // Отрицательные числа и одиночный '-' остаются рядом со своей опцией.
    if (/^(?:--[a-zA-Z][\w-]*|-[a-zA-Z])(?:=|$)/.test(raw)) {
      breaks.push({ start: words[index - 1]!.end, end: word.start });
    }
  }
  if (breaks.length === 1 && ["--help", "-h"].includes(example.slice(breaks[0]!.end))) {
    return indent + example;
  }
  // Заменяем только разделители перед опциями, не трогая слова и их порядок.
  // В частности, не добавляем отступы внутрь многострочных quoted literals.
  let result = indent;
  let offset = 0;
  for (const boundary of breaks) {
    result += example.slice(offset, boundary.start) + " \\\n" + indent + "  ";
    offset = boundary.end;
  }
  return result + example.slice(offset);
}
