import { Anchor } from "@mantine/core";
import { Link } from "react-router-dom";
import { MarkdownField } from "ui/markdown-field";
import { MarkdownView } from "ui/markdown-view";
import { SectionPanel } from "ui/section-panel";
import { PageBreadcrumbs } from "compositions/widgets/page-breadcrumbs";
import { KitExample } from "../kit-example/kit-example";
import styles from "./styles/kit-content.module.css";

const MARKDOWN = `#### Правила релиза

Релиз публикуется после проверки **всех** обязательных критериев. Подробности — в [руководстве](https://example.com/guide).

- Проверить готовность задач плана
- Согласовать заметки к выпуску

| Этап | Задач | Готово |
| --- | ---: | ---: |
| Подготовка | 12 | 12 |
| Проверка | 1 024 | 0 |

\`\`\`bash
pnpm run build:web
\`\`\`
`;

/** Путь глубокой страницы с длинными названиями для проверки переноса. */
const BREADCRUMBS = [
  { id: "project", label: "Большой каталог материалов", href: "/dev/ui-kit" },
  { id: "documents", label: "Библиотека знаний", href: "/dev/ui-kit" },
  {
    id: "document",
    label: "Правила публикации релиза для команды поддержки и внешних интеграций",
  },
];

const LONG_TEXT =
  "Сверхдлинноеназваниебезпробеловдляпроверкипереносавузкихколонках и обычный русский текст: " +
  "запись сохраняет контекст работы, поэтому человек и агент продолжают её с того места, " +
  "где остановились, видят связанные материалы, задачи и следующий осмысленный шаг.";

/**
 * Показывает чтение Markdown и длинного русского текста по шкале темы.
 *
 * Используется для:
 *  - проверки длины строки, переносов, таблиц, кода и ссылок
 */
export const KitContent = () => {
  return (
    <SectionPanel title="Содержание">
      <KitExample
        title="Markdown"
        purpose="Чтение материала: заголовки, списки, таблица, код и ссылка."
        importLine='import { MarkdownField } from "ui/markdown-field";
import { MarkdownView } from "ui/markdown-view";'
        rule="Существующий MarkdownView; compact — только для сообщений и подробностей."
      >
        <MarkdownView className={styles.reading} text={MARKDOWN} />
      </KitExample>
      <KitExample
        title="Поле Markdown"
        purpose="Ввод описания, итога или сообщения в Markdown с подсветкой разметки."
        importLine='import { MarkdownField } from "ui/markdown-field";'
        rule="Видимая подпись label; required — звёздочка и aria-required, как у полей Mantine; ошибка — свойство error. Редактор загружается отдельно при первом показе."
      >
        <div className={styles.reading}>
          <MarkdownField
            label="Итог плана"
            required
            minRows={3}
            defaultValue={"Выпущено **12** задач, перенесено две."}
          />
        </div>
      </KitExample>
      <KitExample
        title="Ссылки"
        purpose="Переход из читаемого текста и отдельная ссылка-переход."
        importLine='import { Anchor } from "@mantine/core";'
        rule='Цвет ссылки — акцент (≥4.5:1). В абзаце — underline="always", как в Markdown; отдельный переход — подчёркивание при наведении.'
      >
        <p className={styles.long}>
          Подробности о порядке выпуска —{" "}
          <Anchor component={Link} to="/dev/ui-kit" underline="always">
            в руководстве по релизам
          </Anchor>{" "}
          и в описании плана.
        </p>
        <Anchor component={Link} to="/dev/ui-kit" size="sm">
          Все материалы проекта
        </Anchor>
      </KitExample>
      <KitExample
        title="Хлебные крошки"
        purpose="Путь страницы под шапкой каркаса и в окне задачи."
        importLine='import { PageBreadcrumbs } from "compositions/widgets/page-breadcrumbs";'
        rule="Уровни переносятся строкой ниже, а не сжимаются; при нехватке места предки уходят в меню «…»."
      >
        <PageBreadcrumbs items={BREADCRUMBS} className={styles.breadcrumbs} />
      </KitExample>
      <KitExample
        title="Длинный текст и числа"
        purpose="Перенос длинных слов и табличные цифры в метриках."
        importLine="font-variant-numeric: tabular-nums; overflow-wrap: anywhere;"
        rule="Название записи переносится полностью; числа метрик выравниваются по разрядам."
      >
        <p className={styles.long}>{LONG_TEXT}</p>
        <p className={styles.numbers}>0 · 7 · 1 234 567</p>
      </KitExample>
    </SectionPanel>
  );
};
