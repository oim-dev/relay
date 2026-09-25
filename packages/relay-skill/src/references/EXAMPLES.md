# Пример работы через MCP

[Главная инструкция](../skill.md). Функция relay вызывает инструмент и возвращает
data успешного structuredContent. project и key приходят из поручения; observed —
фактический результат внешней проверки, а не данные, придуманные для заполнения.

```javascript
// relay-example: kanban
const task = await relay("board_task_create", {
  project,
  board: "product",
  title: "Проверить пользовательский сценарий",
  description:
    "## Цель\n\nПроверить выданный сценарий.\n\n## Критерий\n\nСохранить наблюдаемый результат.",
  actor: "orchestrator",
  requestId: `${key}-task`,
});
const current = await relay("board_task_get", { project, reference: task.id });
const updated = await relay("board_task_update", {
  project,
  reference: task.id,
  description: `${current.description}\n\n## Проверка\n\n${observed.command}\n\n${observed.result}\n\n## Ограничения\n\n${observed.limitations}\n\n## Следующий шаг\n\n${observed.nextStep}`,
  ifRevision: current.revision,
  actor: "worker",
  requestId: `${key}-result`,
});
await relay("board_task_move", {
  project,
  reference: task.id,
  column: observed.passed ? "review" : "in-progress",
  ifRevision: updated.revision,
  actor: "worker",
  requestId: `${key}-status`,
});
return { task };
```

Перевод в review не завершает задачу. Оркестратор проверяет результат и решает дальнейшую
работу. Сценарная реализация получает done при непустом наборе задач, целиком в done;
реализация фичи дополнительно требует готовности всех выбранных сценарных реализаций.
проектная фича/сценарий наследует состояния всех активных реализаций и своих прямых задач.
Для CLI те же операции доступны через task.
