import { useCallback, useState } from "react";
import { Link, useSearchParams } from "react-router-dom";
import { Anchor, Button, NumberInput, Select, SegmentedControl } from "@mantine/core";
import { ArrowLeft } from "lucide-react";
import { useProjectId, useProjectBasePath } from "domains/project";
import { getRelationLabel, RELATION_LABELS } from "domains/relations";
import { PageHeader } from "ui/page-header";
import { PageStage } from "ui/page-stage";
import { StatePanel } from "ui/state-panel";
import { ContextExplorer } from "./ui/context-explorer/context-explorer";
import { readContextOptions } from "./helpers/read-context-options";
import { readContextMode } from "./helpers/read-context-mode";
import styles from "./styles/relation-context.module.css";

/**
 * Открывает адресный визуальный контекст внутри связей выбранного проекта.
 *
 * Используется для:
 *  - сохранения корня и фильтров исследования в URL
 *  - переключения дерева, графа и последовательного списка
 */
export const RelationContextScreen = () => {
  const projectId = useProjectId();
  const base = useProjectBasePath();
  const [params, setParams] = useSearchParams();
  const [discoveredTypes, setDiscoveredTypes] = useState<string[]>([]);
  const root = params.get("root")?.trim() ?? "";
  const options = readContextOptions(params);
  const mode = readContextMode(params);
  const scope = JSON.stringify([projectId, root, options]);
  const typeItems = [
    ...new Set([...Object.keys(RELATION_LABELS), ...discoveredTypes, options.type ?? ""]),
  ]
    .filter(Boolean)
    .map((type) => ({ value: type, label: getRelationLabel(type) }));
  const backHref = `${base}/relations?${new URLSearchParams({ root })}`;

  /**
   * Добавляет расширенные типы из прочитанных областей в варианты фильтра.
   */
  const handleTypes = useCallback((types: string[]): void => {
    setDiscoveredTypes((current) =>
      types.every((type) => current.includes(type))
        ? current
        : [...new Set([...current, ...types])],
    );
  }, []);

  /**
   * Добавляет изменение фильтров в историю, сохраняя остальные параметры.
   */
  const handleParam = (name: string, value: string | null): void => {
    const next = new URLSearchParams(params);
    if (value === null || value === "") next.delete(name);
    else next.set(name, value);
    setParams(next);
  };

  if (root === "") {
    return (
      <PageStage className={styles.stage}>
        <StatePanel
          title="Выберите исходную сущность"
          titleAs="h1"
          description="Откройте визуализацию из просмотра связей сущности."
          action={
            <Button component={Link} to={`${base}/relations`} variant="default">
              К связям проекта
            </Button>
          }
        />
      </PageStage>
    );
  }

  return (
    <PageStage className={styles.stage}>
      <Anchor component={Link} to={backHref} className={styles.back}>
        <ArrowLeft size={15} aria-hidden="true" />К связям сущности
      </Anchor>
      <PageHeader
        title="Контекст сущности"
        description="Исследуйте сохранённые связи и переходите к первоисточникам."
        actionsLayout="inline"
        actions={
          <SegmentedControl
            aria-label="Представление контекста"
            value={mode}
            onChange={(value) => handleParam("mode", value)}
            data={[
              { value: "tree", label: "Дерево" },
              { value: "graph", label: "Граф" },
              { value: "list", label: "Список" },
            ]}
          />
        }
      />
      <div className={styles.filters}>
        <NumberInput
          label="Глубина"
          min={1}
          max={100}
          allowDecimal={false}
          allowNegative={false}
          value={options.depth}
          onChange={(value) => handleParam("depth", String(value || 1))}
        />
        <Select
          label="Направление"
          value={options.direction}
          allowDeselect={false}
          onChange={(value) => handleParam("direction", value)}
          data={[
            { value: "both", label: "Все направления" },
            { value: "outgoing", label: "Исходящие" },
            { value: "incoming", label: "Входящие" },
          ]}
        />
        <Select
          label="Тип связи"
          placeholder="Все типы"
          value={options.type ?? null}
          data={typeItems}
          searchable
          clearable
          nothingFoundMessage="Тип не найден"
          clearButtonProps={{ "aria-label": "Все типы связей" }}
          onChange={(value) => handleParam("type", value)}
        />
      </div>
      <ContextExplorer
        key={scope}
        projectId={projectId}
        root={root}
        options={options}
        mode={mode}
        onRoot={(address) => handleParam("root", address)}
        onTypes={handleTypes}
      />
    </PageStage>
  );
};
