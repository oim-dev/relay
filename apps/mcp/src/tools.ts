import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
  McpError,
  ErrorCode,
  ToolSchema,
} from "@modelcontextprotocol/sdk/types.js";
import type { CallToolResult, Tool } from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod";
import { progressQuerySchema, progressPageQuerySchema } from "@relay/contracts/progress";
import {
  productEntitiesQuerySchema,
  productEntityQuerySchema,
  updateImplementationSchema,
} from "@relay/core/domain/product-implementation";
import manifest from "#manifest" with { type: "json" };
import { asAppError, invariant } from "@relay/core/shared/errors";
import { actorSchema, parse } from "@relay/core/domain/validation";
import { boardsQuerySchema } from "@relay/core/domain/board";
import {
  boardTaskReferenceSchema,
  boardTasksQuerySchema,
  createBoardTaskSchema,
  updateBoardTaskSchema,
  moveBoardTaskSchema,
  linkBoardTaskSchema,
  criteriaQuerySchema,
  criterionIdSchema,
  addCriterionSchema,
  editCriterionSchema,
  completeCriterionSchema,
  removeCriterionSchema,
  taskCommentsQuerySchema,
  taskActivityIdSchema,
  publishTaskCommentSchema,
} from "@relay/core/domain/board-task";
import type { BoardTaskSaved } from "@relay/core/domain/board-task";
import { requestIdSchema } from "@relay/contracts/primitives";
import {
  productMutationSchema,
  productContextQuerySchema,
  productListQuerySchema,
} from "@relay/core/domain/product";
import { projectEntrySchema, projectNameSchema } from "@relay/project-runtime/config";
import type { Backend } from "@relay/project-runtime/backend/types";
import type { Projects } from "./projects.js";
import { checked, page, paging, response } from "./output.js";
import type { Result } from "./output.js";
import { documentToolSchema } from "./schema-documentation.js";
import { entityTools } from "./entity-tools.js";
import { planningTools } from "./planning-tools.js";
import { lintProduct, productContentQuerySchema } from "@relay/core/application/product/content";
import {
  productWriteTools,
  productWriteArguments,
  productScopeArguments,
  productContractArguments,
  scopeRevision,
  saveProduct,
} from "./product-tools.js";
const selector = {
  project: projectNameSchema
    .optional()
    .describe("Имя из projects_list; обязательно для реестра, опускается при проектном конфиге"),
  maxBytes: z
    .number()
    .int()
    .min(1024)
    .max(128 * 1024 * 1024)
    .optional(),
};
const boardTask = { reference: boardTaskReferenceSchema };

/** Результат текущего вызова без сохранения для повторных запросов. */
async function changedBoardTask(operation: Promise<BoardTaskSaved>): Promise<Result> {
  const data = await operation;
  return {
    data,
    text: `Задача ${data.key}: ${data.action}. ID: ${data.id}. Ревизия: ${data.revision}. requestId: ${data.requestId}.`,
  };
}
function defined<T extends object>(value: T): { [K in keyof T]: Exclude<T[K], undefined> } {
  return Object.fromEntries(Object.entries(value).filter(([, item]) => item !== undefined)) as {
    [K in keyof T]: Exclude<T[K], undefined>;
  };
}

