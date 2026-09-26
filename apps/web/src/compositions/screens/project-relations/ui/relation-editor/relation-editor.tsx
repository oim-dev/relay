import { useRef, useState } from "react";
import { Alert, Button, Checkbox, Group, Select, Stack, Text, TextInput } from "@mantine/core";
import { ArrowDown, ArrowDownUp } from "lucide-react";
import { useForm } from "@mantine/form";
import { getRelations, relationError, saveRelations } from "domains/relations";
import { MarkdownField } from "ui/markdown-field";
import { getRelationLabel } from "../../config/relation-presentation";
import { EntityPicker } from "compositions/widgets/entity-picker";
import type { RelationEditorProps, RelationFormValues } from "./types/relation-editor-props.type";
import styles from "./styles/relation-editor.module.css";

/**
 * Устанавливает направленную связь с пояснением и защитой от параллельных изменений.
 *
 * Используется для:
 *  - связывания произвольных сущностей и добавления контекстного материала
 */
export const RelationEditor = (props: RelationEditorProps) => {
  const { projectId, root, onSaved, onCancel } = props;
  const [version, setVersion] = useState(props.version);
  const [error, setError] = useState<string | null>(null);
  const [isCustomType, setCustomType] = useState(false);
  const request = useRef({ signature: "", id: crypto.randomUUID() });
  const form = useForm<RelationFormValues>({
    mode: "uncontrolled",
    validateInputOnBlur: true,
    initialValues: { from: root ?? "", to: "", type: "references", description: "" },
    validate: {
      from: (value) => (value ? null : "Выберите начало связи"),
      to: (value) => (value ? null : "Выберите конец связи"),
      type: (value) =>
        /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(value)
          ? null
          : "Используйте латинские буквы, цифры, точку, дефис или подчёркивание",
    },
  });
  const hasError = error !== null;
  const typeItems = [
    "references",
    "contains",
    "implements",
    "affects",
    "depends-on",
    "part-of",
    "verifies",
    "related",
  ].map((value) => ({ value, label: getRelationLabel(value) }));
  /**
   * Меняет направление целиком, сохраняя обе выбранные сущности.
   */
  const handleSwap = (): void => {
    const { from, to } = form.getValues();
    form.setValues({ from: to, to: from });
  };
  /** Передаёт фокус первому незаполненному полю. */
  const handleValidationError = (errors: typeof form.errors): void => {
    const first = Object.keys(errors)[0];
    if (first !== undefined) form.getInputNode(first)?.focus();
  };
  /** Отправляет изменения по действию пользователя, сохраняя черновик при ошибке. */
  const handleSubmit = async (values: RelationFormValues): Promise<void> => {
    setError(null);
    const signature = JSON.stringify([values, version]);
    if (request.current.signature !== signature)
      request.current = { signature, id: crypto.randomUUID() };
    try {
      await saveRelations(
        projectId,
        [
          {
            action: "add",
            from: values.from,
            to: values.to,
            type: values.type,
            description: values.description,
          },
        ],
        version,
        request.current.id,
      );
      onSaved();
    } catch (failure) {
      setError(relationError(failure).message);
    }
  };
  /** Перечитывает версию только по явному действию, не заменяя введённые поля. */
  const handleRefresh = async (): Promise<void> => {
    try {
      setVersion((await getRelations(projectId, { limit: 1 })).version);
      setError(null);
    } catch (failure) {
      setError(relationError(failure).message);
    }
  };
  return (
    <form onSubmit={form.onSubmit(handleSubmit, handleValidationError)} noValidate>
      <fieldset className={styles.root} disabled={form.submitting}>
        <Stack gap="sm">
          <Text size="sm" c="dimmed">
            Диагностическое ребро сохраняется только в графе. Для прикрепления документа, цели или
            зависимости задачи используйте редактор соответствующей сущности.
          </Text>
          <EntityPicker
            key={form.key("from")}
            projectId={projectId}
            label="От какой сущности"
            placeholder="Найдите по названию или ключу"
            required
            {...form.getInputProps("from")}
          />
          <Group justify="space-between">
            <ArrowDown size={18} aria-hidden="true" />
            <Button
              variant="subtle"
              color="gray"
              size="compact-xs"
              leftSection={<ArrowDownUp size={14} aria-hidden="true" />}
              onClick={handleSwap}
            >
              Поменять направление
            </Button>
          </Group>
          {!isCustomType && (
            <Select
              key={form.key("type")}
              label="Как связана"
              required
              allowDeselect={false}
              data={typeItems}
              {...form.getInputProps("type")}
            />
          )}
          {isCustomType && (
            <TextInput
              key={form.key("type")}
              label="Свой тип отношения"
              description="Латинские буквы, цифры, точка, дефис или подчёркивание"
              required
              {...form.getInputProps("type")}
            />
          )}
          <Checkbox
            label="Указать свой тип отношения"
            size="xs"
            checked={isCustomType}
            onChange={(event) => {
              setCustomType(event.currentTarget.checked);
              form.setFieldValue("type", "references");
            }}
          />
          <EntityPicker
            key={form.key("to")}
            projectId={projectId}
            label="С какой сущностью"
            placeholder="Выберите связанную сущность"
            required
            {...form.getInputProps("to")}
          />
          <MarkdownField
            key={form.key("description")}
            label="Зачем нужна связь"
            placeholder="Необязательно: поясните смысл связи. Поддерживается Markdown."
            disabled={form.submitting}
            minRows={3}
            {...form.getInputProps("description")}
          />
          <Text size="xs" c="dimmed">
            Контекстная ссылка references не делает документ требованием. Новая связь не меняет
            статусы сущностей автоматически.
          </Text>
          {hasError && (
            <Alert color="red" title="Связь не подтверждена" role="alert">
              {error}
              <Button variant="subtle" onClick={() => void handleRefresh()}>
                Обновить версию, сохранив ввод
              </Button>
            </Alert>
          )}
          <Group>
            <Button type="submit" loading={form.submitting}>
              Сохранить связь
            </Button>
            <Button variant="default" onClick={onCancel}>
              Свернуть, сохранив ввод
            </Button>
          </Group>
        </Stack>
      </fieldset>
    </form>
  );
};
