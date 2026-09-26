import { ChildProcess } from "node:child_process";
import { performance } from "node:perf_hooks";
import { setTimeout as delay } from "node:timers/promises";

// Наблюдаем exit отдельно от close: у потомков ещё могут быть открыты stdout/stderr.
export function observeDevProcess(child: ChildProcess) {
  const started = performance.now();
  const elapsed = () => Math.round(performance.now() - started);
  let output = "";
  let transcript = "";
  let exited = false;
  let closed = false;
  let code: number | null = null;
  let signal: NodeJS.Signals | null = null;
  let spawnError: Error | undefined;
  const capture = (stream: string) => (text: string) => {
    output += text;
    transcript += `[${elapsed()} мс, ${stream}] ${text}`;
  };
  child.stdout?.setEncoding("utf8").on("data", capture("stdout"));
  child.stderr?.setEncoding("utf8").on("data", capture("stderr"));
  child.on("error", (error) => {
    spawnError = error;
  });
  child.once("exit", (exitCode, exitSignal) => {
    exited = true;
    code = exitCode;
    signal = exitSignal;
  });
  const completion = new Promise<void>((resolve) => {
    child.once("close", (exitCode, exitSignal) => {
      closed = true;
      code = exitCode;
      signal = exitSignal;
      resolve();
    });
  });
  const status = () =>
    `Node ${process.version}; elapsed=${elapsed()} мс; exit=${exited}; close=${closed}; ` +
    `code=${code}; signal=${signal}; spawnError=${spawnError?.message ?? "нет"}`;

  return {
    get output() {
      return output;
    },
    get closed() {
      return closed;
    },
    completion,
    status,
    async waitFor(
      condition: () => boolean,
      description: string,
      timeout = 12000,
      allowExit = false,
      failureReason?: () => string | undefined,
    ) {
      const waiting = performance.now();
      while (true) {
        const failure = spawnError
          ? "ошибка запуска дочернего процесса"
          : !allowExit && (exited || closed)
            ? "дочерний процесс завершился до готовности"
            : failureReason?.();
        if (!failure && condition()) return;
        if (failure || performance.now() - waiting >= timeout) {
          throw new Error(
            `${description}: ${failure ?? "таймаут ожидания"}; ` +
              `wait=${Math.round(performance.now() - waiting)} мс; budget=${timeout} мс\n` +
              `${status()}\nВывод дочернего процесса:\n${transcript || "(пусто)"}`,
          );
        }
        await delay(25);
      }
    },
    async waitForTypecheck(timeout: number) {
      await this.waitFor(
        () => /Found 0 errors\./.test(output),
        "initial/typecheck: ожидается успешная компиляция",
        timeout,
        false,
        () => {
          const result = /Found ([1-9]\d*) errors?\./.exec(output);
          return result ? `компиляция завершилась с ошибками: ${result[1]}` : undefined;
        },
      );
    },
  };
}
