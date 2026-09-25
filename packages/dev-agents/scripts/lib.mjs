import { createHash, randomUUID } from "node:crypto";
import { lstat, mkdir, readFile, realpath, rename, unlink, writeFile } from "node:fs/promises";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { agentBody, jsonDocument, renderAdapters } from "./adapters.mjs";

export const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../../..");
export const sourceRoot = "packages/dev-agents/src";
export const lockPath = "agents-lock.json";
const GENERATOR = "@relay/dev-agents";
const LEGACY_GENERATOR = "scripts/agent-bundle";
const NAME = /^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$/;
const FIXED_OUTPUTS = new Set([
  "opencode.json",
  // Совместимость старого lock: можно удалить прежнюю обёртку, но новый выход не создаётся.
  "CLAUDE.md",
  ".claude/settings.json",
  ".codex/config.toml",
]);

function requireCondition(condition, message) {
  if (!condition) throw new Error(message);
}

function validName(value) {
  return typeof value === "string" && value.length <= 64 && NAME.test(value);
}

function relativePath(value) {
  requireCondition(
    typeof value === "string" &&
      value.length > 0 &&
      !isAbsolute(value) &&
      !/[\\:\u0000-\u001f\u007f]/.test(value) &&
      value.split("/").every((part) => part && part !== "." && part !== ".."),
    `Недопустимый относительный путь (выход за корень запрещён): ${JSON.stringify(value)}`,
  );
  return value;
}

function objectShape(value, allowed, label) {
  requireCondition(
    value !== null && typeof value === "object" && !Array.isArray(value),
    `${label}: ожидается объект`,
  );
  const unknown = Object.keys(value).filter((key) => !allowed.includes(key));
  requireCondition(unknown.length === 0, `${label}: неизвестные поля: ${unknown.join(", ")}`);
}

function textValue(value, label) {
  requireCondition(
    typeof value === "string" &&
      value.trim().length > 0 &&
      value.isWellFormed() &&
      !value.includes("\0"),
    `${label}: ожидается непустой корректный текст UTF-8 без NUL`,
  );
  return value;
}

/** Не следует по символьным ссылкам, включая ссылки в промежуточных каталогах. */
async function fileState(root, path) {
  const parts = relativePath(path).split("/");
  for (let index = 0; index < parts.length; index++) {
    const current = parts.slice(0, index + 1).join("/");
    const info = await lstat(join(root, current)).catch((error) => {
      if (error.code === "ENOENT") return null;
      throw error;
    });
    if (!info) return null;
    requireCondition(!info.isSymbolicLink(), `Символьная ссылка запрещена: ${current}`);
    if (index < parts.length - 1) {
      requireCondition(info.isDirectory(), `Ожидается каталог: ${current}`);
    } else {
      requireCondition(info.isFile(), `Ожидается обычный файл: ${path}`);
    }
  }
  return readFile(join(root, path));
}

function decode(bytes, label) {
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    throw new Error(`Некорректная кодировка UTF-8: ${label}`);
  }
}

function parseJson(text, label) {
  try {
    return JSON.parse(text);
  } catch {
    throw new Error(`Некорректный JSON: ${label}`);
  }
}

function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}

