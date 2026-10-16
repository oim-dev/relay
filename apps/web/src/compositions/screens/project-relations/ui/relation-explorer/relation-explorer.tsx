import { useState } from "react";
import { Button, Group, Pagination, SegmentedControl, Stack, Text } from "@mantine/core";
import { ArrowDownLeft, ArrowUpRight } from "lucide-react";
import { relationAddress } from "domains/relations";
import { isEmptyArray } from "shared/value-predicates";
import { PAGE_CONTROL_LABELS, getRelationLabel } from "../../config/relation-presentation";
import { RelationCard } from "../relation-card/relation-card";
import type { RelationExplorerProps } from "./types/relation-explorer-props.type";
import styles from "./styles/relation-explorer.module.css";

/**
 * Группирует отношения по смыслу относительно выбранной сущности.
 *
 * Используется для:
 *  - раздельного чтения прямых связей и связей между соседями
 *  - просмотра ограниченных страниц без обещания полноты текущего списка
 */
export const RelationExplorer = ({
  graph,
  root,
  isChain,
  offset,
  onSelect,
  onRemove,
  onPage,
}: RelationExplorerProps) => {
  const [direction, setDirection] = useState("both");
  const [shouldShowIndirect, setShowIndirect] = useState(isChain);
  const nodesMap = new Map(
    [...graph.nodes, ...graph.endpoints].map((node) => [relationAddress(node.ref), node]),
  );
  const edgeItems = graph.edges.map((edge) => {
    const isOutgoing = relationAddress(edge.from) === root;
    const isIncoming = relationAddress(edge.to) === root;
    const isDirect = isOutgoing || isIncoming;
    const fromNode = nodesMap.get(relationAddress(edge.from));
    const toNode = nodesMap.get(relationAddress(edge.to));
    return {
      edge,
      isDirect,
      isIncoming: !isOutgoing && isIncoming,
      neighbor: isDirect ? (isOutgoing ? toNode : fromNode) : undefined,
      fromLabel: fromNode ? `${fromNode.key} · ${fromNode.title}` : relationAddress(edge.from),
      toLabel: toNode ? `${toNode.key} · ${toNode.title}` : relationAddress(edge.to),
    };
  });
  const directItems = edgeItems.filter(
    (entry) =>
      entry.isDirect && (direction === "both" || entry.isIncoming === (direction === "incoming")),
  );
  const indirectItems = edgeItems.filter((entry) => !entry.isDirect);
  const groupsMap = new Map<string, typeof directItems>();
  for (const entry of directItems) {
    const groupKey = `${entry.isIncoming}:${entry.edge.type}`;
    const entries = groupsMap.get(groupKey) ?? [];
    entries.push(entry);
    groupsMap.set(groupKey, entries);
  }
  const groupItems = [...groupsMap.entries()].map(([id, entries]) => {
    entries.sort((first, second) =>
      (first.neighbor?.key ?? "").localeCompare(second.neighbor?.key ?? "", "ru", {
        numeric: true,
      }),
    );
    const first = entries[0];
    const isIncoming = first?.isIncoming ?? false;
    return {
      id,
      entries,
      label: getRelationLabel(first?.edge.type ?? "", isIncoming),
      directionLabel: isIncoming ? "Входящие" : "Исходящие",
      icon: isIncoming ? ArrowDownLeft : ArrowUpRight,
    };
  });
  const hasIndirect = !isEmptyArray(indirectItems);
  const hasNoDirect = isEmptyArray(directItems);
  const isEmpty = graph.totalEdges === 0;
  const hasNoDirectOnPage = !isEmpty && hasNoDirect;
  const pageCount = Math.ceil(Math.max(graph.totalEdges, graph.totalNodes) / 30);
  const hasPages = pageCount > 1;
  const shouldShowIndirectList = hasIndirect && shouldShowIndirect;
  const indirectLabel = `${shouldShowIndirect ? "Скрыть" : "Показать"} связи между другими сущностями · ${indirectItems.length}`;
  return (
    <div className={styles.root}>
      <Group justify="space-between" gap="sm">
        <SegmentedControl
          size="sm"
          aria-label="Направление прямых связей"
          value={direction}
          onChange={setDirection}
          data={[
            { value: "both", label: "Все" },
            { value: "outgoing", label: "Исходящие" },
            { value: "incoming", label: "Входящие" },
          ]}
        />
        <Text size="xs" c="dimmed">
          В окружении: {graph.totalEdges} связей
        </Text>
      </Group>
      {hasPages && (
        <Text size="xs" c="dimmed">
          Группы относятся к текущей странице. Остальные отношения доступны на следующих страницах.
        </Text>
      )}
      {isEmpty && (
        <div className={styles.empty} role="status">
          <Text fw={600}>Связей пока нет</Text>
          <Text size="sm" c="dimmed">
            Добавьте связь, чтобы показать место этой сущности в проекте.
          </Text>
        </div>
      )}
      {hasNoDirectOnPage && (
        <Text size="sm" c="dimmed" py="lg">
          Прямых связей в этом направлении на текущей странице нет. Проверьте другие страницы или
          выберите «Все».
        </Text>
      )}
      {groupItems.map((group) => (
        <section key={group.id} className={styles.group} aria-label={group.label}>
          <Group className={styles.groupHeader} gap="xs">
            <group.icon size={16} aria-hidden="true" />
            <Text component="h3" size="sm" fw={600}>
              {group.label}
            </Text>
            <span className={styles.count}>{group.entries.length}</span>
            <Text size="xs" c="dimmed" ml="auto">
              {group.directionLabel}
            </Text>
          </Group>
          {group.entries.map((entry) => (
            <RelationCard key={entry.edge.id} {...entry} onSelect={onSelect} onRemove={onRemove} />
          ))}
        </section>
      ))}
      {hasIndirect && (
        <Button
          variant="subtle"
          color="gray"
          size="compact-sm"
          onClick={() => setShowIndirect(!shouldShowIndirect)}
          className={styles.indirect}
        >
          {indirectLabel}
        </Button>
      )}
      {shouldShowIndirectList && (
        <section className={styles.group} aria-label="Другие связи окружения">
          <Text size="sm" p="md" c="dimmed">
            Отношения внутри окружения. Они помогают продолжить цепочку, но не связывают выбранную
            сущность напрямую.
          </Text>
          {indirectItems.map((entry) => (
            <RelationCard key={entry.edge.id} {...entry} onSelect={onSelect} onRemove={onRemove} />
          ))}
        </section>
      )}
      {hasPages && (
        <Stack gap="xs" align="center" py="sm">
          <Text size="xs" c="dimmed">
            Страница {offset / 30 + 1} из {pageCount}
          </Text>
          <Pagination
            autoContrast
            classNames={{ control: styles.pageControl }}
            size="sm"
            total={pageCount}
            value={offset / 30 + 1}
            siblings={0}
            boundaries={1}
            getItemProps={(number) => ({ "aria-label": `Страница связей ${number}` })}
            getControlProps={(control) => ({
              "aria-label": `${PAGE_CONTROL_LABELS[control]} связей`,
            })}
            onChange={(number) => onPage((number - 1) * 30)}
          />
        </Stack>
      )}
    </div>
  );
};
