import assert from "node:assert/strict";
import { test } from "node:test";
import { z } from "zod";
import { workspaceStorageRegistry } from "../src/storage/unified-adapter.js";
import {
  documentDataV1,
  documentDataV2,
} from "../src/storage/data-model/history/document-v1-v2.js";
import { documentV1ToV2 } from "../src/storage/data-model/transitions/document-v1-to-v2.js";
import type { DiskData } from "../src/storage/data-model/types.js";
import { productionTransitionRegistry } from "../src/storage/data-model/transitions/index.js";
import {
  CURRENT_DATA_MODEL,
  PROFILE_2,
  currentProfile,
} from "../src/storage/data-model/profiles.js";

/** Документ v1 в дисковой форме профиля 2: Markdown массивами строк, без формата и тегов. */
const v1 = {
  name: "Правила",
  summary: "Кратко",
  body: ["## Текст\r", "", "  Отступ  ", ""],
  documentKind: "rules",
  sectionId: "development",
  documentStatus: "draft",
  pinned: true,
  relations: [
    {
      target: { kind: "plan-stage", id: "stage-1" },
      type: "references",
      description: ["Пояснение\r", "с CRLF"],
    },
  ],
  links: [{ kind: "feature", id: "Feat0001" }],
};

test("document v1 → v2: профиль, цепочка и явная запись формата и тегов", () => {
  const registry = productionTransitionRegistry();
  assert.equal(currentProfile().version, CURRENT_DATA_MODEL);
  assert.deepEqual(currentProfile().owners, { ...PROFILE_2.owners, document: 2 });
  assert.equal(registry.target("document"), 2);
  assert.equal(registry.transitionFrom("document", 1)?.id, documentV1ToV2.id);
  assert.equal(workspaceStorageRegistry().definition("document").dataVersion, 2);

  const input = documentDataV1.parse(v1) as unknown as DiskData;
  const output = documentV1ToV2.apply(input, {
    ref: { kind: "document", id: "Doc00001" },
    envelope: {} as never,
  });
  assert.deepEqual(output, { ...v1, documentFormat: "markdown", tags: [] });
  assert(documentDataV2.safeParse(output).success);
  // Текущий кодек принимает выход перехода как запись своей версии.
  assert.doesNotThrow(() => registry.validator("document", 2).parse(output));
});

test("document v1/v2: поля v2 не принимаются как v1, а v2 без формата и тегов — повреждение", () => {
  // В v1 не было формата, адреса и тегов: строгий вход перехода их отвергает.
  for (const extra of [{ documentFormat: "markdown" }, { tags: [] }, { url: "https://a.example" }])
    assert.equal(documentDataV1.safeParse({ ...v1, ...extra }).success, false);
  // Пустой Markdown в v1 недопустим, в v2 допустим для ссылки (сочетание проверяет Core).
  assert.equal(documentDataV1.safeParse({ ...v1, body: [""] }).success, false);
  assert(
    documentDataV2.safeParse({
      ...v1,
      body: [""],
      documentFormat: "link",
      url: "https://relay.example/spec",
      tags: ["Спецификация"],
    }).success,
  );
  const validator = productionTransitionRegistry().validator("document", 2);
  assert.throws(() => validator.parse(v1 as never), { code: "STORAGE_DATA_CORRUPT" });
  assert.throws(() => validator.parse({ ...v1, documentFormat: "markdown" } as never), {
    code: "STORAGE_DATA_CORRUPT",
  });
  // Тег v2 хранится нормализованным.
  for (const tag of [" Пробел", "", "x".repeat(51), "две\nстроки"])
    assert.equal(
      documentDataV2.safeParse({ ...v1, documentFormat: "markdown", tags: [tag] }).success,
      false,
      JSON.stringify(tag),
    );
});

test("document v2: набор полей замороженной схемы совпадает с текущим кодеком", () => {
  const codec = workspaceStorageRegistry().definition("document").schema;
  assert(codec instanceof z.ZodObject);
  const keys = (shape: object) => Object.keys(shape).sort();
  assert.deepEqual(keys(documentDataV2.shape), keys(codec.shape));
  // Обязательность формата и тегов совпадает: отсутствие на диске не подставляется чтением.
  for (const field of ["documentFormat", "tags"] as const) {
    assert.equal(documentDataV2.shape[field].safeParse(undefined).success, false, field);
    assert.equal(codec.shape[field]!.safeParse(undefined).success, false, field);
  }
});

test("document v1 промежуточной сборки: формат, адрес и теги сохраняются переходом", () => {
  const link = {
    ...v1,
    body: [""],
    documentFormat: "link",
    url: "https://relay.example/spec",
    tags: ["Спецификация", "UI"],
  };
  assert.equal(documentDataV1.safeParse(link).success, false, "выпущенная v1 не расширена");
  const input = documentV1ToV2.input.parse(link) as DiskData;
  const output = documentV1ToV2.apply(input, {
    ref: { kind: "document", id: "Doc00001" },
    envelope: {} as never,
  });
  assert.deepEqual(output, link);
  assert(documentDataV2.safeParse(output).success);
  // Вариант повторяет инвариант той сборки: формат без тегов, markdown с адресом или
  // пустым текстом, ссылка без адреса не принимаются.
  for (const broken of [
    { ...link, tags: undefined },
    { ...link, url: undefined },
    { ...link, documentFormat: "markdown" },
    { ...v1, body: [" "], documentFormat: "markdown", tags: [] },
  ])
    assert.equal(documentV1ToV2.input.safeParse(broken).success, false, JSON.stringify(broken));
});