/** Читает только src пакета и готовит файлы в памяти, не меняя рабочее дерево. */
export async function prepareBundle(root = repoRoot) {
  root = await realpath(root);
  const source = async (path) => {
    relativePath(path);
    const full = `${sourceRoot}/${path}`;
    const bytes = await fileState(root, full);
    requireCondition(bytes !== null, `Нет исходного файла: ${full}`);
    return textValue(decode(bytes, full), full);
  };
  const manifest = parseJson(await source("manifest.json"), `${sourceRoot}/manifest.json`);
  objectShape(manifest, ["version", "orchestrator", "agents"], "manifest.json");
  requireCondition(manifest.version === 1, "manifest.json: поддерживается только version: 1");
  requireCondition(validName(manifest.orchestrator), "manifest.json: неверное имя orchestrator");
  requireCondition(Array.isArray(manifest.agents), "manifest.json: agents должен быть массивом");
  const names = new Set();
  for (const agent of manifest.agents) {
    objectShape(agent, ["name", "kind", "description", "prompt", "readOnly"], "Агент");
    requireCondition(validName(agent.name), `Неверное имя агента: ${JSON.stringify(agent.name)}`);
    requireCondition(!names.has(agent.name), `Повтор имени агента: ${agent.name}`);
    names.add(agent.name);
    requireCondition(
      ["orchestrator", "worker"].includes(agent.kind),
      `${agent.name}: неверный kind`,
    );
    textValue(agent.description, `${agent.name}.description`);
    relativePath(agent.prompt);
    requireCondition(agent.prompt.endsWith(".md"), `${agent.name}: prompt должен ссылаться на .md`);
    requireCondition(
      !Object.hasOwn(agent, "readOnly") || typeof agent.readOnly === "boolean",
      `${agent.name}: readOnly должен быть булевым`,
    );
  }
  const primaries = manifest.agents.filter((agent) => agent.kind === "orchestrator");
  requireCondition(primaries.length === 1, "manifest.json: требуется ровно один оркестратор");
  requireCondition(
    primaries[0].name === manifest.orchestrator,
    "manifest.json: orchestrator не совпадает с именем оркестратора",
  );
  const agents = [];
  for (const agent of [...manifest.agents].sort((a, b) =>
    a.name < b.name ? -1 : a.name > b.name ? 1 : 0,
  )) {
    agents.push({ ...agent, body: await agentBody(await source(agent.prompt)) });
  }
  const output = await renderAdapters(agents, manifest.orchestrator);
  const lock = {
    version: 1,
    generator: GENERATOR,
    outputs: [...output].map(([path, content]) => ({ path, sha256: sha256(content) })),
  };
  return { root, agents, output, lock, lockText: await jsonDocument(lock) };
}

function managedPath(path) {
  relativePath(path);
  if (FIXED_OUTPUTS.has(path)) return true;
  const match =
    /^(?:\.opencode\/agents\/([^/]+)\.md|\.claude\/agents\/([^/]+)\.md|\.codex\/agents\/([^/]+)\.toml)$/.exec(
      path,
    );
  return match !== null && validName(match[1] ?? match[2] ?? match[3]);
}

async function previousLock(root) {
  const bytes = await fileState(root, lockPath);
  if (bytes === null) return { bytes, outputs: new Map() };
  const value = parseJson(decode(bytes, lockPath), lockPath);
  objectShape(value, ["version", "generator", "outputs"], lockPath);
  requireCondition(
    value.version === 1 && [GENERATOR, LEGACY_GENERATOR].includes(value.generator),
    `${lockPath}: неизвестная версия или владелец; файл сохранён`,
  );
  requireCondition(Array.isArray(value.outputs), `${lockPath}: outputs должен быть массивом`);
  const outputs = new Map();
  for (const entry of value.outputs) {
    objectShape(entry, ["path", "sha256"], lockPath);
    requireCondition(
      managedPath(entry.path),
      `${lockPath}: путь вне области сборщика: ${entry.path}`,
    );
    requireCondition(!outputs.has(entry.path), `${lockPath}: повтор пути: ${entry.path}`);
    requireCondition(
      typeof entry.sha256 === "string" && /^[0-9a-f]{64}$/.test(entry.sha256),
      `${lockPath}: неверный sha256: ${entry.path}`,
    );
    outputs.set(entry.path, entry.sha256);
  }
  return { bytes, outputs, legacy: value.generator === LEGACY_GENERATOR };
}

