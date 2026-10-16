#!/usr/bin/env node

// CLI всегда без цвета. Нормализуем env до загрузки зависимостей:
// proper-lockfile → signal-exit → node:assert проверяет цвет уже при импорте.
delete process.env.FORCE_COLOR;
process.env.NO_COLOR = "1";

const { runtime } = await import("./context.js");
const { runCli } = await import("./run.js");
const { isErrno } = await import("@relay/core/shared/errors");

// Закрытый потребителем pipe — штатное завершение, а не ошибка трекера.
process.stdout.on("error", (error: Error) => {
  if (isErrno(error, "EPIPE")) process.exit(0);
  throw error;
});

process.exitCode = await runCli(process.argv.slice(2), runtime(process.stdin, process.stdout));
