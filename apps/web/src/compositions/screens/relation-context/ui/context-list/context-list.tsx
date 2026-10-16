import clsx from "clsx";
import { useState } from "react";
import { Button, Text, ThemeIcon, Title, UnstyledButton } from "@mantine/core";
import { getEntityPresentation } from "domains/entities";
import { getRelationLabel, relationAddress } from "domains/relations";
import type { ContextListProps } from "./types/context-list-props.type";
import styles from "./styles/context-list.module.css";

/**
 * Даёт линейное клавиатурное чтение узлов и всех загруженных отношений.
 *
 * Используется для:
 *  - исследования графа без масштабирования и перемещения камеры
 */
export const ContextList = ({
  nodes,
  edges,
  selectedNodeId,
  selectedEdgeId,
  onNodeSelect,
  onEdgeSelect,
}: ContextListProps) => {
  const [nodeCount, setNodeCount] = useState(30);
  const [edgeCount, setEdgeCount] = useState(30);
  const hasMoreNodes = nodes.length > nodeCount;
  const hasMoreEdges = edges.length > edgeCount;
  const nodesById = new Map(nodes.map((node) => [relationAddress(node.ref), node]));
  const nodeItems = nodes.slice(0, nodeCount).map((node) => ({
    ...node,
    address: relationAddress(node.ref),
    presentation: getEntityPresentation(node.ref.kind),
  }));
  const edgeItems = edges.slice(0, edgeCount).map((edge) => ({
    ...edge,
    label: getRelationLabel(edge.type),
    fromLabel: nodesById.get(relationAddress(edge.from))?.key ?? relationAddress(edge.from),
    toLabel: nodesById.get(relationAddress(edge.to))?.key ?? relationAddress(edge.to),
  }));
  return (
    <div className={styles.root}>
      <Title order={2} size="h4">
        Сущности · {nodes.length}
      </Title>
      <ul className={styles.list}>
        {nodeItems.map((node) => (
          <li key={node.address}>
            <UnstyledButton
              className={clsx(styles.row, selectedNodeId === node.address && styles._selected)}
              onClick={() => onNodeSelect(node.address)}
              aria-pressed={selectedNodeId === node.address}
            >
              <ThemeIcon color="accent" variant="light">
                <node.presentation.icon size={18} aria-hidden="true" />
              </ThemeIcon>
              <span>
                <Text component="span" size="xs" c="dimmed" display="block">
                  {node.key} · {node.presentation.label}
                </Text>
                <Text component="span" size="sm" fw={500}>
                  {node.title || "Без названия"}
                </Text>
              </span>
            </UnstyledButton>
          </li>
        ))}
      </ul>
      {hasMoreNodes && (
        <Button variant="subtle" color="gray" onClick={() => setNodeCount((count) => count + 30)}>
          Показать ещё сущности
        </Button>
      )}
      <Title order={2} size="h4" mt="lg">
        Связи · {edges.length}
      </Title>
      <ul className={styles.list}>
        {edgeItems.map((edge) => (
          <li key={edge.id}>
            <UnstyledButton
              className={clsx(styles.row, selectedEdgeId === edge.id && styles._selected)}
              aria-pressed={selectedEdgeId === edge.id}
              onClick={() => onEdgeSelect(edge.id)}
            >
              <span>
                <Text component="span" size="sm" display="block">
                  {edge.fromLabel} → {edge.toLabel}
                </Text>
                <Text component="span" size="xs" c="dimmed">
                  {edge.label} · {edge.id}
                </Text>
              </span>
            </UnstyledButton>
          </li>
        ))}
      </ul>
      {hasMoreEdges && (
        <Button variant="subtle" color="gray" onClick={() => setEdgeCount((count) => count + 30)}>
          Показать ещё связи
        </Button>
      )}
    </div>
  );
};
