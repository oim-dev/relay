import { createHash } from "node:crypto";
import { homedir } from "node:os";
import { basename, dirname, isAbsolute, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { realpath } from "node:fs/promises";
import { invariant, AppError } from "@relay/core/shared/errors";
import { git } from "./git.js";
import { exists } from "@relay/core/storage/files";

export interface RepositoryIdentity {
  identity: string;
  name: string;
  hash: string;
  origin: string;
}
export interface RepositoryContext {
  identity: string;
  name: string;
  hash: string;
  root: string;
  commonDir: string;
  origin?: string;
}
const knownHosts = new Set(["github.com", "gitlab.com", "bitbucket.org"]);

function urlPath(source: string) {
  const raw = source
    .replace(/^[a-z]+:\/\/[^/]*/i, "")
    .replace(/^\//, "")
    .replace(/\/$/, "");
  try {
    return raw
      .split("/")
      .map((part) => {
        const decoded = decodeURIComponent(part);
        invariant(
          decoded !== "." && decoded !== ".." && !/[\\/\x00-\x1f\x7f]/.test(decoded),
          "SYNC_ORIGIN_INVALID",
          "Небезопасный компонент адреса origin",
          2,
        );
        return decoded;
      })
      .join("/");
  } catch (error) {
    if (error instanceof AppError) throw error;
    throw new AppError("SYNC_ORIGIN_INVALID", "Некорректное кодирование пути origin", 2);
  }
}

export function normalizeOrigin(source: string, cwd = process.cwd()): RepositoryIdentity {
  invariant(
    source.length > 0 &&
      !/[\x00-\x1f\x7f]/.test(source) &&
      !source.startsWith("-") &&
      !/^[^/]+::/.test(source),
    "SYNC_ORIGIN_INVALID",
    "Некорректный адрес origin",
    2,
  );
  let identity: string,
    path: string,
    origin = source;
  const scp = !source.includes("://") && /^([^/@:]+@)?([^/:]+):(.+)$/.exec(source);
  if (scp && !/^[A-Za-z]:[\\/]/.test(source)) {
    const user = scp[1]?.slice(0, -1) ?? "";
    const host = scp[2]!.toLowerCase();
    path = scp[3]!;
    invariant(
      !path.startsWith("/") && !path.startsWith("~"),
      "SYNC_ORIGIN_INVALID",
      "Для SCP origin требуется относительный путь репозитория",
      2,
    );
    identity =
      knownHosts.has(host) && (!user || user === "git")
        ? `${host}/${path.replace(/\.git\/?$/, "").replace(/\/$/, "")}`
        : `ssh://${user ? `${user}@` : ""}${host}/${path}`;
  } else if (source.includes("://")) {
    let url: URL;
    try {
      url = new URL(source);
    } catch {
      throw new AppError("SYNC_ORIGIN_INVALID", "Некорректный URL origin", 2);
    }
    invariant(
      ["ssh:", "https:", "http:", "git:", "file:"].includes(url.protocol) &&
        !url.search &&
        !url.hash,
      "SYNC_ORIGIN_INVALID",
      "Неподдерживаемый адрес origin",
      2,
    );
    if (url.protocol === "file:") {
      path = resolve(fileURLToPath(url));
      identity = pathToFileURL(path).href;
      origin = path;
    } else {
      path = urlPath(source);
      const host = url.hostname.toLowerCase();
      const standard =
        knownHosts.has(host) &&
        (!url.port || (url.protocol === "ssh:" && url.port === "22")) &&
        (url.protocol === "https:" ||
          (url.protocol === "ssh:" && (!url.username || url.username === "git")));
      identity = standard
        ? `${host}/${path.replace(/\.git$/, "")}`
        : `${url.protocol}//${url.protocol === "ssh:" && url.username ? `${url.username}@` : ""}${url.host.toLowerCase()}/${path}`;
      // Credentials остаются у Git credential helper, а не в локальном состоянии Relay.
      if (url.protocol !== "ssh:") {
        url.username = "";
        url.password = "";
        origin = url.href;
      }
    }
  } else {
    path = resolve(cwd, source);
    identity = pathToFileURL(path).href;
    origin = path;
  }
  invariant(
    path.length > 0 && !path.split("/").some((part) => part === ".." || part === "."),
    "SYNC_ORIGIN_INVALID",
    "Некорректный путь репозитория",
    2,
  );
  const name =
    basename(path)
      .replace(/\.git$/, "")
      .replace(/[^\p{L}\p{N}_.-]/gu, "_")
      .slice(0, 64) || "repository";
  const hash = createHash("sha256").update(identity).digest("hex").slice(0, 32);
  return { identity, name, hash, origin };
}

export async function discoverRepository(cwd: string): Promise<RepositoryContext | undefined> {
  // Прежний файловый режим не требует установленного Git. Только реальный Git-контекст
  // разрешает запуск процесса и автоматическое подключение внешней базы.
  let directory = resolve(cwd);
  while (!(await exists(join(directory, ".git")))) {
    const parent = dirname(directory);
    if (parent === directory) return undefined;
    directory = parent;
  }
  const top = await git(cwd, ["rev-parse", "--show-toplevel"], { allowFailure: true });
  invariant(
    !top.code,
    "SYNC_GIT_FAILED",
    "Найденный Git-контекст повреждён или недоступен; файловая база не создаётся вместо него",
    4,
  );
  const root = top.stdout.toString("utf8").trim();
  const common = await git(root, ["rev-parse", "--path-format=absolute", "--git-common-dir"]);
  const commonDir = await realpath(common.stdout.toString("utf8").trim());
  const trees = await git(root, ["worktree", "list", "--porcelain", "-z"]);
  const main = trees.stdout
    .toString("utf8")
    .split("\0")
    .find((field) => field.startsWith("worktree "));
  const sourceRoot = main ? main.slice("worktree ".length) : root;
  const origin = await repositoryOrigin(sourceRoot);
  const identity = `git:${pathToFileURL(commonDir).href}`;
  return {
    identity,
    name: origin?.name ?? basename(sourceRoot),
    hash: createHash("sha256").update(identity).digest("hex").slice(0, 32),
    root: sourceRoot,
    commonDir,
    ...(origin ? { origin: origin.origin } : {}),
  };
}

/** Относительный remote принадлежит основному checkout, а не внешнему каталогу базы. */
export async function repositoryOrigin(
  sourceRoot: string,
): Promise<RepositoryIdentity | undefined> {
  const remote = await git(sourceRoot, ["remote", "get-url", "origin"], { allowFailure: true });
  if (remote.code === 2) return undefined;
  invariant(
    !remote.code,
    "SYNC_GIT_FAILED",
    "Не удалось прочитать origin; проверьте Git-конфигурацию",
    4,
  );
  const address = remote.stdout.toString("utf8").trim();
  const normalized = normalizeOrigin(address, sourceRoot);
  if (isAbsolute(normalized.origin)) {
    const canonical = await realpath(normalized.origin).catch(() => normalized.origin);
    return normalizeOrigin(canonical, sourceRoot);
  }
  return normalized;
}

export function repositoryDirectory(
  repository: Pick<RepositoryContext, "name" | "hash">,
  home = join(homedir(), ".relay"),
) {
  return join(resolve(home), `${repository.name}-${repository.hash}`);
}
