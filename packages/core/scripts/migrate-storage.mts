import { parseArgs } from "node:util";
import { lstat, realpath } from "node:fs/promises";
import { join, resolve } from "node:path";
import {
  inspectStorage,
  maintenanceFailure,
  migrateStorage,
  planStorageMigration,
} from "../src/application/storage/maintenance.js";
import { AppError } from "../src/shared/errors.js";

// Внутренний maintenance-вход из checkout: та же реализация Core, что `storage status|migrate` CLI,
// и те же exit code: 0 — успешный исход; ненулевой — причина из STORAGE_MAINTENANCE_ERROR_EXIT_CODES.
// Сначала проверяется отдельная копия базы.
const { values } = parseArgs({
  options: {
    project: { type: "string" },
    config: { type: "string" },
    status: { type: "boolean", default: false },
    "dry-run": { type: "boolean", default: false },
    "backup-dir": { type: "string" },
    "if-plan": { type: "string" },
  },
  allowPositionals: false,
  strict: true,
});
if (Boolean(values.project) === Boolean(values.config))
  throw new Error(
    "Ожидается --project <каталог проекта> или --config <файл конфигурации> и одно из: --status, --dry-run, --backup-dir DIR [--if-plan FP]",
  );
let configPath: string;
if (values.project) {
  const requested = resolve(values.project);
  const project = await realpath(requested);
  if (project !== requested)
    throw new Error("Укажите канонический путь проекта без символьных ссылок");
  configPath = join(project, ".relay", "config.json");
  if ((await lstat(join(project, ".relay"))).isSymbolicLink())
    throw new Error("Каталог базы не должен быть символьной ссылкой");
} else configPath = resolve(values.config!);

const target = { configPath };
/** Ответ как у CLI `--format json`: результат схемы или `{ ok: false, error }` с exit code. */
const fail = (error: AppError) => {
  console.log(
    JSON.stringify(
      { ok: false, error: { code: error.code, message: error.message, details: error.details } },
      null,
      2,
    ),
  );
  process.exitCode = error.exitCode;
};
try {
  let output: unknown;
  if (values.status) {
    const status = await inspectStorage(target);
    const failure = maintenanceFailure(status, "База требует внимания — см. блокеры");
    if (failure) fail(failure);
    else output = status;
  } else if (values["dry-run"]) {
    const plan = await planStorageMigration(target);
    const failure = maintenanceFailure(plan, "План переноса неприменим — база не изменена");
    if (failure) fail(failure);
    else output = plan;
  } else
    output = await migrateStorage(target, {
      ...(values["backup-dir"] ? { backupDir: resolve(values["backup-dir"]) } : {}),
      ...(values["if-plan"] ? { ifPlan: values["if-plan"] } : {}),
    });
  if (output !== undefined) console.log(JSON.stringify(output, null, 2));
} catch (error) {
  if (!(error instanceof AppError)) throw error;
  fail(error);
}
