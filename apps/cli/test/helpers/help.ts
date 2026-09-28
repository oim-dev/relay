import { Readable, Writable } from "node:stream";
import type { Command } from "commander";
import { runtime } from "../../src/context.js";
import { createProgram } from "../../src/program.js";
import { runCli } from "../../src/run.js";

/** Только справка/разбор: это не покрытие предметных обработчиков. */
export function helpRuntime(cwd: string) {
  let stdout = "";
  const io = runtime(
    Readable.from([]),
    new Writable({
      write(chunk, _encoding, done) {
        stdout += chunk.toString();
        done();
      },
    }),
    cwd,
  );
  io.env = { RELAY_CONFIG: `${cwd}/absent-config.json`, FORCE_COLOR: "3", COLUMNS: "40" };
  return { io, output: () => stdout };
}

export function commandTree(cwd: string): { command: Command; path: string[] }[] {
  const result: { command: Command; path: string[] }[] = [];
  const visit = (command: Command, path: string[]) => {
    result.push({ command, path });
    for (const child of command.commands) visit(child, [...path, child.name()]);
  };
  visit(createProgram(helpRuntime(cwd).io), []);
  return result;
}

export async function renderHelp(cwd: string, args: string[]) {
  const capture = helpRuntime(cwd);
  const code = await runCli(args, capture.io);
  return { code, stdout: capture.output() };
}
