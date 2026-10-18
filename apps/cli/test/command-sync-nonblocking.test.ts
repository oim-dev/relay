import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdir, rename } from "node:fs/promises";
import { join, dirname } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { git, gitText } from "@relay/project-runtime/git-storage/git";
import { readState } from "@relay/project-runtime/git-storage/state";
import { gitMetadataDirectory } from "@relay/core/storage/access";
import { exists } from "@relay/core/storage/files";
import { httpServer } from "./helpers/http.js";
import { invoke, invokeRaw, successful, tempDirectory, fixtureCleanup } from "./helpers/cli.js";
import type { SynchronizationStatus } from "@relay/contracts/synchronization";

async function until(check: () => Promise<boolean>, message: string) {
  const deadline = Date.now() + 20000;
  while (Date.now() < deadline) {
    if (await check()) return;
    await delay(50);
  }
  assert.fail(message);
}

test(
  "Офлайн: работающий Server, local/HTTP запись, предупреждения и автоматическая доставка",
  { timeout: 45000 },
  async (t) => {
    const directory = await tempDirectory(t),
      code = join(directory, "code"),
      origin = join(directory, "origin.git");
    await mkdir(code);
    await git(code, ["init"]);
    await git(code, ["init", "--bare", origin]);
    await git(code, ["remote", "add", "origin", origin]);
    const options = { subprocess: true, env: { RELAY_HOME: join(directory, "home") } };
    const initialized = successful(
      await invoke<{ configPath: string }>(code, ["init"], options),
    ).data;
    const root = dirname(initialized.configPath),
      gitDir = await gitMetadataDirectory(root);
    fixtureCleanup(t, () =>
      until(
        async () =>
          !(await exists(join(gitDir, "relay-worker/write.lock"))) &&
          !(await exists(join(gitDir, "relay-worker-start.json"))),
        "Worker не завершился",
      ),
    );
    const server = await httpServer(t, code);
    const choices = [["--local"], ["--server-url", server.url]];
    await rename(origin, `${origin}.offline`);
    try {
      for (const [transport, args] of choices.entries()) {
        for (let index = 0; index < 2; index++) {
          const result = await invoke(
            code,
            [
              ...args,
              "document",
              "create",
              "--name",
              `offline-${transport}-${index}`,
              "--body",
              "# Локальные знания\n",
            ],
            options,
          );
          successful(result);
        }
      }
      await until(
        async () => (await readState(root)).error !== null,
        "Ошибка origin не появилась в статусе",
      );
      for (const [transport, args] of choices.entries()) {
        const saved = successful(
          await invoke(
            code,
            [
              ...args,
              "document",
              "create",
              "--name",
              `warn-${transport}`,
              "--body",
              "Сохранено без VPN",
            ],
            options,
          ),
        );
        assert(saved.meta?.warnings?.some((message) => message.includes("сохранены локально")));
        assert(saved.meta?.synchronization?.error);
        const overview = successful(await invoke(code, [...args, "overview"], options));
        assert(overview.meta?.synchronization?.error);
        const human = await invokeRaw(code, [...args, "overview"], options);
        assert.equal(human.code, 0, human.stdout);
        assert.match(human.stdout, /Коммиты без подтверждения/);
        assert.match(human.stdout, /Изменения вне коммитов/);
        const documents = successful(
          await invoke<{ total: number }>(code, [...args, "document", "list"], options),
        );
        assert.equal(documents.data.total, 5 + transport);
      }
      const response = await fetch(`${server.url}/api/v1/context/sync`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: "{}",
      });
      assert.equal(response.status, 202);
      assert(((await response.json()) as { data: SynchronizationStatus }).data.origin);
    } finally {
      await rename(`${origin}.offline`, origin);
    }
    await until(async () => {
      const response = await fetch(`${server.url}/api/v1/context/sync`);
      return ((await response.json()) as { data: SynchronizationStatus }).data.status === "synced";
    }, "После включения VPN очередь не отправилась");
    assert.equal(
      await gitText(root, ["rev-parse", "HEAD"]),
      await gitText(origin, ["rev-parse", "relay-data"]),
    );
    successful(await invoke(code, ["--local", "doctor", "check"], options));
    const documents = successful(
      await invoke<{ total: number }>(code, ["--local", "document", "list"], options),
    );
    assert.equal(documents.data.total, 6);
  },
);
