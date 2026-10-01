import type { Command } from "commander";
import { createHash } from "node:crypto";
import { resolve } from "node:path";
import { z } from "zod";
import { AppError, invariant } from "@relay/core/shared/errors";
import type { CommandContext } from "./context.js";
import { cursorOptions } from "./options.js";
import type { CliPage } from "./queries/result.js";

const kebab = (name: string) => name.replace(/[A-Z]/g, (letter) => `-${letter.toLowerCase()}`);

export function textOption(command: Command, name: string, description: string): Command {
  const flag = kebab(name);
  return command
    .option(`--${flag} <text>`, description)
    .option(`--${flag}-file <path>`, `${description}: UTF-8 файл; - означает stdin`);
}

/** Ограничение чтения, а не предметная схема поля: окончательную проверку делает Core. */
const INPUT_READ_LIMIT = 128 * 1024 * 1024;

export async function readTextFields(
  context: CommandContext,
  options: object,
  names: readonly string[],
): Promise<Record<string, string>> {
  const values = options as Record<string, unknown>;
  const sources = names.map((name) => {
    const value = values[name];
    const file = values[`${name}File`];
    invariant(
      value === undefined || typeof value === "string",
      "INVALID_ARGUMENT",
      `--${kebab(name)} ожидает текст`,
    );
    invariant(
      file === undefined || typeof file === "string",
      "INVALID_ARGUMENT",
      `--${kebab(name)}-file ожидает путь`,
    );
    invariant(
      value === undefined || file === undefined,
      "CONFLICTING_OPTIONS",
      `Укажите только --${kebab(name)} или --${kebab(name)}-file`,
    );
    return { name, value, file };
  });
  invariant(
    sources.filter(({ file }) => file === "-").length <= 1,
    "CONFLICTING_OPTIONS",
    "stdin можно прочитать только для одного поля; для остальных укажите текст или файл",
  );
  const result: Record<string, string> = {};
  for (const { name, value, file } of sources) {
    const text = await context.runtime.input.text(value, file, INPUT_READ_LIMIT);
    if (text !== undefined) result[name] = text;
  }
  return result;
}

export function paging(command: Command): Command {
  return cursorOptions(command);
}

type Consistency = CliPage["consistency"];
type Controls = { limit?: number; cursor?: string };
export type OffsetQuery = { offset: number; limit: number; version?: string };
type NativeQuery = { limit: number; cursor?: string };

/** Контекст пагинации без Backend и I/O. invocation — исходные аргументы, не shell-строка. */
export type PaginationContext = {
  identity: Record<string, unknown>;
  defaultLimit: number;
  invocation: readonly string[];
};
const CURSOR_LIMIT = 32 * 1024;
const cursorSchema = z
  .object({
    v: z.literal(1),
    type: z.enum(["offset", "native"]),
    scope: z.string().regex(/^[a-f0-9]{64}$/),
    command: z.array(z.string()).min(1),
    filters: z.record(z.string(), z.unknown()),
    consistency: z.enum(["snapshot", "live"]),
    limit: z.number().int().min(1).max(100),
    offset: z.number().int().min(0).max(Number.MAX_SAFE_INTEGER).optional(),
    version: z.string().min(1).optional(),
    native: z.string().min(1).optional(),
  })
  .strict();
type Cursor = z.infer<typeof cursorSchema>;

function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (value !== null && typeof value === "object") {
    return `{${Object.entries(value)
      .filter(([, item]) => item !== undefined)
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
      .map(([key, item]) => `${JSON.stringify(key)}:${canonical(item)}`)
      .join(",")}}`;
  }
  return JSON.stringify(value) ?? "null";
}

function scope(context: PaginationContext): string {
  return createHash("sha256").update(canonical(context.identity)).digest("hex");
}

function invalidCursor(): never {
  throw new AppError(
    "INVALID_CURSOR",
    "Курсор повреждён или несовместим с командой, фильтрами либо проектом. Начните список заново без --cursor",
  );
}

