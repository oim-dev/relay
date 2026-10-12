// @ts-nocheck — исторический генератор-документация; тесты и typecheck его не исполняют.
// Общие тексты и запуск исторического CLI для генерации замороженных фикстур.
// Скрипт — документация происхождения; тесты его не исполняют.
import { spawnSync } from "node:child_process";
import { writeFileSync, appendFileSync } from "node:fs";
import { join } from "node:path";

/** Значимые тексты: CRLF, Unicode, завершающие переводы строк, пробелы. */
export const TEXT = {
  crlf: "# Заголовок CRLF\r\n\r\nПервая строка\r\nВторая строка с пробелами в конце   \r\n",
  unicode:
    "Юникод: ёЁ, 中文字符, emoji 🚀👩‍💻, й (и + U+0306), RTL שלום, NBSP здесь, табуляция\tвнутри\n\n",
  trailing: "Строка без перевода в конце",
  mixed: "LF-строка\nCRLF-строка\r\n\nПустая строка выше\n\n\n",
  markdown:
    "## Требования\n\n- пункт **жирный**\n- пункт `code`\n\n```ts\nconst x = 1;\r\n```\n\n> цитата\n",
};

/** Длинный комментарий ~12 КиБ с многострочным Markdown и CRLF внутри. */
export function longComment() {
  const lines = [];
  for (let index = 1; index <= 160; index++)
    lines.push(
      `${index}. Длинная строка комментария №${index} — проверка сохранности 🚀 текста${index % 7 === 0 ? "\r" : ""}`,
    );
  return `# Длинный комментарий\n\n${lines.join("\n")}\n\nКонец.\n`;
}

const WORDS = new Set([
  "task",
  "link",
  "move",
  "criterion",
  "complete",
  "reopen",
  "plan",
  "stage",
  "create",
  "remove",
  "include",
  "exclude",
  "start",
  "cancel",
  "release",
  "publish",
  "update",
  "comment",
  "entities",
  "rename",
  "transfer",
  "add",
  "stages",
  "get",
]);

export function createRunner({ bin, db, transcript, actor = "fixture-author", env = {} }) {
  writeFileSync(transcript, "");
  let step = 0;
  const run = (args, { allowFail = false, as = actor } = {}) => {
    step++;
    const result = spawnSync(bin, ["--local", "--format", "json", ...args], {
      cwd: db,
      env: { ...process.env, ...env, RELAY_ACTOR: as, NO_COLOR: "1", DB: db },
      encoding: "utf8",
      maxBuffer: 64 * 1024 * 1024,
    });
    const out = result.stdout.trim();
    let parsed;
    try {
      parsed = JSON.parse(out.split("\n").filter(Boolean).at(-1) ?? "null");
    } catch {
      parsed = { ok: false, raw: out, stderr: result.stderr };
    }
    appendFileSync(
      transcript,
      JSON.stringify({ step, args: args.map(redact), ok: parsed?.ok ?? false }) + "\n",
    );
    if (
      !parsed?.ok &&
      typeof parsed?.error?.message === "string" &&
      parsed.error.message.includes("required option '--if-revision") &&
      !args.includes("--if-revision")
    ) {
      // Старые команды требуют прочитанную ревизию: читаем её той же версией и повторяем.
      const ref = args.find((arg, index) => index > 0 && !arg.startsWith("--") && !WORDS.has(arg));
      const revision = run(["entities", "get", ref]).revision;
      step--;
      return run([...args, "--if-revision", String(revision)], { allowFail, as });
    }
    if (!parsed?.ok && !allowFail) {
      console.error("FAILED", args, out.slice(0, 4000), result.stderr.slice(0, 4000));
      process.exit(1);
    }
    return parsed?.data ?? parsed;
  };
  return run;
}

/** В журнале шагов длинные тексты заменяются длиной, чтобы не дублировать oracle. */
function redact(value) {
  return value.length > 120 ? `<text ${value.length} chars>` : value;
}

export function save(path, value) {
  writeFileSync(path, JSON.stringify(value, null, 2) + "\n");
}
export { join };
