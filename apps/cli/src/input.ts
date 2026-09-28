import { createReadStream } from "node:fs";
import { Readable } from "node:stream";
import { resolve } from "node:path";
import { AppError, invariant } from "@relay/core/shared/errors";

/** Один stdin нельзя неявно использовать сразу для нескольких независимых полей. */
export class InputReader {
  private used = false;
  constructor(
    private readonly stdin: Readable,
    private readonly cwd = process.cwd(),
  ) {}

  source(text: string | undefined, file: string | undefined): AsyncIterable<Buffer | string> {
    invariant(
      (text !== undefined ? 1 : 0) + (file !== undefined ? 1 : 0) === 1,
      "INPUT_SOURCE_REQUIRED",
      "Укажите ровно один источник текста: аргумент или --file (stdin: --file -)",
    );
    if (text !== undefined) return Readable.from([Buffer.from(text)]);
    if (file !== "-") {
      const path = resolve(this.cwd, file!);
      // Файл открывается при потреблении потока, после проверки метаданных команды.
      return (async function* () {
        yield* createReadStream(path);
      })();
    }
    invariant(!this.used, "STDIN_ALREADY_USED", "stdin уже используется другим полем");
    this.used = true;
    return this.stdin;
  }

  async text(
    value: string | undefined,
    file: string | undefined,
    maxBytes: number,
  ): Promise<string | undefined> {
    if (value === undefined && file === undefined) return undefined;
    const buffers: Buffer[] = [];
    let size = 0;
    try {
      for await (const chunk of this.source(value, file)) {
        const buffer = typeof chunk === "string" ? Buffer.from(chunk) : chunk;
        size += buffer.length;
        invariant(size <= maxBytes, "INPUT_TOO_LARGE", `Текст превышает ${maxBytes} байт`);
        buffers.push(buffer);
      }
    } catch (error) {
      if (error instanceof AppError) throw error;
      throw new AppError(
        "INPUT_READ_FAILED",
        file === "-"
          ? "Не удалось прочитать stdin; проверьте источник данных"
          : `Не удалось прочитать файл «${file}»; проверьте путь и права доступа`,
      );
    }
    try {
      return new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(
        Buffer.concat(buffers),
      );
    } catch {
      throw new AppError("INVALID_UTF8", "Текст должен быть корректным UTF-8");
    }
  }
}
