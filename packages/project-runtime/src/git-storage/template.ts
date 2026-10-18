import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { z } from "zod";
import { invariant } from "@relay/core/shared/errors";
import { parse } from "@relay/core/domain/validation";
import {
  projectDisplayNameSchema,
  projectSlugSchema,
} from "@relay/contracts/entities/project-settings";
import { prepareTemplateSnapshot } from "@relay/core/application/storage/template";
import { normalizeOrigin } from "./identity.js";
import { git } from "./git.js";
import { snapshotAt } from "./snapshots.js";

/** Происхождение единственной установки, сохраняемое только в незавершённом намерении. */
export const templateOriginSchema = z.strictObject({
  repository: z.string(),
  ref: z.string(),
  commit: z.string().regex(/^[a-f0-9]{40,64}$/),
  sourceProjectId: z.string(),
  projectId: z.string(),
  name: projectDisplayNameSchema,
  slug: projectSlugSchema,
});
export type TemplateOrigin = z.infer<typeof templateOriginSchema>;
export interface TemplateOptions {
  repository: string;
  ref?: string;
  name?: string;
  slug?: string;
  home?: string;
}
export type TemplateRequest = ReturnType<typeof templateRequest>;

export function templateRequest(cwd: string, input: TemplateOptions) {
  const repository = normalizeOrigin(input.repository, cwd).origin;
  const ref = input.ref ?? "relay-data";
  invariant(
    ref.length > 0 &&
      ref.length <= 1024 &&
      !ref.startsWith("-") &&
      !/[\x00-\x20\x7f:~^?*\[\\]/.test(ref),
    "INVALID_ARGUMENT",
    "Укажите ветку, тег или полный SHA шаблона",
    2,
  );
  return {
    repository,
    ref,
    ...(input.name === undefined
      ? {}
      : { name: parse(projectDisplayNameSchema, input.name, "имя нового проекта") }),
    ...(input.slug === undefined
      ? {}
      : { slug: parse(projectSlugSchema, input.slug, "slug нового проекта") }),
  };
}

/** Одноразовое чтение источника: его refs и история не попадают в Git-хранилище назначения. */
export async function loadTemplate(
  temporaryRoot: string,
  request: TemplateRequest,
  defaultName: string,
) {
  const directory = await mkdtemp(join(temporaryRoot, ".template-"));
  try {
    const repository = join(directory, "repository");
    await mkdir(repository);
    await git(repository, ["init", "--bare"]);
    let ref = request.ref;
    if (!/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/i.test(ref)) {
      const candidates = ref.startsWith("refs/")
        ? [ref]
        : [`refs/heads/${ref}`, `refs/tags/${ref}`];
      invariant(
        candidates.every((item) => /^refs\/(heads|tags)\//.test(item)),
        "INVALID_ARGUMENT",
        "Шаблон выбирается из refs/heads, refs/tags или по SHA",
        2,
      );
      for (const candidate of candidates)
        invariant(
          !(await git(repository, ["check-ref-format", candidate], { allowFailure: true })).code,
          "INVALID_ARGUMENT",
          "Некорректное имя ветки или тега шаблона",
          2,
        );
      const found = await git(
        repository,
        ["ls-remote", "--exit-code", request.repository, ...candidates],
        { allowFailure: true },
      );
      invariant(found.code !== 2, "TEMPLATE_REF_NOT_FOUND", "Ветка или тег шаблона не найдены", 4, {
        ref,
      });
      invariant(
        !found.code,
        "TEMPLATE_FETCH_FAILED",
        "Не удалось прочитать репозиторий шаблона; проверьте адрес и доступ",
        4,
      );
      const refs = found.stdout
        .toString("utf8")
        .trim()
        .split("\n")
        .map((line) => line.split("\t")[1]!)
        .filter((name) => candidates.includes(name));
      invariant(
        refs.length === 1,
        "TEMPLATE_REF_AMBIGUOUS",
        "Имя шаблона неоднозначно; укажите refs/heads/<ветка> или refs/tags/<тег>",
        2,
      );
      ref = refs[0]!;
    }
    const fetched = await git(
      repository,
      ["fetch", "--no-tags", "--depth=1", "--", request.repository, ref],
      { allowFailure: true },
    );
    invariant(
      !fetched.code,
      "TEMPLATE_FETCH_FAILED",
      "Не удалось получить снимок шаблона; проверьте доступность ветки, тега или SHA",
      4,
      { ref: request.ref },
    );
    const resolved = await git(repository, ["rev-parse", "--verify", "FETCH_HEAD^{commit}"], {
      allowFailure: true,
    });
    invariant(
      !resolved.code,
      "TEMPLATE_INVALID_REF",
      "Ссылка шаблона не указывает на Git-коммит",
      4,
    );
    const commit = resolved.stdout.toString("utf8").trim();
    const prepared = await prepareTemplateSnapshot(
      await snapshotAt(repository, commit),
      directory,
      {
        name: request.name ?? defaultName,
        ...(request.slug === undefined ? {} : { slug: request.slug }),
      },
    );
    return {
      files: prepared.files,
      template: templateOriginSchema.parse({
        repository: request.repository,
        ref: request.ref,
        commit,
        sourceProjectId: prepared.sourceProjectId,
        projectId: prepared.projectId,
        name: prepared.name,
        slug: prepared.slug,
      }),
    };
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}
