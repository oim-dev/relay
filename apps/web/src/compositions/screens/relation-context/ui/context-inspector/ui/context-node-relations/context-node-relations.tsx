import clsx from "clsx";
import { useState } from "react";
import { Button, Text, UnstyledButton } from "@mantine/core";
import { getRelationLabel, relationAddress } from "domains/relations";
import type { ContextNodeRelationsProps } from "./types/context-node-relations-props.type";
import styles from "./styles/context-node-relations.module.css";

/**
 * Показывает сохранённые отношения выбранного узла порциями по восемь.
 *
 * Используется для:
 *  - чтения повторных путей, циклов и параллельных отношений без перегруженной диаграммы
 *  - адресного открытия любой загруженной связи
 */
export const ContextNodeRelations = (props: ContextNodeRelationsProps) => {
  const { address, nodes, edges, onSelect, className, ...rootAttrs } = props;
  const [visibleCount, setVisibleCount] = useState(8);
  const nodesById = new Map(nodes.map((node) => [relationAddress(node.ref), node]));
  const relationItems = edges
    .filter(
      (edge) => relationAddress(edge.from) === address || relationAddress(edge.to) === address,
    )
    .map((edge) => {
      const from = relationAddress(edge.from),
        to = relationAddress(edge.to);
      const isIncoming = from !== address;
      const isLoop = from === to;
      const neighbor = nodesById.get(isIncoming ? from : to);
      const directionLabel = isLoop ? "Петля" : isIncoming ? "Входящая" : "Исходящая";
      return {
        id: edge.id,
        label: getRelationLabel(edge.type, isIncoming),
        directionLabel,
        neighborLabel: `${neighbor?.key ?? (isIncoming ? from : to)} · ${neighbor?.title ?? "Без названия"}`,
        endpointsLabel: `${nodesById.get(from)?.key ?? from} → ${nodesById.get(to)?.key ?? to}`,
      };
    })
    .sort(
      (left, right) =>
        left.neighborLabel.localeCompare(right.neighborLabel, "ru", { numeric: true }) ||
        left.label.localeCompare(right.label, "ru") ||
        left.id.localeCompare(right.id),
    );
  const visibleItems = relationItems.slice(0, visibleCount);
  const hasMore = relationItems.length > visibleCount;
  return (
    <section
      {...rootAttrs}
      className={clsx(styles.root, className)}
      aria-label="Связи выбранной сущности"
    >
      <Text size="sm" fw={600}>
        Загруженные связи · {relationItems.length}
      </Text>
      <ul className={styles.list}>
        {visibleItems.map((relation) => (
          <li key={relation.id}>
            <UnstyledButton
              className={styles.relation}
              onClick={() => onSelect(relation.id)}
              title={`${relation.endpointsLabel} · ${relation.id}`}
            >
              <Text component="span" size="xs" c="dimmed" display="block">
                {relation.directionLabel} · {relation.label}
              </Text>
              <Text component="span" size="sm" display="block">
                {relation.neighborLabel}
              </Text>
              <Text
                component="span"
                size="xs"
                c="dimmed"
                display="block"
                className={styles.identifier}
              >
                {relation.id}
              </Text>
            </UnstyledButton>
          </li>
        ))}
      </ul>
      {hasMore && (
        <Button
          variant="subtle"
          color="gray"
          size="xs"
          onClick={() => setVisibleCount((count) => count + 8)}
        >
          Ещё связи · показано {visibleItems.length} из {relationItems.length}
        </Button>
      )}
    </section>
  );
};
