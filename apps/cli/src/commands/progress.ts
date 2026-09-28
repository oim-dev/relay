import type { Command } from "commander";
import type { Progress } from "@relay/contracts/progress";
import type { Runtime } from "../context.js";
import { registerCommand } from "../command.js";
import { paging, offsetQuery, pageResult, commandInvocation } from "../command-kit.js";
import { progressText } from "../presentation/progress.js";

const exampleReferences: Record<Progress["kind"], string> = {
  task: " PRODUCT-1",
  feature: " FEATURE-1",
  scenario: " SCENARIO-1",
  application: " WEB",
  implementation: " WEB-FI-1",
  "work-plan": " PLN-1",
  release: " REL-1",
  product: "",
};

/** Регистрирует прогресс у владельца сущности, без отдельного дерева progress. */
export function registerEntityProgress(
  parent: Command,
  runtime: Runtime,
  kind: Progress["kind"],
): void {
  const entity = kind === "work-plan" ? "plan" : kind;
  registerCommand<Record<string, unknown>>(parent, runtime, {
    name: kind === "product" ? "progress" : "progress <ref>",
    description: "Фактическое выполнение и причины неготовности",
    ...(kind === "product" ? {} : { arguments: { ref: "Ключ, ID или kind:ID сущности" } }),
    details:
      "Полные итоги не зависят от страницы. Курсор продолжает все списки одного снимка. Колонка done сама по себе не доказывает выполнение.",
    examples: [
      [
        `npx @oim-dev/relay-cli ${entity} progress${exampleReferences[kind]} --limit 20`,
        "Прочитать прогресс и причины",
      ],
    ],
    configure: paging,
    run: async (context, input) => {
      const command = [entity, "progress", ...(kind === "product" ? [] : [input.argument()])];
      const query = offsetQuery(context, input.options, command, {});
      const data =
        kind === "product"
          ? await context.backend.progress.product(query)
          : await context.backend.progress[kind === "work-plan" ? "workPlan" : kind]({
              ...query,
              ref: input.argument(),
            });
      // Одна позиция применяется ко всем параллельным спискам. Минимальное
      // продолжение не пропускает остаток ни одного из них.
      const lists = Object.values(data).filter(
        (value): value is { items: unknown[]; total: number; nextOffset: number | null } =>
          value !== null &&
          typeof value === "object" &&
          "items" in value &&
          "nextOffset" in value &&
          "total" in value,
      );
      const next = lists.flatMap((list) => (list.nextOffset === null ? [] : [list.nextOffset]));
      const page = pageResult(context, command, {}, query, {
        items: lists.flatMap((list) => list.items),
        total: lists.reduce((sum, list) => sum + list.total, 0),
        nextOffset: next.length ? Math.min(...next) : null,
        version: data.version,
      });
      return {
        data,
        page,
        text: (options) =>
          progressText(data, query, options, (tokens) => commandInvocation(context, tokens)),
      };
    },
  });
}
