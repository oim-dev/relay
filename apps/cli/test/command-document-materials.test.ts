import assert from "node:assert/strict";
import { test } from "node:test";
import { fixture, failed, invoke, invokeRaw, successful, tempDirectory } from "./helpers/cli.js";
import { httpServer } from "./helpers/http.js";

type Saved = { key: string; ref: { kind: string; id: string }; revision: number };
type Summary = {
  key: string;
  revision: number;
  document?: { format: string; url?: string; tags: string[]; linkCount: number };
};
type Detail = Saved & {
  data: {
    body: string;
    documentFormat?: string;
    url?: string;
    tags?: string[];
    relations?: { type: string; target: { id: string }; description: string }[];
  };
};

/** Один сценарий для local и HTTP: одинаковые предметные последствия по контракту материалов. */
for (const transport of ["local", "http"] as const)
  test(`document материалы (${transport}): формат, теги, фасеты, связь, обратное чтение, bulk`, async (t) => {
    const app = await fixture(t);
    let cwd = app.root;
    let prefix: string[] = [];
    if (transport === "http") {
      const server = await httpServer(t, app.root);
      cwd = await tempDirectory(t);
      prefix = ["--server-url", server.url];
    }
    const run = <T = unknown>(args: Array<string | number>) => invoke<T>(cwd, [...prefix, ...args]);
    const raw = (args: Array<string | number>) => invokeRaw(cwd, [...prefix, ...args]);

    const empty = await run(["document", "create", "--name", "Пустой"]);
    failed(empty, "VALIDATION_ERROR");
    assert.match(
      empty.body.ok ? "" : empty.body.error.message,
      /--body-file.*--document-format link --url/s,
    );
    const noUrl = await run([
      "document",
      "create",
      "--name",
      "Ссылка",
      "--document-format",
      "link",
    ]);
    failed(noUrl, "VALIDATION_ERROR");
    assert.match(noUrl.body.ok ? "" : noUrl.body.error.message, /укажите --url/);

    const feature = successful(
      await run<Saved>(["feature", "create", "--name", "Цель", "--description", "Требования"]),
    ).data;
    const link = successful(
      await run<Saved>([
        "document",
        "create",
        "--name",
        "Макеты",
        "--document-format",
        "link",
        "--url",
        "https://example.com/catalog",
        "--body",
        "Читать **до** правки 🧭",
        "--tag",
        " Дизайн ",
        "--tag",
        "дизайн",
        "--tag",
        "a,b",
      ]),
    ).data;
    const note = successful(
      await run<Saved>(["document", "create", "--name", "Заметка", "--body", "## Текст"]),
    ).data;
    const read = async (key: string) =>
      successful(await run<Detail>(["document", "get", key])).data;
    const created = await read(link.key);
    assert.equal(created.data.documentFormat, "link");
    assert.equal(created.data.url, "https://example.com/catalog");
    assert.deepEqual(created.data.tags, ["Дизайн", "a,b"], "нормализация тегов выполняется в Core");

    const list = successful(
      await run<{ items: Summary[] }>([
        "document",
        "list",
        "--tag",
        "A,B",
        "--tag",
        "ДИЗАЙН",
        "--document-format",
        "link",
        "--unattached",
        "true",
      ]),
    ).data;
    assert.deepEqual(
      list.items.map((item) => [item.key, item.document?.format, item.document?.url]),
      [[link.key, "link", "https://example.com/catalog"]],
    );
    const human = await raw(["document", "list", "--tag", "a,b"]);
    assert.equal(human.code, 0, human.stdout);
    assert.match(human.stdout, /Формат: Ссылка · https:\/\/example\.com\/catalog/);
    assert.match(human.stdout, /Теги: Дизайн · a,b/);
    assert.match(human.stdout, /Раздел: Без раздела · без прикреплений/);
    assert.doesNotMatch(human.stdout, /\u001b/);

    const facets = successful(
      await run<{
        total: number;
        tags: { tag: string; count: number }[];
        formats: { format: string; count: number }[];
        views: { unattached: number };
      }>(["document", "facets"]),
    ).data;
    assert.equal(facets.total, 2);
    assert.deepEqual(
      facets.formats.map((row) => [row.format, row.count]),
      [
        ["markdown", 1],
        ["link", 1],
      ],
    );
    assert.equal(facets.views.unattached, 2);
    assert.ok(facets.tags.some((row) => row.tag === "Дизайн" && row.count === 1));
    const facetsText = await raw(["document", "facets", "--tag", "a,b"]);
    assert.equal(facetsText.code, 0, facetsText.stdout);
    assert.match(facetsText.stdout, /Счётчики библиотеки документов/);
    assert.match(facetsText.stdout, /^Продукт \(product\): 0$/m, "раздел подписан названием");
    assert.match(facetsText.stdout, /^Без раздела: 1$/m);
    assert.match(facetsText.stdout, /document list --tag a,b/);

    successful(
      await run([
        "document",
        "link",
        link.key,
        "--target",
        feature.key,
        "--relation",
        "references",
        "--description",
        "Зачем читать",
        "--if-revision",
        created.revision,
      ]),
    );
    failed(
      await run([
        "document",
        "link",
        link.key,
        "--target",
        feature.key,
        "--relation",
        "references",
        "--if-revision",
        created.revision,
      ]),
      "REVISION_CONFLICT",
      4,
    );
    const attached = await read(link.key);
    successful(
      await run([
        "document",
        "link",
        link.key,
        "--target",
        feature.key,
        "--relation",
        "references",
        "--next-relation",
        "documents",
        "--if-revision",
        attached.revision,
      ]),
    );
    const retyped = await read(link.key);
    assert.deepEqual(
      retyped.data.relations?.map((relation) => [relation.type, relation.description]),
      [["documents", "Зачем читать"]],
      "пропущенное пояснение сохраняется при смене типа",
    );
    assert.equal(retyped.data.body, "Читать **до** правки 🧭");

    const materials = successful(
      await run<{
        target: { key: string };
        items: { document: { key: string }; relations: { type: string; source: string }[] }[];
        total: number;
      }>(["document", "materials", feature.key]),
    );
    assert.equal(materials.data.target.key, feature.key);
    assert.deepEqual(
      materials.data.items.map((item) => [item.document.key, item.relations[0]?.type]),
      [[link.key, "documents"]],
    );
    assert.equal(materials.meta?.page?.total, 1);
    const materialsText = await raw(["document", "materials", feature.key]);
    assert.match(materialsText.stdout, /Описывает сущность \(documents\)\nЗачем читать/);

    const noteBefore = await read(note.key);
    const partial = await invoke<{
      items: { ref: string; status: string; revision?: number }[];
      applied: number;
      failed: number;
    }>(cwd, [
      ...prefix,
      "document",
      "bulk",
      "add-tags",
      "--item",
      `${note.key}@${noteBefore.revision}`,
      "--item",
      `${link.key}@1`,
      "--item",
      "DOC-404@1",
      "--tag",
      "Новое",
    ]);
    assert.equal(partial.code, 1, "частичный отказ даёт exit 1 при полном результате");
    assert.equal(partial.stderr, "");
    assert.ok(partial.body.ok);
    assert.deepEqual(
      partial.body.data.items.map((item) => [item.ref, item.status]),
      [
        [note.key, "applied"],
        [link.key, "conflict"],
        ["DOC-404", "not_found"],
      ],
    );
    assert.equal(partial.body.data.items[1]!.revision, retyped.revision);
    assert.deepEqual((await read(note.key)).data.tags, ["Новое"]);
    assert.deepEqual((await read(link.key)).revision, retyped.revision, "отказ не меняет запись");
    const partialText = await raw([
      "document",
      "bulk",
      "pin",
      "--item",
      `${link.key}@1`,
      "--pinned",
      "true",
    ]);
    assert.equal(partialText.code, 1);
    assert.match(partialText.stdout, /не выполнено ни для одного документа/);
    assert.match(partialText.stdout, /Актуальная ревизия/);
    assert.match(partialText.stdout, new RegExp(`Перечитать:\\n.*document get ${link.key}`));

    const all = successful(
      await run<{ items: { status: string }[]; failed: number }>([
        "document",
        "bulk",
        "status",
        "--item",
        `${link.key}@${retyped.revision}`,
        "--document-status",
        "archived",
      ]),
    ).data;
    assert.deepEqual(
      all.items.map((item) => item.status),
      ["applied"],
    );
    const active = successful(
      await run<{ total: number }>(["document", "materials", feature.key, "--archived", "false"]),
    ).data;
    assert.equal(active.total, 0);

    const archived = await read(link.key);
    successful(
      await run([
        "document",
        "unlink",
        link.key,
        "--target",
        feature.key,
        "--if-revision",
        archived.revision,
      ]),
    );
    assert.deepEqual((await read(link.key)).data.relations, []);
    failed(
      await run([
        "document",
        "unlink",
        link.key,
        "--target",
        feature.key,
        "--if-revision",
        archived.revision + 1,
      ]),
      "RELATION_NOT_FOUND",
      3,
    );
  });

