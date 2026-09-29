import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

// Разрешаем пользовательские пути до смены рабочего каталога через Turbo/pnpm.
if (process.env.RELAY_CONFIG) {
  process.env.RELAY_CONFIG = resolve(
    process.env.INIT_CWD ?? process.cwd(),
    process.env.RELAY_CONFIG,
  );
} else
  process.env.RELAY_CONFIG = fileURLToPath(
    new URL("../../playground/.relay/config.json", import.meta.url),
  );
