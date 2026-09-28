import type { Writable } from "node:stream";
import type { TextOptions } from "./presentation/theme.js";

/** Совместимость прежних вызовов; цвет в CLI больше не включается. */
export type ColorMode = "auto" | "always" | "never";

export function terminalOptions(
  stream: Writable,
  env: NodeJS.ProcessEnv,
  _mode: ColorMode = "auto",
): TextOptions {
  const terminal = stream as Writable & { isTTY?: boolean; columns?: number };
  const columns = terminal.columns ?? Number(env.COLUMNS);
  return {
    color: false,
    width:
      Number.isSafeInteger(columns) && columns > 0 ? Math.max(24, Math.min(160, columns)) : 100,
  };
}
