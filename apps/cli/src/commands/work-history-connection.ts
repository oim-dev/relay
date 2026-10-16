import { execFile } from "node:child_process";
import { promisify } from "node:util";
import type { AgentRun } from "@relay/contracts/work-history";
import type { CommandContext } from "../context.js";

const execute = promisify(execFile);
type Metadata = { operator?: AgentRun["operator"]; git?: AgentRun["git"] };

/** Метаданные клиента снимаются только при новом участии, без изменения Git. */
export async function workConnectionMetadata(
  context: CommandContext,
  options: Record<string, unknown>,
  attach: boolean,
): Promise<Metadata> {
  const { cwd, env } = context.runtime;
  const gitEnv: NodeJS.ProcessEnv = { ...env, GIT_TERMINAL_PROMPT: "0" };
  // Контекст принадлежит исходному cwd, а не репозиторию, подставленному GIT_DIR.
  for (const key of ["GIT_DIR", "GIT_WORK_TREE", "GIT_COMMON_DIR", "GIT_INDEX_FILE"])
    delete gitEnv[key];
  const git = async (...args: string[]): Promise<string | null> => {
    try {
      const result = await execute("git", args, {
        cwd,
        env: gitEnv,
        encoding: "utf8",
        timeout: 2000,
        maxBuffer: 64 * 1024,
      });
      return result.stdout.trim() || null;
    } catch {
      return null;
    }
  };
  const value = (input: unknown): string | null =>
    typeof input === "string" ? input.trim() || null : null;
  const metadata: Metadata = {};
  if (options.userName !== undefined || options.userEmail !== undefined) {
    metadata.operator = {
      name: value(options.userName),
      email: value(options.userEmail),
      source: "explicit",
    };
  } else if (env.RELAY_USER_NAME !== undefined || env.RELAY_USER_EMAIL !== undefined) {
    metadata.operator = {
      name: value(env.RELAY_USER_NAME),
      email: value(env.RELAY_USER_EMAIL),
      source: "environment",
    };
  }
  if ((await git("rev-parse", "--is-inside-work-tree")) !== "true") return metadata;
  const [branch, commit] = await Promise.all([
    git("symbolic-ref", "--quiet", "--short", "HEAD"),
    git("rev-parse", "--verify", "HEAD"),
  ]);
  metadata.git = { branch, commit };
  if (metadata.operator === undefined && !attach) {
    const [name, email] = await Promise.all([
      git("config", "--get", "user.name"),
      git("config", "--get", "user.email"),
    ]);
    if (name !== null || email !== null) metadata.operator = { name, email, source: "git" };
  }
  return metadata;
}
