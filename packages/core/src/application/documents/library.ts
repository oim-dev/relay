import {
  documentLinksQuerySchema,
  documentLinksPageSchema,
  documentSectionsQuerySchema,
  documentSectionsPageSchema,
  documentRelationChangeSchema,
  documentSectionChangeSchema,
} from "@relay/contracts/document-library";
import type {
  DocumentLinksQuery,
  DocumentLinksPage,
  DocumentSectionsQuery,
  DocumentSectionsPage,
  DocumentRelationChange,
  DocumentSectionChange,
  DocumentLinkItem,
} from "@relay/contracts/document-library";
import { defaultDocumentSections } from "@relay/contracts/entities";
import type { EntitySaved, EntityPageQuery } from "@relay/contracts/entities";
import { actorSchema } from "@relay/contracts/primitives";
import type { Workspace } from "../../storage/workspace.js";
import { parse } from "../../domain/validation.js";
import { invariant } from "../../shared/errors.js";
import { EntityEngine } from "../entities/service.js";
import {
  entityAddress,
  entitySummary,
  readEntityCatalog,
  resolveEntity,
} from "../entities/catalog.js";
import { resolveEntityCard } from "../entities/indexed-catalog.js";
import { readDocumentRecord, documentReferences } from "./read.js";

function page<T>(
  items: readonly T[],
  query: EntityPageQuery & { offset: number; limit: number },
  version: string,
) {
  invariant(
    query.version === undefined || query.version === version,
    "VERSION_CONFLICT",
    "Запись изменилась. Начните чтение с первой страницы",
    // Сохраняем exit прежних страниц библиотеки при переносе проверки из клиента.
    2,
  );
  const next = query.offset + query.limit;
  return {
    items: items.slice(query.offset, next),
    total: items.length,
    nextOffset: next < items.length ? next : null,
    version,
  };
}

function assertRevision(record: { revision: number }, revision: number) {
  invariant(
    record.revision === revision,
    "REVISION_CONFLICT",
    "Запись изменилась. Перечитайте её и согласуйте изменение; исходная ревизия не заменяется автоматически.",
    4,
    { actual: record.revision },
  );
}

/** Предметные страницы и точечные изменения библиотеки; транспорт и оформление остаются клиентам. */
export class DocumentLibraryService {
  constructor(readonly workspace: Workspace) {}

  async links(input: DocumentLinksQuery): Promise<DocumentLinksPage> {
    const query = parse(documentLinksQuerySchema, input, "прикрепления документа");
    return this.workspace.locked(async (owned) => {
      const session = this.workspace.storageSession;
      const catalog =
        session && !session.changed ? undefined : await readEntityCatalog(this.workspace, owned);
      const entry = catalog
        ? resolveEntity(catalog, query.ref, "document")
        : (
            await readDocumentRecord(
              this.workspace,
              await resolveEntityCard(session!, query.ref, "document"),
            )
          ).entry;
      invariant(entry.data.kind === "document", "INVALID_ARGUMENT", "Нужен документ");
      const links: DocumentLinkItem[] = [
        ...(entry.data.relations ?? []).map((link) => ({ source: "relations" as const, ...link })),
        ...entry.data.links.map((link) => ({
          source: "links" as const,
          target: { kind: link.kind, id: link.kind === "product" ? "passport" : link.id },
          type: "documents" as const,
          description: "",
        })),
      ];
      const result = page(links, query, `${entry.ref.id}:${entry.revision}`);
      const targets = result.items.map((link) => link.target);
      const addresses = new Set(targets.map(entityAddress));
      const references = catalog
        ? catalog.entries
            .filter((item) => addresses.has(entityAddress(item.ref)))
            .map(entitySummary)
        : await documentReferences(session!, targets);
      return documentLinksPageSchema.parse({
        ref: entry.ref,
        key: entry.key,
        title: entry.title,
        revision: entry.revision,
        ...result,
        references: references.map(({ ref, key, title }) => ({ ref, key, title })),
      });
    });
  }

  async sections(input: DocumentSectionsQuery = {}): Promise<DocumentSectionsPage> {
    const query = parse(documentSectionsQuerySchema, input, "разделы библиотеки");
    return this.workspace.locked(async (owned) => {
      const session = this.workspace.storageSession;
      const project =
        session && !session.changed
          ? await new EntityEngine(this.workspace).get({ ref: "PROJECT", kind: "project" })
          : resolveEntity(await readEntityCatalog(this.workspace, owned), "PROJECT", "project");
      invariant(project.data.kind === "project", "INVALID_ARGUMENT", "Нужен проект");
      return documentSectionsPageSchema.parse({
        project: project.ref,
        projectKey: project.key,
        revision: project.revision,
        ...page(
          project.data.documentSections ?? defaultDocumentSections,
          query,
          `${project.ref.id}:${project.revision}`,
        ),
      });
    });
  }

