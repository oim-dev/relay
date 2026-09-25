import { format } from "prettier";

const GENERATED = "Сгенерировано @relay/dev-agents; источник — packages/dev-agents/src.";
const FORMAT = { printWidth: 100, proseWrap: "preserve", endOfLine: "lf" };

/** Форматирует JSON одинаково на всех машинах, без чтения пользовательского конфига. */
export function jsonDocument(value) {
  return format(JSON.stringify(value), { ...FORMAT, parser: "json" });
}

/** Форматирует полный профиль одинаково для всех сред, без склейки других инструкций. */
export function agentBody(profile) {
  return format(profile.replace(/\r\n?/g, "\n"), {
    ...FORMAT,
    parser: "markdown",
  });
}

/** JSON-строки являются YAML-скалярами; разделители Unicode экранируются явно. */
function yamlValue(value) {
  return JSON.stringify(value).replace(
    /[\u0085\u2028\u2029]/g,
    (char) => `\\u${char.charCodeAt(0).toString(16).padStart(4, "0")}`,
  );
}

async function markdownAgent(fields, body) {
  const header = await format(
    `# ${GENERATED}\n${Object.entries(fields)
      .map(([key, value]) => `${key}: ${yamlValue(value)}`)
      .join("\n")}\n`,
    { ...FORMAT, parser: "yaml" },
  );
  return `---\n${header}---\n\n${body}`;
}

/** Кодирует TOML basic string, включая кавычки, обратные слеши и управляющие символы. */
function tomlString(value, multiline = false) {
  const escaped = value.replace(/[\\"\u0000-\u001f\u007f]/g, (char) => {
    if (char === "\n" && multiline) return "\n";
    if (char === "\\" || char === '"') return `\\${char}`;
    return `\\u${char.charCodeAt(0).toString(16).padStart(4, "0")}`;
  });
  return multiline ? `"""\n${escaped}"""` : `"${escaped}"`;
}

/** Преобразует проверенные исходники в независимые проектные настройки сред. */
export async function renderAdapters(agents, orchestrator) {
  const output = new Map();

  for (const agent of agents) {
    const primary = agent.kind === "orchestrator";
    output.set(
      `.opencode/agents/${agent.name}.md`,
      await markdownAgent(
        { description: agent.description, mode: primary ? "primary" : "subagent" },
        agent.body,
      ),
    );

    const claude = { name: agent.name, description: agent.description, model: "inherit" };
    output.set(`.claude/agents/${agent.name}.md`, await markdownAgent(claude, agent.body));

    if (!primary) {
      output.set(
        `.codex/agents/${agent.name}.toml`,
        [
          `# ${GENERATED}`,
          `name = ${tomlString(agent.name)}`,
          `description = ${tomlString(agent.description)}`,
          `developer_instructions = ${tomlString(agent.body, true)}`,
          "",
        ].join("\n"),
      );
    }
  }

  output.set(
    "opencode.json",
    await jsonDocument({
      $schema: "https://opencode.ai/config.json",
      default_agent: orchestrator,
    }),
  );
  output.set(".claude/settings.json", await jsonDocument({ agent: orchestrator }));
  output.set(
    ".codex/config.toml",
    [
      `# ${GENERATED}`,
      `developer_instructions = ${tomlString(agents.find((agent) => agent.name === orchestrator).body, true)}`,
      "",
      "[agents]",
      "enabled = true",
      "",
    ].join("\n"),
  );
  return new Map([...output].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)));
}