function decode(
  context: PaginationContext,
  options: Controls,
  command: readonly string[],
  filters: Record<string, unknown>,
  consistency: Consistency,
  type: Cursor["type"],
): Cursor | undefined {
  if (
    options.limit !== undefined &&
    (!Number.isInteger(options.limit) || options.limit < 1 || options.limit > 100)
  ) {
    throw new AppError("INVALID_ARGUMENT", "--limit должен быть целым числом от 1 до 100");
  }
  if (options.cursor === undefined) return undefined;
  const token = options.cursor;
  if (!token.length || token.length > CURSOR_LIMIT || !/^[A-Za-z0-9_-]+$/.test(token))
    invalidCursor();
  let cursor: Cursor;
  try {
    const buffer = Buffer.from(token, "base64url");
    if (buffer.toString("base64url") !== token) invalidCursor();
    cursor = cursorSchema.parse(
      JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(buffer)),
    );
  } catch {
    return invalidCursor();
  }
  if (
    cursor.type !== type ||
    cursor.scope !== scope(context) ||
    cursor.consistency !== consistency ||
    canonical(cursor.command) !== canonical(command)
  )
    invalidCursor();
  if (
    type === "offset" &&
    (cursor.offset === undefined ||
      cursor.native !== undefined ||
      (consistency === "snapshot" && !cursor.version))
  )
    invalidCursor();
  if (type === "native" && (!cursor.native || cursor.offset !== undefined)) invalidCursor();
  if (options.limit !== undefined && cursor.limit !== options.limit) invalidCursor();
  for (const [key, value] of Object.entries(filters)) {
    if (value !== undefined && canonical(value) !== canonical(cursor.filters[key])) invalidCursor();
  }
  // Восстанавливаем пропущенные фильтры до формирования запроса Backend.
  for (const [key, value] of Object.entries(cursor.filters)) {
    if (["__proto__", "constructor", "prototype"].includes(key)) invalidCursor();
    filters[key] = value;
  }
  return cursor;
}

function limit(context: PaginationContext, options: Controls): number {
  return options.limit ?? Math.max(1, Math.min(100, context.defaultLimit));
}

/** version проверяет неизменность текущего состояния; историческое состояние недоступно. */
export function offsetQueryFor(
  context: PaginationContext,
  options: Controls,
  command: readonly string[],
  filters: Record<string, unknown>,
  consistency: Consistency = "snapshot",
): OffsetQuery {
  const cursor = decode(context, options, command, filters, consistency, "offset");
  return {
    offset: cursor?.offset ?? 0,
    limit: cursor?.limit ?? limit(context, options),
    ...(cursor?.version && consistency === "snapshot" ? { version: cursor.version } : {}),
  };
}

export function offsetQuery(
  context: CommandContext,
  options: Controls,
  command: readonly string[],
  filters: Record<string, unknown>,
  consistency: Consistency = "snapshot",
): OffsetQuery {
  const query = offsetQueryFor(
    projectPaginationContext(context),
    options,
    command,
    filters,
    consistency,
  );
  if (query.version !== undefined) context.offsetVersion = query.version;
  else delete context.offsetVersion;
  return query;
}

/** Кавычки POSIX shell; управляющие символы не становятся исполняемыми командами. */
function quote(value: string): string {
  if (/[\x00-\x1f\x7f-\x9f\u2028\u2029]/.test(value)) {
    // ANSI-C quoting поддерживается bash/zsh и сохраняет переносы внутри одного аргумента.
    return `$'${value
      .replaceAll("\\", "\\\\")
      .replaceAll("'", "\\'")
      .replace(
        /[\x00-\x1f\x7f-\x9f\u2028\u2029]/g,
        (character) => `\\u${character.charCodeAt(0).toString(16).padStart(4, "0")}`,
      )}'`;
  }
  return /^[a-zA-Z0-9_./:@=,+-]+$/.test(value) ? value : `'${value.replaceAll("'", "'\\''")}'`;
}

/** Одна строка shell-команды из исходных аргументов, без I/O и контекста подключения. */
export function shellCommand(argv: readonly string[]): string {
  return argv.map(quote).join(" ");
}