/** Проверяет все коллизии до первой записи; чужие файлы вне lock не перечисляются. */
async function inspectBundle(bundle) {
  const previous = await previousLock(bundle.root);
  const actual = new Map();
  const issues = [];
  const conflicts = [];
  for (const path of [...new Set([...bundle.output.keys(), ...previous.outputs.keys()])].sort()) {
    const bytes = await fileState(bundle.root, path);
    actual.set(path, bytes);
    const expected = bundle.output.get(path);
    const owned = previous.outputs.has(path);
    if (expected === undefined) {
      issues.push({ kind: "extra", path, message: "Лишний управляемый результат" });
    } else if (bytes === null) {
      issues.push({ kind: "missing", path, message: "Отсутствует результат" });
    } else if (!owned) {
      issues.push({ kind: "unmanaged", path, message: "Чужой файл занимает путь результата" });
      conflicts.push(
        `Чужой файл: ${path}. Перенесите его или согласуйте миграцию; автоматического присвоения нет.`,
      );
    } else if (!bytes.equals(Buffer.from(expected))) {
      issues.push({ kind: "outdated", path, message: "Устарел результат" });
    }
    if (
      owned &&
      bytes !== null &&
      sha256(bytes) !== previous.outputs.get(path) &&
      (previous.legacy || expected === undefined || !bytes.equals(Buffer.from(expected)))
    ) {
      conflicts.push(
        `Управляемый файл изменён вручную: ${path}. Сохраните правки в исходниках и восстановите файл по Git либо перенесите его перед сборкой.`,
      );
    }
  }
  if (previous.bytes === null || !previous.bytes.equals(Buffer.from(bundle.lockText))) {
    issues.push({
      kind: previous.bytes === null ? "missing" : "outdated",
      path: lockPath,
      message: previous.bytes === null ? "Отсутствует lock-файл" : "Устарел lock-файл",
    });
  }
  return { previous, actual, issues, conflicts };
}

/** Read-only проверка: возвращает все отсутствующие, устаревшие и лишние управляемые пути. */
export async function checkBundle({ root = repoRoot } = {}) {
  const bundle = await prepareBundle(root);
  const { issues } = await inspectBundle(bundle);
  return {
    version: 1,
    mode: "check",
    ok: issues.length === 0,
    agents: bundle.agents.length,
    outputs: bundle.output.size,
    issues,
  };
}

function sameBytes(a, b) {
  return a === null ? b === null : b !== null && a.equals(b);
}

/** Заменяет один файл атомарно; повторно проверяет путь перед публикацией. */
async function publish(root, path, text, before) {
  requireCondition(
    sameBytes(before, await fileState(root, path)),
    `Файл изменился во время сборки: ${path}`,
  );
  await mkdir(dirname(join(root, path)), { recursive: true });
  const temporary = join(dirname(join(root, path)), `.relay-agent-bundle-${randomUUID()}.tmp`);
  try {
    await writeFile(temporary, text, { flag: "wx" });
    requireCondition(
      sameBytes(before, await fileState(root, path)),
      `Файл изменился во время сборки: ${path}`,
    );
    await rename(temporary, join(root, path));
  } finally {
    await unlink(temporary).catch((error) => {
      if (error.code !== "ENOENT") throw error;
    });
  }
}

/** Публикует только собственные результаты и удаляет только неизменённые устаревшие файлы. */
export async function buildBundle({ root = repoRoot } = {}) {
  const bundle = await prepareBundle(root);
  const { previous, actual, conflicts } = await inspectBundle(bundle);
  requireCondition(conflicts.length === 0, conflicts.join("\n"));
  const written = [];
  const removed = [];
  for (const [path, text] of bundle.output) {
    if (actual.get(path)?.equals(Buffer.from(text))) continue;
    await publish(bundle.root, path, text, actual.get(path));
    written.push(path);
  }
  for (const [path, bytes] of actual) {
    if (bundle.output.has(path) || bytes === null) continue;
    requireCondition(
      sameBytes(bytes, await fileState(bundle.root, path)),
      `Файл изменился во время сборки: ${path}`,
    );
    await unlink(join(bundle.root, path));
    removed.push(path);
  }
  if (!previous.bytes?.equals(Buffer.from(bundle.lockText))) {
    await publish(bundle.root, lockPath, bundle.lockText, previous.bytes);
    written.push(lockPath);
  }
  return {
    version: 1,
    mode: "build",
    ok: true,
    agents: bundle.agents.length,
    outputs: bundle.output.size,
    written,
    removed,
  };
}