test("document list: продолжение повторяет --tag и сохраняет тег с запятой", async (t) => {
  const app = await fixture(t);
  for (const name of ["Первый", "Второй", "Третий"])
    successful(
      await app.run([
        "document",
        "create",
        "--name",
        name,
        "--body",
        "x",
        "--tag",
        "a,b",
        "--tag",
        "Z",
      ]),
    );
  const first = successful(
    await app.run<{ items: Summary[] }>([
      "document",
      "list",
      "--tag",
      "A,B",
      "--tag",
      "z",
      "--limit",
      2,
    ]),
  );
  const next = first.meta?.page?.nextCommand;
  assert.ok(next);
  assert.match(next, / --tag A,B --tag z --cursor /);
  const second = successful(
    await app.run<{ items: Summary[] }>([
      "document",
      "list",
      "--tag",
      "A,B",
      "--tag",
      "z",
      "--cursor",
      first.meta!.page!.nextCursor!,
    ]),
  );
  assert.equal(first.data.items.length + second.data.items.length, 3);
  assert.equal(second.meta?.page?.nextCursor, null);
});

test("document bulk/materials/facets: русская справка без проекта и правило кода выхода", async (t) => {
  const cwd = await tempDirectory(t);
  for (const [args, pattern] of [
    [["document", "bulk", "--help"], /Код выхода: 0 .*; 1 — частичный или полный отказ/s],
    [["document", "bulk", "move", "--help"], /--item <ref@revision>/],
    [["document", "materials", "--help"], /11 видов/],
    [["document", "facets", "--help"], /по полным данным проекта/],
    [["document", "create", "--help"], /--document-format <format>.*--url <url>.*--tag <tag>/s],
    [["document", "link", "--help"], /--next-relation <type>/],
  ] as const) {
    const result = await invokeRaw(cwd, [...args]);
    assert.equal(result.code, 0, result.stdout + result.stderr);
    assert.match(result.stdout, pattern);
  }
  const bad = await invoke(cwd, ["document", "bulk", "pin", "--item", "DOC-1", "--pinned", "true"]);
  failed(bad, "INVALID_ARGUMENT");
});