function projectInvocation(context: CommandContext): string[] {
  const globals = context.globals;
  const args = ["npx", "@oim-dev/relay-cli"];
  if (context.backend.kind === "local") {
    args.push("--local", "--config", resolve(context.runtime.cwd, context.workspace.configPath));
    if (globals.project) args.push("--project", globals.project);
  } else {
    const url = context.connection ?? globals.serverUrl ?? context.runtime.env.RELAY_SERVER_URL;
    invariant(url, "CONNECTION_REQUIRED", "Не удалось сохранить адрес подключения для команды");
    args.push("--server-url", url);
    const project = globals.project ?? context.workspace.config.projectId;
    if (project) args.push("--project", project);
    const config = globals.config ?? context.runtime.env.RELAY_CONFIG;
    if (config) args.push("--config", resolve(context.runtime.cwd, config));
  }
  if (globals.actor) args.push("--actor", globals.actor);
  if (globals.format) args.push("--format", globals.format);
  return args;
}

/** Полная команда с фактическим подключением, без обязательного курсора и переносов по ширине. */
export function commandInvocation(context: CommandContext, command: readonly string[]): string {
  return shellCommand([...projectInvocation(context), ...command]);
}

/** Идентичность сохраняет прежний состав полей: уже выданные project cursors совместимы. */
function projectPaginationContext(context: CommandContext): PaginationContext {
  return {
    identity: {
      kind: context.backend.kind,
      project: context.workspace.config.projectId,
      root: context.workspace.root,
      config: context.workspace.configPath,
      connection:
        context.connection ?? context.globals.serverUrl ?? context.runtime.env.RELAY_SERVER_URL,
    },
    defaultLimit: context.workspace.config.output.defaultLimit,
    invocation: projectInvocation(context),
  };
}

function continuationCommandFor(
  context: PaginationContext,
  command: readonly string[],
  filters: Record<string, unknown>,
  cursor: string,
): string {
  const args = [...context.invocation, ...command];
  for (const [name, value] of Object.entries(filters)) {
    if (value === undefined || value === null) continue;
    args.push(`--${kebab(name)}`, Array.isArray(value) ? value.join(",") : String(value));
  }
  args.push("--cursor", cursor);
  return shellCommand(args);
}

export function continuationCommand(
  context: CommandContext,
  command: readonly string[],
  filters: Record<string, unknown>,
  cursor: string,
): string {
  return continuationCommandFor(projectPaginationContext(context), command, filters, cursor);
}

function page(
  context: PaginationContext,
  command: readonly string[],
  filters: Record<string, unknown>,
  count: number,
  total: number | undefined,
  pageLimit: number,
  consistency: Consistency,
  position?: Pick<Cursor, "type" | "offset" | "version" | "native">,
): CliPage {
  let nextCursor: string | null = null;
  if (position) {
    nextCursor = Buffer.from(
      canonical({
        v: 1,
        scope: scope(context),
        command,
        filters,
        consistency,
        limit: pageLimit,
        ...position,
      }),
    ).toString("base64url");
    invariant(
      nextCursor.length <= CURSOR_LIMIT,
      "CURSOR_TOO_LARGE",
      "Фильтры слишком велики для курсора продолжения; сократите параметры поиска",
    );
  }
  return {
    count,
    ...(total === undefined ? {} : { total }),
    limit: pageLimit,
    consistency,
    nextCursor,
    nextCommand: nextCursor ? continuationCommandFor(context, command, filters, nextCursor) : null,
  };
}

