import { productOverviewMetrics } from "@relay/contracts/entities/product";
import type {
  ProductOverview,
  ProductOverviewMetricPage,
  ProductState,
} from "@relay/contracts/entities/product";
import type { CommandContext } from "../context.js";
import { commandInvocation } from "../command-kit.js";
import { AppError } from "@relay/core/shared/errors";
import { PresentedError } from "../output.js";
import type { Result } from "../queries/result.js";
import type { OutputCommand } from "../presentation/common.js";
import type {
  ProductOverviewCommands,
  ProductOverviewMetricCommands,
} from "../presentation/product.js";
import { productSnapshotConflictText } from "../presentation/product.js";

/** Восстановление чтения продукта: только явный новый запрос, без retry и подмены версии. */
export async function productSnapshotQuery(
  context: CommandContext,
  restart: readonly string[],
  operation: () => Promise<Result>,
): Promise<Result> {
  try {
    return await operation();
  } catch (error) {
    if (!(error instanceof AppError) || error.code !== "VERSION_CONFLICT") throw error;
    // Этот владелец уже объясняет guard. Общая offset-оболочка иначе заменит PresentedError
    // и допишет message, утратив наш renderer и исходный машинный ответ Backend.
    delete context.offsetVersion;
    throw new PresentedError(error.code, error.message, error.exitCode, error.details, (options) =>
      productSnapshotConflictText(error, commandInvocation(context, restart), options),
    );
  }
}

/** Один адресный маршрут на публичный вид; scope открывает состав своего приложения. */
export function productReadTokens(kind: string, ref: string): string[] {
  if (kind === "passport" || kind === "product") return ["product", "get"];
  if (kind === "scope") return ["application", "participation", "list", ref];
  return [kind, "get", ref];
}

export function overviewCommands(
  context: CommandContext,
  overview: ProductOverview,
): ProductOverviewCommands {
  const read = (...args: string[]) => commandInvocation(context, args);
  const metric = (name: string, ...args: string[]) =>
    read("overview", "--metric", name, ...args, "--snapshot", overview.snapshotVersion);
  return {
    passport: read("product", "get"),
    passportHelp: read("product", "create", "--help"),
    progress: read("product", "progress"),
    features: read("feature", "list"),
    applications: read("application", "list"),
    implementations: read("implementation", "list"),
    boards: read("board", "list"),
    tasks: read("task", "list"),
    inProgress: read("task", "list", "--column", "in-progress"),
    review: read("task", "list", "--column", "review"),
    blocked: read("task", "list", "--readiness", "blocked"),
    readyToStart: read("task", "list", "--readiness", "ready"),
    plans: read("plan", "list"),
    activePlans: read("plan", "list", "--status", "active"),
    releases: read("release", "list"),
    plannedReleases: read("release", "list", "--status", "planned"),
    releasedReleases: read("release", "list", "--status", "released"),
    documents: read("document", "list"),
    pinnedDocuments: read("document", "list", "--pinned", "true", "--status", "active"),
    sections: read("document", "section", "list"),
    unfinishedSessions: read("session", "list", "--unfinished"),
    full: read("overview", "--view", "full", "--snapshot", overview.snapshotVersion),
    map: read("overview", "--view", "map", "--snapshot", overview.snapshotVersion),
    state: read("product", "state"),
    metrics: Object.fromEntries(
      productOverviewMetrics
        .filter((name) => name !== "blocker-affected")
        .map((name) => [name, metric(name)]),
    ) as ProductOverviewCommands["metrics"],
    blockerAffected: Object.fromEntries(
      overview.snapshot.operator.blockerImpact.items.map((blocker) => [
        blocker.id,
        metric("blocker-affected", "--blocker", blocker.id),
      ]),
    ),
  };
}

/** Пример адресного чтения на страницу, а не новая простыня из команды на каждую строку. */
export function metricCommands(
  context: CommandContext,
  page: ProductOverviewMetricPage,
): ProductOverviewMetricCommands {
  const read = (...args: string[]) => commandInvocation(context, args);
  const commands: ProductOverviewMetricCommands = { overview: read("overview") };
  const first = page.items[0];
  if (first) {
    const kind =
      page.metric === "board-work"
        ? "board"
        : page.metric === "ready-releases"
          ? "release"
          : page.metric === "open-plans-complete" || page.metric === "plans-outside-releases"
            ? "plan"
            : "task";
    const ref = "key" in first ? first.key : first.id;
    commands.read = read(kind, "get", ref);
  }
  if (page.metric === "blocker-affected" && page.blocker)
    commands.blocker = read("task", "get", page.blocker.key);
  if (page.metric === "blocker-impact")
    commands.affected = Object.fromEntries(
      page.items.map((blocker) => [
        blocker.id,
        read(
          "overview",
          "--metric",
          "blocker-affected",
          "--blocker",
          blocker.id,
          "--snapshot",
          page.snapshotVersion,
        ),
      ]),
    );
  return commands;
}

/** Все тексты уже в ответе; команды дают один пример чтения на публичный вид. */
export function productRecordCommands(
  context: CommandContext,
  records: ProductState["records"],
): OutputCommand[] {
  const commands = new Map<string, OutputCommand>();
  for (const record of records) {
    const kind = record.fields.kind;
    const ref = kind === "scope" ? record.fields.applicationId : (record.key ?? record.id);
    if (!commands.has(kind))
      commands.set(kind, {
        label:
          kind === "scope"
            ? "Полный состав приложения"
            : `Открыть запись ${record.key ?? record.id}`,
        command: commandInvocation(context, productReadTokens(kind, ref)),
      });
    if (
      record.fields.kind === "scope" &&
      record.fields.contracts[0] &&
      !commands.has("implementation")
    ) {
      const contract = record.fields.contracts[0];
      commands.set("implementation", {
        label: `Открыть реализацию ${contract.key ?? contract.id}`,
        command: commandInvocation(context, ["implementation", "get", contract.key ?? contract.id]),
      });
    }
  }
  return [...commands.values()];
}