export function createTools(projects: Projects): Server {
  const server = new Server(
    { name: manifest.name, version: manifest.version },
    {
      capabilities: { tools: {} },
      instructions:
        "projects_list показывает режим Relay Server и доступные проекты. В workspace передавайте project в каждом проектном вызове; в local проект можно опустить. Заголовки — однострочные, краткие описания — многострочный обычный текст. Полные описания, требования и инструкции — структурированный Markdown: цель, правила, шаги, ошибки и проверяемый результат по смыслу. Не пишите сложные требования слитным абзацем и не выдумывайте сведения ради разделов. Предпочитайте предметные product_*_save вместо универсального product_save. Перед серией записей объясните цель, после перечитайте записи и проверьте product_lint. actor передаётся в каждой записи. requestId служит только корреляции: дедупликации и сохранённых результатов нет. После потери ответа прочитайте текущее состояние и согласуйте дальнейшее действие; не повторяйте запись вслепую и не подставляйте свежую ревизию в старое тело. Реестр читается с сервера без перезапуска MCP.",
    },
  );
  const tools = new Map<
    string,
    { definition: Tool; call: (input: unknown) => Promise<CallToolResult> }
  >();

  function define<S extends z.ZodRawShape>(
    name: string,
    description: string,
    shape: S,
    readOnly: boolean,
    action: (input: z.output<z.ZodObject<S>>) => Promise<CallToolResult>,
  ) {
    const schema = z.strictObject(shape);
    tools.set(name, {
      definition: {
        name,
        description: readOnly
          ? description
          : `${description} requestId служит только корреляции, не дедупликации. После потери ответа прочитайте текущее состояние и согласуйте дальнейшее действие; не повторяйте запись вслепую.`,
        inputSchema: ToolSchema.shape.inputSchema.parse(
          documentToolSchema(z.toJSONSchema(schema, { io: "input" })),
        ),
        annotations: {
          readOnlyHint: readOnly,
          destructiveHint: !readOnly,
          idempotentHint: readOnly,
          openWorldHint: false,
        },
      },
      async call(input) {
        try {
          return await action(parse(schema, input ?? {}, name));
        } catch (error) {
          const failure = asAppError(error);
          return response(
            {
              ok: false,
              error: {
                code: failure.code,
                message: failure.message,
                ...(failure.details === undefined ? {} : { details: failure.details }),
              },
            },
            true,
          );
        }
      },
    });
  }

  function projectTool<S extends z.ZodRawShape>(
    name: string,
    description: string,
    shape: S,
    readOnly: boolean,
    action: (
      backend: Backend,
      input: z.output<z.ZodObject<S>>,
      scope: unknown,
      budget: number,
      meta: Record<string, unknown>,
    ) => Promise<Result>,
  ) {
    define(name, description, shape, readOnly, async (input) => {
      const { project, maxBytes } = z.object(selector).parse(input);
      return projects.withBackend(project, async (backend, target) => {
        const meta = { project: project ?? null, configPath: backend.workspace.configPath };
        const budget = maxBytes ?? backend.workspace.config.output.maxBytes;
        const filters = Object.fromEntries(
          Object.entries(input).filter(([key]) => !["cursor", "limit", "maxBytes"].includes(key)),
        );
        const scope = { name, target, storage: backend.workspace.root, filters };
        const result = await action(backend, input, scope, budget, meta);
        return checked({ ...result, meta: { ...meta, ...result.meta } }, budget);
      });
    });
  }

  for (const tool of [...entityTools, ...planningTools])
    projectTool(
      tool.name,
      tool.description,
      { ...selector, ...tool.schema.shape },
      tool.readOnly,
      (backend, input) => {
        const { project: _project, maxBytes: _maxBytes, ...fields } = input;
        return tool.run(backend, fields);
      },
    );

  for (const kind of ["task", "implementation", "scenario", "feature", "application"] as const)
    projectTool(
      `${kind}_progress`,
      `Прогресс ${{ task: "задачи с критериями и обязательствами", implementation: "реализации с собственными задачами", scenario: "сценария и его реализаций", feature: "фичи и её сценариев", application: "приложения и задач его досок" }[kind]}; причины и адреса для раскрытия. Итоги полные, списки ограничены; для продолжения нужны offset и version`,
      { ...selector, ...progressQuerySchema.shape },
      true,
      async (backend, input) => {
        const data = await backend.progress[kind](progressQuerySchema.strip().parse(input));
        return {
          data,
          text: `${data.entity.title}: ${data.completed ? "выполнено" : "не выполнено"}. Причин: ${data.reasons.total}. ${data.reasons.items.map((reason) => reason.message).join("; ")}`,
        };
      },
    );
  projectTool(
    "product_progress",
    "Прогресс продукта и страница фич с адресами; итог по всему составу, продолжение через offset и version",
    { ...selector, ...progressPageQuerySchema.shape },
    true,
    async (backend, input) => {
      const data = await backend.progress.product(progressPageQuerySchema.strip().parse(input));
      return {
        data,
        text: `${data.entity.title}: ${data.completed ? "выполнено" : "не выполнено"}. Задачи: ${data.counts.completed}/${data.counts.total}. Фич: ${data.features.total}.`,
      };
    },
  );

  projectTool(
    "boards_list",
    "Доски проекта: названия, slug и префиксы задач; постраничное продолжение",
    { ...selector, ...boardsQuerySchema.shape },
    true,
    async (backend, input) => ({
      data: await backend.boards.list(boardsQuerySchema.strip().parse(input)),
    }),
  );
  projectTool(
    "board_tasks_list",
    "Задачи новых досок; readiness=ready возвращает работу без блокеров, blocked — задачи с невыполненными зависимостями",
    { ...selector, ...boardTasksQuerySchema.shape },
    true,
    async (backend, input) => ({
      data: await backend.boardTasks.list(boardTasksQuerySchema.strip().parse(input)),
    }),
  );
  projectTool(
    "board_task_get",
    "Прочитать задачу новой доски: полный Markdown, ревизия и ID блокеров",
    { ...selector, ...boardTask },
    true,
    async (backend, input) => ({ data: await backend.boardTasks.get(input.reference) }),
  );
  projectTool(
    "board_task_links",
    "Понять порядок выполнения: зависимости, блокируемые задачи, родительство и связи между досками с текущими состояниями",
    { ...selector, ...boardTask, ...boardTasksQuerySchema.shape },
    true,
    async (backend, input) => ({
      data: await backend.boardTasks.links(
        input.reference,
        boardTasksQuerySchema.strip().parse(input),
      ),
    }),
  );
  projectTool(
    "board_task_create",
    "Создать задачу на выбранной доске: заголовок и Markdown. Ключ выдаётся автоматически",
    {
      ...selector,
      ...createBoardTaskSchema.shape,
      actor: actorSchema.describe("Автор создания задачи"),
    },
    false,
    async (backend, input) =>
      changedBoardTask(
        backend.boardTasks.create(createBoardTaskSchema.strip().parse(input), input.actor),
      ),
  );
  projectTool(
    "task_comment_publish",
    "Опубликовать сообщение обсуждения: обязательные заголовок и Markdown, своё имя и роль. Не меняет ревизию задачи; повторная публикация создаёт новое сообщение",
    { ...selector, ...boardTask, ...publishTaskCommentSchema.shape },
    false,
    async (backend, input) => {
      const data = await backend.boardTasks.publishComment(
        input.reference,
        publishTaskCommentSchema.strip().parse(input),
      );
      return {
        data,
        text: `Сообщение ${data.commentId} опубликовано в задаче ${data.id}. Ревизия ленты: ${data.revision}. requestId: ${data.requestId}.`,
      };
    },
  );
  projectTool(
    "task_comments_list",
    "Сообщения задачи без полного Markdown: по 20, продолжение nextCursor; after читает новые записи",
    { ...selector, ...boardTask, ...taskCommentsQuerySchema.shape },
    true,
    async (backend, input) => ({
      data: await backend.boardTasks.listComments(
        input.reference,
        taskCommentsQuerySchema.strip().parse(input),
      ),
    }),
  );
  projectTool(
    "task_comment_get",
    "Прочитать полный Markdown сообщения с автором и временем публикации",
    { ...selector, ...boardTask, entryId: taskActivityIdSchema },
    true,
    async (backend, input) => ({
      data: await backend.boardTasks.getComment(input.reference, input.entryId),
    }),
  );
  projectTool(
    "task_criteria_list",
    "Список критериев приёмки задачи: заголовки, краткие описания и выполнение; по 20 с продолжением",
    { ...selector, ...boardTask, ...criteriaQuerySchema.shape },
    true,
    async (backend, input) => ({
      data: await backend.boardTasks.listCriteria(
        input.reference,
        criteriaQuerySchema.strip().parse(input),
      ),
    }),
  );
  projectTool(
    "task_criterion_get",
    "Прочитать полное Markdown-описание критерия приёмки и ревизию задачи",
    { ...selector, ...boardTask, criterionId: criterionIdSchema },
    true,
    async (backend, input) => ({
      data: await backend.boardTasks.getCriterion(input.reference, input.criterionId),
    }),
  );
  projectTool(
    "task_criterion_add",
    "Добавить невыполненный критерий приёмки; максимум 100. Для готовой задачи сначала измените статус",
    {
      ...selector,
      ...boardTask,
      ...addCriterionSchema.shape,
      actor: actorSchema.describe("Автор критерия"),
    },
    false,
    async (backend, input) =>
      changedBoardTask(
        backend.boardTasks.changeCriterion(
          input.reference,
          { ...addCriterionSchema.strip().parse(input), action: "add" },
          input.actor,
        ),
      ),
  );
  projectTool(
    "task_criterion_update",
    "Изменить критерий приёмки; изменение текста сбрасывает выполнение и требует повторной проверки",
    {
      ...selector,
      ...boardTask,
      ...editCriterionSchema.shape,
      actor: actorSchema.describe("Автор изменения критерия"),
    },
    false,
    async (backend, input) =>
      changedBoardTask(
        backend.boardTasks.changeCriterion(
          input.reference,
          { ...editCriterionSchema.strip().parse(input), action: "update" },
          input.actor,
        ),
      ),
  );
  projectTool(
    "task_criterion_complete",
    "Отметить критерий выполненным или снять отметку: completed задаёт явное состояние; сохраняются автор и время",
    {
      ...selector,
      ...boardTask,
      ...completeCriterionSchema.shape,
      actor: actorSchema.describe("Автор отметки выполнения"),
    },
    false,
    async (backend, input) =>
      changedBoardTask(
        backend.boardTasks.changeCriterion(
          input.reference,
          { ...completeCriterionSchema.strip().parse(input), action: "complete" },
          input.actor,
        ),
      ),
  );
  projectTool(
    "task_criterion_remove",
    "Удалить критерий приёмки из задачи с проверкой ревизии",
    {
      ...selector,
      ...boardTask,
      ...removeCriterionSchema.shape,
      actor: actorSchema.describe("Автор удаления критерия"),
    },
    false,
    async (backend, input) =>
      changedBoardTask(
        backend.boardTasks.changeCriterion(
          input.reference,
          { ...removeCriterionSchema.strip().parse(input), action: "remove" },
          input.actor,
        ),
      ),
  );
  projectTool(
    "board_task_update",
    "Изменить заголовок, Markdown или явные продуктовые связи задачи с проверкой ревизии. productLinks заменяет весь набор; [] очищает. Требования читаются адресно через product_context",
    {
      ...selector,
      ...boardTask,
      ...updateBoardTaskSchema.shape,
      actor: actorSchema.describe("Автор изменения задачи"),
    },
    false,
    async (backend, input) =>
      changedBoardTask(
        backend.boardTasks.update(
          input.reference,
          updateBoardTaskSchema.strip().parse(input),
          input.actor,
        ),
      ),
  );
  projectTool(
    "board_task_move",
    "Изменить колонку, порядок или доску. При переносе ключ меняется, ID и связи сохраняются. Блокеры препятствуют завершению",
    {
      ...selector,
      ...boardTask,
      ...moveBoardTaskSchema.shape,
      actor: actorSchema.describe("Автор перемещения задачи"),
    },
    false,
    async (backend, input) =>
      changedBoardTask(
        backend.boardTasks.move(
          input.reference,
          moveBoardTaskSchema.strip().parse(input),
          input.actor,
        ),
      ),
  );
  projectTool(
    "board_task_link",
    "Добавить или удалить междосочную зависимость, обычную связь либо родителя. Циклы запрещены; обратные связи видны в board_task_links",
    {
      ...selector,
      ...boardTask,
      ...linkBoardTaskSchema.shape,
      actor: actorSchema.describe("Автор изменения связи"),
    },
    false,
    async (backend, input) =>
      changedBoardTask(
        backend.boardTasks.link(
          input.reference,
          linkBoardTaskSchema.strip().parse(input),
          input.actor,
        ),
      ),
  );

  projectTool(
    "product_overview",
    "Компактная карта продукта и вычисленная готовность",
    { ...selector },
    true,
    async (backend) => ({ data: await backend.product.overview() }),
  );
  projectTool(
    "product_entities",
    "Найти фичи, сценарии, приложения и реализации по ключу/названию. Краткие сведения без Markdown; ограниченная страница с nextOffset.",
    { ...selector, ...productEntitiesQuerySchema.shape },
    true,
    async (backend, input) => ({
      data: await backend.product.entities(productEntitiesQuerySchema.strip().parse(input)),
    }),
  );
  projectTool(
    "product_get",
    "Прочитать одну продуктовую сущность по ключу или ID. Неоднозначный ключ требует выбора ID.",
    { ...selector, ...productEntityQuerySchema.shape },
    true,
    async (backend, input) => ({ data: await backend.product.entity(input.ref) }),
  );
  projectTool(
    "product_implementation_update",
    "Изменить реализацию фичи или сценария по её собственной ревизии. key меняет адрес, сохраняя ID и связи.",
    {
      ...selector,
      ...updateImplementationSchema.shape,
      actor: actorSchema.describe("Автор изменения реализации"),
    },
    false,
    async (backend, input) => {
      const result = await backend.product.updateImplementation(
        updateImplementationSchema.strip().parse(input),
        input.actor,
      );
      return {
        data: { ...result, requestId: input.requestId },
        text: `Реализация сохранена: ${result.key ?? result.id}\nID: ${result.id}\nРевизия: ${result.revision}\nrequestId: ${input.requestId}`,
      };
    },
  );
  projectTool(
    "product_list",
    "Записи продукта с поиском по Markdown и пагинацией",
    { ...selector, ...productListQuerySchema.shape },
    true,
    async (backend, input) => ({
      data: await backend.product.list(
        productListQuerySchema.parse(
          Object.fromEntries(
            Object.entries(input).filter(([key]) => key !== "project" && key !== "maxBytes"),
          ),
        ),
      ),
    }),
  );
  projectTool(
    "product_context",
    "Паспорт, требования, реализации и документы выбранной области с причинами включения",
    { ...selector, ...productContextQuerySchema.shape },
    true,
    async (backend, input) => ({
      data: await backend.product.context({ id: input.id, applicationId: input.applicationId }),
    }),
  );
  projectTool(
    "product_save",
    "Совместимый универсальный ввод записи. Предпочитайте предметные product_feature_save, product_scenario_save и другие product_*_save: в них цель видна в аргументах. Полные описания — структурированный Markdown. update требует ifRevision, scope также ifVersion.",
    { ...selector, command: productMutationSchema, actor: actorSchema },
    false,
    async (backend, input) => ({ data: await backend.product.mutate(input.command, input.actor) }),
  );
  for (const tool of productWriteTools)
    projectTool(
      tool.name,
      `Создать или изменить ${tool.title}. Передавайте полное содержание: обновление заменяет поля. Полное описание — структурированный Markdown, краткое — обычный многострочный текст. action=update требует id и ifRevision.`,
      { ...selector, ...productWriteArguments, ...tool.schema.shape, actor: actorSchema },
      false,
      async (backend, input) => {
        const {
          project: _project,
          maxBytes: _maxBytes,
          actor,
          action,
          id,
          ifRevision,
          ifVersion,
          requestId,
          key,
          ...values
        } = input;
        const command = productMutationSchema.parse({
          action,
          id,
          ifRevision,
          ifVersion,
          requestId,
          key,
          fields: { kind: tool.kind, ...values },
        });
        return saveProduct(backend, command, actor);
      },
    );
  projectTool(
    "product_scope_replace",
    "Атомарно заменить активный состав приложения. Пустой contracts снимает участие, сохраняя ID и ссылки. Описания реализаций — Markdown с обязательствами и проверкой. ifRevision=0 создаёт состав. Требуется свежая ifVersion продукта.",
    {
      ...selector,
      ...productScopeArguments,
      actor: actorSchema,
      ifRevision: scopeRevision,
      ifVersion: z.string().min(1),
      requestId: requestIdSchema,
    },
    false,
    async (backend, input) =>
      saveProduct(
        backend,
        productMutationSchema.parse({
          action: input.ifRevision === 0 ? "create" : "update",
          ifRevision: input.ifRevision,
          ifVersion: input.ifVersion,
          requestId: input.requestId,
          fields: { kind: "scope", applicationId: input.applicationId, contracts: input.contracts },
        }),
        input.actor,
      ),
  );
  projectTool(
    "product_contract_update",
    "Изменить или подтвердить один контракт приложения. Остальные контракты сохраняются. done подтверждает актуальные требования: используйте только после проверки реализации. Описание — Markdown. Требуются ревизия состава и версия продукта.",
    {
      ...selector,
      ...productContractArguments,
      actor: actorSchema,
      ifRevision: scopeRevision,
      ifVersion: z.string().min(1),
      requestId: requestIdSchema,
    },
    false,
    async (backend, input) => {
      const {
        project: _project,
        maxBytes: _maxBytes,
        actor,
        ifRevision,
        ifVersion,
        requestId,
        ...values
      } = input;
      return saveProduct(
        backend,
        productMutationSchema.parse({
          action: "update",
          ifRevision,
          ifVersion,
          requestId,
          fields: { kind: "contract", ...values },
        }),
        actor,
      );
    },
  );
  projectTool(
    "product_lint",
    "Проверить структуру Markdown и наличие проверяемых результатов. Возвращает предупреждения, не меняет записи и не подтверждает полноту требований.",
    { ...selector, ...productContentQuerySchema.shape },
    true,
    async (backend, input) => ({
      data: lintProduct(await backend.product.state(), {
        id: input.id,
        offset: input.offset,
        limit: input.limit,
      }),
    }),
  );

  define(
    "projects_list",
    "Показать актуальный режим, проекты, пути и подключения",
    { ...selector, ...paging },
    true,
    async (input) => {
      const source = await projects.source();
      invariant(
        input.project === undefined,
        "INVALID_ARGUMENT",
        "projects_list относится ко всему конфигу",
      );
      const items = source.projects;
      const budget = input.maxBytes ?? 16384;
      return checked(
        page(items, input, { tool: "projects_list", url: projects.url }, budget, {
          mode: source.mode,
          configPath: source.configPath,
        }),
        budget,
      );
    },
  );
  define(
    "project_register",
    "Сохранить проект в реестре; replace разрешает заменить подключение. Пути относительны к реестру на сервере",
    {
      project: projectNameSchema,
      ...projectEntrySchema.shape,
      replace: z.boolean().default(false),
    },
    false,
    async (input) => {
      const source = await projects.source();
      invariant(
        source.mode === "workspace",
        "REGISTRY_REQUIRED",
        "Регистрация доступна при запуске с конфигом проектов",
      );
      const { project, replace, ...entry } = input;
      const data = (
        await projects.api.projects.registerProject(
          { project: encodeURIComponent(project) },
          defined({ path: entry.path, config: entry.config, replace }),
        )
      ).data;
      return checked({ data }, 16384);
    },
  );
  define(
    "project_unregister",
    "Удалить регистрацию, сохранив файлы и задачи проекта",
    { project: projectNameSchema },
    false,
    async ({ project }) => {
      const source = await projects.source();
      invariant(source.mode === "workspace", "WORKSPACE_REQUIRED", "Требуется workspace");
      const data = (
        await projects.api.projects.unregisterProject({ project: encodeURIComponent(project) })
      ).data;
      return checked({ data }, 16384);
    },
  );

  projectTool(
    "project_config",
    "Прочитать настройки и пути выбранного проекта через REST API",
    selector,
    true,
    async (backend) => ({ data: { ...backend.workspace, storagePath: backend.workspace.root } }),
  );
  projectTool(
    "project_validate",
    "Проверить продукт, доски, задачи и граф связей проекта",
    selector,
    true,
    async (backend) => ({ data: await backend.validate() }),
  );
  server.setRequestHandler(ListToolsRequestSchema, async () => ({
    tools: [...tools.values()].map((tool) => tool.definition),
  }));
  server.setRequestHandler(CallToolRequestSchema, async ({ params }) => {
    const tool = tools.get(params.name);
    if (!tool) throw new McpError(ErrorCode.InvalidParams, `Неизвестный инструмент ${params.name}`);
    return tool.call(params.arguments);
  });
  return server;
}