  async changeRelation(input: DocumentRelationChange, actor: string): Promise<EntitySaved> {
    const command = parse(documentRelationChangeSchema, input, "изменение прикрепления документа");
    const author = parse(actorSchema, command.actor ?? actor, "автор операции");
    return this.workspace.mutate("document-relation", { ...command }, author, async (owned) => {
      // Строгий каталог сохраняет прежний отказ записи даже при повреждённой несвязанной сущности.
      const catalog = await readEntityCatalog(this.workspace, owned);
      const record = resolveEntity(catalog, command.ref, "document");
      invariant(record.data.kind === "document", "INVALID_ARGUMENT", "Нужен документ");
      assertRevision(record, command.ifRevision);
      const engine = new EntityEngine(this.workspace);
      const target = await engine.resolve({ ref: command.target });
      let changes;
      if (command.source === "links") {
        const targets = record.data.links.map(
          (link) => `${link.kind}:${link.kind === "product" ? "passport" : link.id}`,
        );
        const ref = entityAddress(target.ref);
        const exists = targets.includes(ref);
        invariant(
          command.action === "link" || exists,
          "INVALID_ARGUMENT",
          "Прежняя область не найдена; проверьте document links",
        );
        changes = {
          kind: "document" as const,
          targets:
            command.action === "unlink"
              ? targets.filter((value) => value !== ref)
              : exists
                ? targets
                : [...targets, ref],
        };
      } else {
        const relations = record.data.relations ?? [];
        const matches = (link: (typeof relations)[number]) =>
          link.target.kind === target.ref.kind &&
          link.target.id === target.ref.id &&
          link.type === command.relation;
        const old = relations.find(matches);
        invariant(
          command.action === "link" || old,
          "INVALID_ARGUMENT",
          "Адресное отношение не найдено; проверьте document links или прежние области",
        );
        const replacement = {
          target: target.ref,
          type: command.relation,
          description:
            command.action === "link" ? (command.description ?? old?.description ?? "") : "",
        };
        changes = {
          kind: "document" as const,
          relations:
            command.action === "unlink"
              ? relations.filter((link) => !matches(link))
              : old
                ? relations.map((link) => (matches(link) ? replacement : link))
                : [...relations, replacement],
        };
      }
      return engine.update(
        {
          ref: entityAddress(record.ref),
          changes,
          ifRevision: command.ifRevision,
          requestId: command.requestId,
          actor: author,
        },
        author,
      );
    });
  }

  async changeSection(input: DocumentSectionChange, actor: string): Promise<EntitySaved> {
    const command = parse(documentSectionChangeSchema, input, "изменение раздела библиотеки");
    const author = parse(actorSchema, command.actor ?? actor, "автор операции");
    return this.workspace.mutate("document-section", { ...command }, author, async (owned) => {
      const project = resolveEntity(
        await readEntityCatalog(this.workspace, owned),
        "PROJECT",
        "project",
      );
      invariant(project.data.kind === "project", "INVALID_ARGUMENT", "Нужен проект");
      assertRevision(project, command.ifRevision);
      const sections = [...(project.data.documentSections ?? defaultDocumentSections)];
      const index = sections.findIndex((section) => section.id === command.id);
      invariant(
        command.action === "create" ? index === -1 : index !== -1,
        "INVALID_ARGUMENT",
        command.action === "create"
          ? "ID раздела уже существует"
          : "Раздел не найден; прочитайте document section list",
      );
      if (command.action === "create") sections.push({ id: command.id, name: command.name });
      if (command.action === "update")
        sections[index] = { ...sections[index]!, name: command.name };
      if (command.action === "remove") sections.splice(index, 1);
      if (command.action === "move") {
        invariant(
          command.before !== command.id,
          "INVALID_ARGUMENT",
          "Нельзя переместить раздел перед самим собой",
        );
        const [selected] = sections.splice(index, 1);
        const before =
          command.before === null
            ? sections.length
            : sections.findIndex((section) => section.id === command.before);
        invariant(before >= 0, "INVALID_ARGUMENT", "Целевой раздел не найден");
        sections.splice(before, 0, selected!);
      }
      return new EntityEngine(this.workspace).update(
        {
          ref: entityAddress(project.ref),
          changes: { kind: "project", documentSections: sections },
          ifRevision: command.ifRevision,
          requestId: command.requestId,
          actor: author,
        },
        author,
      );
    });
  }
}
