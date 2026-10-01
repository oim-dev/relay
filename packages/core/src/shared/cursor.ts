import { createHash } from "node:crypto";
import { z } from "zod";
import { AppError } from "./errors.js";

const cursorSchema = z.strictObject({
  version: z.literal(1),
  scope: z.string(),
  position: z.unknown(),
});

function fingerprint(scope: unknown): string {
  return createHash("sha256").update(JSON.stringify(scope)).digest("hex").slice(0, 24);
}

export function encodeCursor(scope: unknown, position: unknown): string {
  return Buffer.from(JSON.stringify({ version: 1, scope: fingerprint(scope), position })).toString(
    "base64url",
  );
}

/**
 * Позиция курсора без проверки привязки к запросу; null — курсор повреждён.
 * Только для диагностики причины отказа, не для продолжения выборки.
 */
export function peekCursor<T>(token: string, schema: z.ZodType<T>): T | null {
  try {
    if (token.length > 4096 || !/^[A-Za-z0-9_-]+$/.test(token)) return null;
    const cursor = cursorSchema.parse(JSON.parse(Buffer.from(token, "base64url").toString("utf8")));
    const position = schema.safeParse(cursor.position);
    return position.success ? position.data : null;
  } catch {
    return null;
  }
}

/** Привязка к запросу исключает случайное продолжение страницы с другими фильтрами. */
export function decodeCursor<T>(token: string, scope: unknown, schema: z.ZodType<T>): T {
  try {
    if (token.length > 4096 || !/^[A-Za-z0-9_-]+$/.test(token)) throw new Error();
    const cursor = cursorSchema.parse(JSON.parse(Buffer.from(token, "base64url").toString("utf8")));
    if (cursor.scope !== fingerprint(scope)) throw new Error();
    return schema.parse(cursor.position);
  } catch {
    throw new AppError("INVALID_CURSOR", "Курсор повреждён или относится к другому запросу");
  }
}
