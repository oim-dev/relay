import type { BoardTaskRecord } from "../../domain/board-task.js";
import type { ProductContract, ProductStatus } from "../../domain/product.js";
import type { EntityRef } from "../../domain/entity-graph.js";
import {
  taskCompletions,
  type CompletionTask,
  type TaskCompletion,
} from "../board-tasks/completion.js";

/** Минимальные сведения для подъёма готовности от реализации к её требованию. */
type ImplementationTarget = Pick<ProductContract, "id" | "featureId" | "scenarioId" | "active"> & {
  /** Приложение-владелец: сценарии соседних приложений не входят в эту FI. */
  applicationId: string;
};

/** Принадлежность проектного сценария, в том числе ещё не выбранного приложениями. */
type ScenarioTarget = {
  /** Постоянный ID сценария. */
  id: string;
  /** Постоянный ID родительской фичи. */
  featureId: string;
};

/** Возвращает типизированную проектную цель реализации. */
function requirementAddress(implementation: ImplementationTarget): string {
  return implementation.scenarioId === null
    ? `feature:${implementation.featureId}`
    : `scenario:${implementation.scenarioId}`;
}

/**
 * Строит предметный граф готовности. Направление рёбер — от родителя к обязательной части.
 * Все пути ограничены иерархией сущностей; произвольные отношения графа здесь не используются.
 */
function readinessGraph(
  implementations: ImplementationTarget[],
  scenarios: ScenarioTarget[],
): Map<string, Set<string>> {
  const graph = new Map<string, Set<string>>();
  const featureImplementations = new Map<string, string>();
  /** Добавляет обязательную часть без дублирования путей. */
  const addChild = (parent: string, child: string): void => {
    const children = graph.get(parent) ?? new Set<string>();
    children.add(child);
    graph.set(parent, children);
  };
  for (const entry of implementations) {
    if (entry.active && entry.scenarioId === null)
      featureImplementations.set(
        `${entry.applicationId}:${entry.featureId}`,
        `implementation:${entry.id}`,
      );
  }
  for (const entry of implementations) {
    if (!entry.active) continue;
    const implementation = `implementation:${entry.id}`;
    addChild(requirementAddress(entry), implementation);
    if (entry.scenarioId === null) continue;
    const parent = featureImplementations.get(`${entry.applicationId}:${entry.featureId}`);
    if (parent !== undefined) addChild(parent, implementation);
    addChild(`feature:${entry.featureId}`, `scenario:${entry.scenarioId}`);
  }
  for (const scenario of scenarios)
    addChild(`feature:${scenario.featureId}`, `scenario:${scenario.id}`);
  return graph;
}

/** Цели задач каскада, включая дочерние сценарии; снятые реализации не расширяют выборку. */
export function productTaskTargets(
  target: EntityRef,
  implementations: ImplementationTarget[],
  scenarios: ScenarioTarget[] = [],
): Set<string> {
  const address = `${target.kind}:${target.id}`;
  const graph = readinessGraph(implementations, scenarios);
  const targets = new Set([address]);
  for (const parent of targets) {
    for (const child of graph.get(parent) ?? []) targets.add(child);
  }
  return targets;
}

/**
 * Считает готовность продуктовых целей по явным обязательствам задач, независимо от пагинации.
 * Отмена не выполняет обязательство; одна задача учитывается для каждой цели только один раз.
 */
export function productTaskStatuses(
  tasks: (CompletionTask & Pick<BoardTaskRecord, "productLinks">)[],
  implementations: ImplementationTarget[] = [],
  scenarios: ScenarioTarget[] = [],
  /** Уже посчитанное выполнение тех же задач в этом чтении; иначе считается здесь. */
  completion: Map<string, TaskCompletion> = taskCompletions(tasks, "blocked"),
): Map<string, ProductStatus> {
  const directStatuses = new Map<string, ProductStatus>();
  for (const task of tasks) {
    for (const link of task.productLinks) {
      const address = `${link.kind}:${link.id}`;
      const previous = directStatuses.get(address);
      directStatuses.set(
        address,
        completion.get(task.id)!.completed && previous !== "partial" ? "done" : "partial",
      );
    }
  }
  const graph = readinessGraph(implementations, scenarios);
  const resolved = new Map<string, ProductStatus>();
  /** Сначала разрешает обязательные части, затем добавляет существующие прямые задачи. */
  const resolve = (address: string): ProductStatus => {
    const known = resolved.get(address);
    if (known !== undefined) return known;
    const branches = [...(graph.get(address) ?? [])].map(resolve);
    const direct = directStatuses.get(address);
    if (direct !== undefined) branches.push(direct);
    const status =
      branches.length !== 0 && branches.every((entry) => entry === "done")
        ? "done"
        : branches.some((entry) => entry !== "none")
          ? "partial"
          : "none";
    resolved.set(address, status);
    return status;
  };
  for (const address of graph.keys()) resolve(address);
  return new Map([...directStatuses, ...resolved]);
}
