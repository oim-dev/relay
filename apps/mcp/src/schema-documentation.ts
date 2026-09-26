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

/** Дополняет JSON Schema без изменения валидации. Неизвестное поле требует явного описания. */
export function documentToolSchema<T>(schema: T): T {
  function visit(value: unknown): void {
    if (Array.isArray(value)) {
      value.forEach(visit);
      return;
    }
    if (!value || typeof value !== "object") return;
    const node = value as Record<string, unknown>;
    if (node.properties && typeof node.properties === "object") {
      for (const [name, field] of Object.entries(node.properties)) {
        if (!field || typeof field !== "object") continue;
        const property = field as Record<string, unknown>;
        if (name === "requestId") property.description = descriptions.requestId;
        if (!property.description) {
          if (!descriptions[name])
            throw new Error(`Нарушение протокола MCP: нет русского описания аргумента ${name}`);
          property.description = descriptions[name];
        }
      }
    }
    for (const entry of Object.values(node)) visit(entry);
  }
  visit(schema);
  return schema;
}
