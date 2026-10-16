import { fileURLToPath } from "node:url";

// Та же политика, что в main.ts, но до tsx: загрузчик тоже проверяет цвет в Node.
delete process.env.FORCE_COLOR;
process.env.NO_COLOR = "1";

const { register } = await import("tsx/esm/api");

register({ tsconfig: fileURLToPath(new URL("../tsconfig.dev.json", import.meta.url)) });
// pnpm запускает скрипт из пакета; CLI работает с каталогом задач вызывающего процесса.
process.chdir(process.env.INIT_CWD ?? process.cwd());
await import("../src/main.js");
