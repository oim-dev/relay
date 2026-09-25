import { constants } from "node:fs";
import {
  access,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rm,
  rmdir,
  stat,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { sourceRoot } from "./lib.mjs";

/** Создаёт исходники только во временном каталоге; реальные роли проекта не читает. */
export async function fixture(t) {
  let temporary = join(tmpdir(), "opencode");
  let local = false;
  try {
    await mkdir(temporary, { recursive: true });
    await access(temporary, constants.W_OK);
  } catch (error) {
    if (error.code !== "EACCES" && error.code !== "EPERM") throw error;
    // В некоторых средах /tmp/opencode принадлежит root: остаёмся в области тестов.
    temporary = join(dirname(fileURLToPath(import.meta.url)), ".tmp-tests");
    local = true;
  }
  await mkdir(temporary, { recursive: true });
  const root = await mkdtemp(join(temporary, "relay agent bundle "));
  const cleanup = async () => {
    await rm(root, { recursive: true, force: true });
    if (local)
      await rmdir(temporary).catch((error) => {
        if (error.code !== "ENOENT" && error.code !== "ENOTEMPTY") throw error;
      });
  };
  t?.after(cleanup);
  const put = async (path, text) => {
    await mkdir(dirname(join(root, path)), { recursive: true });
    await writeFile(join(root, path), text);
  };
  const manifest = {
    version: 1,
    orchestrator: "relay-orchestrator",
    agents: [
      "orchestrator",
      "frontend",
      "backend",
      "cli",
      "mcp",
      "core",
      "delivery",
      "docs",
      "qa",
    ].map((role) => ({
      name: `relay-${role}`,
      kind: role === "orchestrator" ? "orchestrator" : "worker",
      description: `Профиль Relay: ${role}`,
      prompt: `${role}.md`,
    })),
  };
  const saveManifest = () => put(`${sourceRoot}/manifest.json`, JSON.stringify(manifest));
  await saveManifest();
  const commonRules =
    "Соблюдай общие правила корневого AGENTS.md; если они не переданы средой, прочитай файл один раз.\n";
  const prompts = new Map(
    manifest.agents.map((agent) => [
      agent.name,
      `## ${agent.name}\n\n${commonRules}\nПрофильный результат.\n`,
    ]),
  );
  prompts.set(
    "relay-orchestrator",
    `# Оркестратор

${commonRules}
## Область роли

Ты координируешь работу только главной сессии. Воркеры выполняют свои профильные поручения.

## Порядок работы

1. Выбери профильного исполнителя и передай цель, входы и критерии приёмки.
2. Сверь результат с критериями и сообщи пользователю проверки и ограничения.
`,
  );
  for (const agent of manifest.agents) {
    await put(`${sourceRoot}/${agent.prompt}`, prompts.get(agent.name));
  }
  return { root, manifest, prompts, put, saveManifest, cleanup };
}

/** Снимок содержимого и mtime подтверждает, что check не переписывает даже прежние байты. */
export async function snapshot(root, prefix = "") {
  const result = {};
  for (const entry of (await readdir(join(root, prefix), { withFileTypes: true })).sort((a, b) =>
    a.name < b.name ? -1 : a.name > b.name ? 1 : 0,
  )) {
    const path = prefix ? `${prefix}/${entry.name}` : entry.name;
    if (entry.isDirectory()) Object.assign(result, await snapshot(root, path));
    else
      result[path] = {
        bytes: (await readFile(join(root, path))).toString("base64"),
        mtime: (await stat(join(root, path))).mtimeMs,
      };
  }
  return result;
}

/** Читает ограниченный JSON-совместимый поднабор YAML, выпускаемый адаптерами. */
export function readAgentMarkdown(text) {
  const match = /^---\n([\s\S]*?)\n---\n\n([\s\S]*)$/.exec(text);
  if (!match) throw new Error("В результате нет frontmatter");
  const fields = {};
  const entries = match[1].split(/\n(?=[a-zA-Z]+:)/);
  for (const entry of entries) {
    if (entry.startsWith("#")) continue;
    const colon = entry.indexOf(":");
    const value = entry
      .slice(colon + 1)
      .trim()
      .replace(/\n\s*/g, " ")
      .replace(/,(\s*)\]$/, "$1]");
    fields[entry.slice(0, colon)] = JSON.parse(value);
  }
  return { fields, body: match[2] };
}

/** TOML basic strings адаптера используют общий с JSON набор escape-последовательностей. */
export function readTomlString(text, key) {
  const multiline = new RegExp(`^${key} = """\\n([\\s\\S]*?)"""\\n`, "m").exec(text);
  if (multiline) return JSON.parse(`"${multiline[1].replaceAll("\n", "\\n")}"`);
  const single = new RegExp(`^${key} = ("[^\\n]*")$`, "m").exec(text);
  if (!single) throw new Error(`Нет строки TOML: ${key}`);
  return JSON.parse(single[1]);
}
