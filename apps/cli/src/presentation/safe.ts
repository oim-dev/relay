/** Пользовательский текст не может управлять терминалом через ANSI/OSC-последовательности. */
export function safeText(value: string): string {
  return value.replace(
    /[\x00-\x08\x0b-\x1f\x7f-\x9f\u202a-\u202e\u2066-\u2069]/g,
    (character) => `\\u${character.charCodeAt(0).toString(16).padStart(4, "0")}`,
  );
}

/** JSON сохраняет исходные значения после parse, но не передаёт терминалу C1/Bidi. */
export function safeJson(value: unknown): string {
  return (JSON.stringify(value) ?? "null").replace(
    /[\x7f-\x9f\u202a-\u202e\u2066-\u2069]/g,
    (character) => `\\u${character.charCodeAt(0).toString(16).padStart(4, "0")}`,
  );
}
