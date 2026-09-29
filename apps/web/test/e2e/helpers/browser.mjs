import { execFile } from "node:child_process";
import { join } from "node:path";
import { promisify } from "node:util";
import { repositoryRoot } from "./stack.mjs";

const run = promisify(execFile);
const binary = join(repositoryRoot, "node_modules/.bin/agent-browser");
const config = join(repositoryRoot, "apps/web/agent-browser.json");

/**
 * Собственная headless-сессия agent-browser с конфигурацией Web.
 * Не использует пользовательский профиль, CDP или auto-connect; закрывает только себя.
 *
 * @param {string} session Уникальное имя сессии `tasks-web-...`.
 */
export function createBrowser(session) {
  const command = async (...args) => {
    const { stdout } = await run(
      binary,
      ["--config", config, "--session", session, "--json", ...args],
      {
        maxBuffer: 32 * 1024 * 1024,
        timeout: 120_000,
      },
    );
    const result = JSON.parse(stdout);
    if (!result.success)
      throw new Error(`agent-browser ${args[0]}: ${JSON.stringify(result.error)}`);
    return result.data;
  };
  return {
    session,
    command,
    open: (url) => command("open", url),
    /** Выполняет выражение в странице и возвращает его значение. */
    async eval(script) {
      const data = await command("eval", "-b", Buffer.from(script, "utf8").toString("base64"));
      return data.result;
    },
    /** Ждёт истинности выражения внутри страницы, без фиксированных пауз. */
    async waitFor(expression, timeout = 20_000) {
      const deadline = Date.now() + timeout;
      while (Date.now() < deadline) {
        const data = await command(
          "eval",
          "-b",
          Buffer.from(`Boolean(${expression})`, "utf8").toString("base64"),
        ).catch(() => ({ result: false }));
        if (data.result === true) return;
      }
      throw new Error(`Не дождались в браузере: ${expression}`);
    },
    viewport: (width, height) => command("set", "viewport", String(width), String(height)),
    media: (...values) => command("set", "media", ...values),
    screenshot: (path) => command("screenshot", "--full", path),
    a11y: () => command("a11y"),
    back: () => command("back"),
    forward: () => command("forward"),
    reload: () => command("reload"),
    errors: () => command("errors"),
    close: () => command("close"),
  };
}
