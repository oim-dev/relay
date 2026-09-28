/** Общие определения действующих аргументов discovery. */
const descriptions: Record<string, string> = {
  project: "Имя проекта из projects_list; в workspace обязательно, в local опускается",
  maxBytes:
    "Максимальный размер ответа от 1 КиБ до 128 МиБ; превышение возвращает ошибку, полный контекст не усекается",
  actor: "Автор изменения",
  id: "ID цели операции из предыдущего чтения",
  name: "Короткое название одной строкой без Markdown и переносов",
  slug: "Неизменяемый уникальный в проекте адрес приложения и доски",
  title: "Заголовок одной строкой без Markdown и переносов",
  summary: "Краткое описание обычным многострочным текстом",
  description: "Полное описание в Markdown: цель, правила, шаги, ошибки и проверяемый результат",
  body: "Содержание документа в Markdown; сохраняйте ссылки, списки и примеры",
  action: "Создание/обновление записи либо добавление/удаление связи",
  kind: "Вид сущности из перечисления; определяет допустимые поля",
  fields: "Полное содержание продуктовой записи",
  command: "Операция универсального ввода продукта; предпочтительны предметные инструменты",
  ifRevision: "Ревизия из последнего чтения; защищает от перезаписи чужих изменений",
  ifVersion: "Версия продукта из overview/state; защищает состав от изменения требований",
  requestId:
    "Идентификатор корреляции запроса, не ключ дедупликации. После потери ответа прочитайте текущее состояние; не повторяйте запись вслепую",
  featureId: "ID родительской фичи из текущего продукта",
  scenarioId: "ID сценария; null означает общий контракт фичи",
  applicationId: "ID приложения-реализатора в продукте, а не ключ проекта workspace",
  contractId: "ID активного контракта из состава приложения",
  contracts: "Полный набор активных контрактов; пустой массив снимает участие",
  links: "Типизированные связи документа с продуктом и реализациями",
  documentKind:
    "Назначение документа: ТЗ, описание, правила, инструкция, проект решения, решение или исследование",
  type: "Тип приложения из перечисления",
  status: "Состояние реализации; done требует фактического подтверждения требований",
  q: "Поисковый текст в ключах, названии и содержании",
  limit: "Максимальное число элементов страницы",
  offset: "Смещение; для продолжения используйте nextOffset и те же фильтры",
  cursor: "Непрозрачный курсор предыдущего ответа; сохраняйте проект и фильтры",
  path: "Локальный путь проекта относительно workspace-конфига",
  config: "Путь конфигурации проекта; в регистрации разрешается относительно path",
  replace: "Разрешить замену существующей регистрации проекта",
};

const contentByKind: Record<string, string> = {
  product: "Назначение продукта, пользователи, цели, границы и ограничения",
  passport: "Назначение продукта, пользователи, цели, границы и ограничения",
  feature:
    "Для кого и зачем возможность, требуемое поведение, правила, границы и проверяемые результаты",
  scenario: "Участник, предусловия, шаги, альтернативы, ошибки и наблюдаемый результат",
  application: "Ответственность приложения, границы, взаимодействия и ограничения",
  implementation:
    "Требования к вкладу именно этого приложения: поведение, входы/выходы, взаимодействия, ошибки и проверка",
  contract:
    "Требования к вкладу именно этого приложения: поведение, входы/выходы, взаимодействия, ошибки и проверка",
  task: "Цель изменения, основания, конкретная работа, границы и способ проверки",
  criterion: "Условия, действия проверки и наблюдаемый результат",
  comment: "Сделанное или уточнение, основания, фактические проверки, ограничения и следующий шаг",
  release: "Содержание выпуска, значимые изменения, ограничения и основания поставки",
};
const contentByField: Record<string, string> = {
  body: "Содержание по типу документа, основания, правила или выводы и открытые вопросы",
  goal: "Зачем изменение и что должно получиться",
  rationale: "Проблема, источники и причины выбранной работы",
  boundaries: "Что входит в изменение и что исключено",
  expectedResult: "Наблюдаемые изменения и способ проверки",
  outcome: "Результат этапа и границы ответственности",
  completionConditions:
    "Наблюдаемые признаки завершения и способ проверки; это текстовые условия, не исполняемый код",
  result: "Фактический итог или причина отмены, основания проверок, ограничения и следующий шаг",
};
const contentRule =
  "Структурируйте разделами и списками в Markdown, достаточно подробно для исполнения и проверки без чата; не заменяйте краткой аннотацией. Правила берите из источников, неизвестное уточняйте или обозначайте вопросом.";

/** Дополняет JSON Schema без изменения валидации. Неизвестное поле требует явного описания. */
export function documentToolSchema<T>(schema: T, toolName = ""): T {
  const toolKind =
    /^(?:entity|product)_([^_]+)_/.exec(toolName)?.[1] ??
    (/^task_criterion_/.test(toolName)
      ? "criterion"
      : /^task_comment_/.test(toolName)
        ? "comment"
        : /^board_task_/.test(toolName)
          ? "task"
          : /^release_/.test(toolName)
            ? "release"
            : undefined);
  function visit(value: unknown, owner?: string): void {
    if (Array.isArray(value)) {
      value.forEach((entry) => visit(entry, owner));
      return;
    }
    if (!value || typeof value !== "object") return;
    const node = value as Record<string, unknown>;
    if (node.properties && typeof node.properties === "object") {
      const properties = node.properties as Record<string, Record<string, unknown>>;
      const kind = properties.kind?.const;
      if (typeof kind === "string") owner = kind;
      for (const [name, field] of Object.entries(node.properties)) {
        if (!field || typeof field !== "object") continue;
        const property = field as Record<string, unknown>;
        if (name === "requestId") property.description = descriptions.requestId;
        if (!property.description) {
          if (!descriptions[name])
            throw new Error(`Нарушение протокола MCP: нет русского описания аргумента ${name}`);
          property.description = descriptions[name];
        }
        const hint = name === "description" ? contentByKind[owner ?? ""] : contentByField[name];
        if (hint) property.description = `${property.description}. ${hint}. ${contentRule}`;
        // Предметный контекст нужен внутри универсального ввода и состава, но не у пояснений связей.
        visit(
          property,
          name === "contracts"
            ? "implementation"
            : ["fields", "command"].includes(name)
              ? owner
              : undefined,
        );
      }
    }
    for (const [key, entry] of Object.entries(node)) if (key !== "properties") visit(entry, owner);
  }
  visit(schema, toolKind);
  return schema;
}
