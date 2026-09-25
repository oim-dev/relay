import { resolve } from "node:path";
import { buildBundle, checkBundle, repoRoot } from "./lib.mjs";

const USAGE = `Сборка и проверка проектных агентов Relay из packages/dev-agents/src.

  node packages/dev-agents/scripts/build.mjs [--root <каталог>] [--format json]
  node packages/dev-agents/scripts/check.mjs [--root <каталог>] [--format json]

build обновляет собственные файлы по agents-lock.json. Коллизии требуют
переноса чужого файла или восстановления управляемого файла после сохранения правок.
check только читает файлы; код 1 означает расхождения или ошибку входа.

  --root <каталог>  Корень проекта; по умолчанию репозиторий сборщика.
  --format json    Машинный ответ без пояснений; по умолчанию русский текст.
  --help, -h       Эта справка.

Пример: pnpm --silent run agents:check --format json
`;

/** Общий интерфейс человека и машинный ответ обеих команд. */
export async function runCli(mode, argv = process.argv.slice(2)) {
  const machine = argv.some((arg, index) => arg === "--format" && argv[index + 1] === "json");
  // pnpm меняет cwd на пакет. Относительный --root относится к месту вызова команды.
  const cwd =
    process.env.npm_package_name === "@relay/dev-agents" && process.env.npm_lifecycle_event === mode
      ? (process.env.INIT_CWD ?? process.cwd())
      : process.cwd();
  try {
    let root = repoRoot;
    let help = false;
    for (let index = 0; index < argv.length; index++) {
      const arg = argv[index];
      if (arg === "--help" || arg === "-h") help = true;
      else if (arg === "--root" && argv[index + 1] && !argv[index + 1].startsWith("--"))
        root = resolve(cwd, argv[++index]);
      else if (arg === "--format" && argv[index + 1] === "json") {
        index++;
      } else
        throw new Error(
          `Неизвестный аргумент или отсутствует значение: ${arg}. Используйте --help.`,
        );
    }
    if (help) {
      console.log(machine ? JSON.stringify({ help: USAGE }) : USAGE);
      return;
    }
    const result = await (mode === "build" ? buildBundle({ root }) : checkBundle({ root }));
    if (machine) console.log(JSON.stringify(result));
    else if (mode === "build") {
      console.log(`Агенты Relay собраны: ${result.agents} агентов, ${result.outputs} файлов.`);
      console.log(
        `Записано: ${result.written.length}; удалено устаревших: ${result.removed.length}.`,
      );
    } else if (result.ok)
      console.log(
        `Агенты Relay: ${result.agents} агентов, ${result.outputs} файлов. Сборка актуальна.`,
      );
    else {
      console.log("Сборка агентов Relay неактуальна:");
      for (const issue of result.issues) console.log(`- ${issue.message}: ${issue.path}`);
      console.log("Обновите сборку: pnpm run agents:build (для другого корня добавьте --root).");
    }
    if (!result.ok) process.exitCode = 1;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (machine) console.log(JSON.stringify({ version: 1, mode, ok: false, error: message }));
    else console.error(`Ошибка сборки агентов: ${message}`);
    process.exitCode = 1;
  }
}