export function pageResultFor(
  context: PaginationContext,
  command: readonly string[],
  filters: Record<string, unknown>,
  query: OffsetQuery,
  data: { items: readonly unknown[]; total: number; nextOffset: number | null; version?: string },
  consistency: Consistency = "snapshot",
): CliPage {
  invariant(
    consistency !== "snapshot" || query.version === undefined || data.version === query.version,
    "VERSION_CONFLICT",
    data.version === undefined
      ? "Backend не подтвердил исходную версию текущего состояния. Продолжение не может считаться согласованным. Версия не даёт доступа к историческому снимку. Начните чтение заново без --cursor"
      : "Текущее состояние изменилось, курсор устарел. Версия проверяет неизменность данных и не даёт доступа к историческому снимку. Начните чтение заново без --cursor",
  );
  // Продолжение сохраняет исходную версию; только первая страница устанавливает её из ответа.
  const version = query.version ?? data.version;
  invariant(
    consistency !== "snapshot" || data.nextOffset === null || !!version,
    "SNAPSHOT_REQUIRED",
    "Backend не вернул версию текущего состояния для проверки неизменности при продолжении списка; доступ к историческому снимку не поддерживается",
  );
  invariant(
    data.nextOffset === null ||
      (Number.isSafeInteger(data.nextOffset) && data.nextOffset > query.offset),
    "INVALID_PAGE_RESPONSE",
    "Некорректный ответ Backend: следующая позиция страницы должна быть строго больше текущей. Продолжение остановлено, чтобы избежать бесконечного цикла. Проверьте Backend и начните чтение без --cursor",
  );
  return page(
    context,
    command,
    filters,
    data.items.length,
    data.total,
    query.limit,
    consistency,
    data.nextOffset === null
      ? undefined
      : {
          type: "offset",
          offset: data.nextOffset,
          ...(consistency === "snapshot" ? { version } : {}),
        },
  );
}

export function pageResult(
  context: CommandContext,
  command: readonly string[],
  filters: Record<string, unknown>,
  query: OffsetQuery,
  data: { items: readonly unknown[]; total: number; nextOffset: number | null; version?: string },
  consistency: Consistency = "snapshot",
): CliPage {
  return pageResultFor(
    projectPaginationContext(context),
    command,
    filters,
    query,
    data,
    consistency,
  );
}

/**
 * Тип курсора без проверки: позволяет команде с двумя режимами выбрать режим по одному --cursor.
 * Полная проверка контекста выполняется при декодировании выбранным режимом.
 */
export function cursorType(token: string | undefined): Cursor["type"] | undefined {
  if (token === undefined || token.length > CURSOR_LIMIT || !/^[A-Za-z0-9_-]+$/.test(token))
    return undefined;
  try {
    const type: unknown = JSON.parse(Buffer.from(token, "base64url").toString("utf8"))?.type;
    return type === "native" || type === "offset" ? type : undefined;
  } catch {
    return undefined;
  }
}

/** Восстанавливает CLI-фильтры (например, by) и limit; opaque token Backend передаётся без изменений. */
export function nativeQuery(
  context: CommandContext,
  options: Controls,
  command: readonly string[],
  filters: Record<string, unknown>,
  consistency: Consistency = "live",
): NativeQuery {
  const pagination = projectPaginationContext(context);
  const cursor = decode(pagination, options, command, filters, consistency, "native");
  return {
    limit: cursor?.limit ?? limit(pagination, options),
    ...(cursor?.native ? { cursor: cursor.native } : {}),
  };
}

/** Граница snapshot остаётся в native token Backend; CLI не создаёт новую границу при продолжении. */
export function nativePageResult(
  context: CommandContext,
  command: readonly string[],
  filters: Record<string, unknown>,
  query: NativeQuery,
  data: { items: readonly unknown[]; total?: number; nextCursor: string | null; snapshot?: number },
  consistency: Consistency = "live",
): CliPage {
  invariant(
    data.nextCursor === null ||
      (typeof data.nextCursor === "string" &&
        data.nextCursor.length > 0 &&
        data.nextCursor !== query.cursor),
    "INVALID_PAGE_RESPONSE",
    "Некорректный ответ Backend: следующий курсор пуст или повторяет текущий. Продолжение остановлено, чтобы избежать бесконечного цикла. Проверьте Backend и начните чтение без --cursor",
  );
  return page(
    projectPaginationContext(context),
    command,
    filters,
    data.items.length,
    data.total,
    query.limit,
    consistency,
    data.nextCursor === null ? undefined : { type: "native", native: data.nextCursor },
  );
}
