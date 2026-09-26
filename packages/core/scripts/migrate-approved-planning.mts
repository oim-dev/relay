import { parseArgs } from "node:util";
import { readFile, readdir, realpath, stat, lstat } from "node:fs/promises";
import { join, resolve } from "node:path";
import { openWorkspace } from "../src/storage/workspace.js";
import { StorageService } from "../src/application/storage/service.js";
import { storageMigrationOptionsSchema } from "../src/storage/migration/orphan-planning-approval.js";

// Явный внутренний maintenance-вход. Никаких встроенных ID проекта и автоматического
// составления разрешения из найденных orphan-событий: JSON готовится и проверяется отдельно.
const { values } = parseArgs({
  options: {
    project: { type: "string" },
    approval: { type: "string" },
    apply: { type: "boolean", default: false },
    reindex: { type: "boolean", default: false },
  },
  allowPositionals: false,
  strict: true,
});
if (!values.apply || !values.project || !values.approval)
  throw new Error("Ожидается --project <каталог проекта> --approval <проверенный JSON> --apply [--reindex]");
const options = storageMigrationOptionsSchema.parse(JSON.parse(await readFile(resolve(values.approval), "utf8")));
if (!options.orphanPlanning) throw new Error("JSON не содержит адресного разрешения orphanPlanning");
const requestedProject = resolve(values.project);
const project = await realpath(requestedProject);
if (project !== requestedProject) throw new Error("Укажите канонический путь проекта без символьных ссылок");
const root = join(project, ".relay");
const configPath = join(root, "config.json");
if ((await lstat(root)).isSymbolicLink() || (await lstat(configPath)).isSymbolicLink())
  throw new Error("Каталог базы и конфигурация не должны быть символьными ссылками");
const config = JSON.parse(await readFile(configPath, "utf8"));
if (config.projectId !== options.orphanPlanning.projectId) throw new Error("Разрешение выдано другому проекту");

async function measure(directory: string) {
  const sizes = { bytes: 0, persistentBytes: 0, historyBytes: 0, indexBytes: 0, entityBytes: 0, relationBytes: 0, files: 0 };
  const walk = async (relative: string) => {
    for (const entry of await readdir(join(directory, relative), { withFileTypes: true })) {
      const path = relative ? `${relative}/${entry.name}` : entry.name;
      if (entry.isSymbolicLink()) throw new Error(`Символьная ссылка в выбранной базе: ${path}`);
      if (entry.isDirectory()) await walk(path);
      else if (entry.isFile()) {
        const { size } = await stat(join(directory, path));
        sizes.bytes += size;
        sizes.files++;
        if (!/^(\.indexes|runtime|transactions)\//.test(path)) sizes.persistentBytes += size;
        if (/^(history|operations)\//.test(path)) sizes.historyBytes += size;
        if (path.startsWith(".indexes/")) sizes.indexBytes += size;
        if (path.startsWith("entities/")) sizes.entityBytes += size;
        if (path.startsWith("relations/")) sizes.relationBytes += size;
      }
    }
  };
  await walk("");
  return sizes;
}

const before = await measure(root);
const workspace = await openWorkspace(project, configPath);
const service = new StorageService(workspace);
const result = await service.migrate(options);
const afterMigration = await measure(root);
if (values.reindex) await service.reindex();
const after = await measure(root);
// Эта повторная проверка не исключает события заново: только подтверждает исходные receipts.
const verification = await service.migrate(options);
console.log(JSON.stringify({ project, result, verification, before, afterMigration, after }, null, 2));
