import type { GlobalOptions, Runtime } from "./context.js";
import { readConfiguration } from "@relay/project-runtime/config";
import { AppError } from "@relay/core/shared/errors";
import { PresentedError } from "./output.js";
import { wrap } from "./presentation/layout.js";
import { safeText } from "./presentation/safe.js";

export async function cliConfiguration(
  runtime: Runtime,
  globals: GlobalOptions,
  _registryOnly = false,
) {
  const explicit = globals.config ?? runtime.env.RELAY_CONFIG;
  try {
    return await readConfiguration(runtime.cwd, explicit);
  } catch (error) {
    // Сохраняем код и машинные details ошибки пути, меняем только human-восстановление.
    if (explicit !== undefined && error instanceof AppError && error.code === "NOT_FOUND") {
      throw new PresentedError(
        error.code,
        error.message,
        error.exitCode,
        error.details,
        (options) =>
          [
            wrap(safeText(error.message), options.width),
            wrap(
              "Следующий шаг: Проверьте явно выбранный путь --config или RELAY_CONFIG к существующему проекту. Исправьте путь; для подключения по --server-url без локального конфига уберите неверный явный путь. Не создавайте новую базу через init вместо поиска существующей.",
              options.width,
            ),
          ].join("\n\n"),
      );
    }
    throw error;
  }
}
