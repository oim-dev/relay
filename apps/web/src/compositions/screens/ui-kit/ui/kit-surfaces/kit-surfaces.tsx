import { useId } from "react";
import { ActionIcon, Button, Drawer, Menu, VisuallyHidden } from "@mantine/core";
import { useDisclosure } from "@mantine/hooks";
import { EllipsisVertical, Eye } from "lucide-react";
import { RecordRow } from "ui/record-row";
import { SectionPanel } from "ui/section-panel";
import { StatePanel } from "ui/state-panel";
import { StatusBadge } from "ui/status-badge";
import styles from "./styles/kit-surfaces.module.css";

const LONG_TITLE =
  "Требования к выпуску мобильного приложения, договорённости с поддержкой и проверки внешних интеграций";

const ROWS = [
  { id: "1", code: "DOC-14", title: "Правила публикации релиза", status: "Действующий" },
  { id: "2", code: "DOC-15", title: "Чек-лист проверки заметок к выпуску", status: "Действующий" },
  {
    id: "3",
    code: "DOC-21",
    title: "Инструкция по откату миграции каталога",
    status: "Действующий",
  },
];

const RULES = [
  {
    term: "Подложка",
    text: "Каркас, путь, заголовок страницы, панель действий и промежутки между панелями. Её рисует только тема; экраны, панели и полосы навигации её не повторяют.",
  },
  {
    term: "Панель",
    text: "SectionPanel (card) — смысловая группа: показатели, список, чтение, форма. Отделяется от подложки тоном, без рамки и тени. Внешней сцены вокруг всех панелей нет.",
  },
  {
    term: "Строка",
    text: "RecordRow (tile) — запись внутри панели. Каждую строку текста не превращают в карточку.",
  },
  {
    term: "Акцент",
    text: "tone='feature' — не больше одной на экран; общий фон — отдельная роль и в этот лимит не входит.",
  },
  {
    term: "Overlay",
    text: "Menu, Popover, Tooltip, Modal, Drawer и уведомления — своя заливка, тень и слой выше каркаса; прозрачность шапки и сайдбара на них не распространяется.",
  },
  {
    term: "Зазор",
    text: "--tasks-panel-gap: 12px от 768px, 8px ниже — между соседними панелями одной сетки. Больший шаг шкалы — только между самостоятельными смысловыми разделами.",
  },
  {
    term: "Поля",
    text: "--tasks-workspace-gutter: 16px от 768px, 12px ниже — у края окна; --tasks-sidebar-gap 12px — между сайдбаром и контентом. PageStage горизонтальных полей не задаёт.",
  },
  {
    term: "Внутри",
    text: "Поля панели 16–24px (compact — меньше по горизонтали), шрифт, контролы и touch 44px не уплотняются вместе с зазором.",
  },
];

/**
 * Показывает панели и строки прямо на общей подложке страницы: длинный заголовок,
 * заполненный список с меню и предпросмотром, пустое состояние, ошибку и загрузку,
 * а также краткие правила выбора поверхности и отступов.
 *
 * Используется для:
 *  - проверки отделения панелей от подложки без рамок и теней в обеих схемах
 *  - выбора поверхности, межпанельного зазора и внутренних полей
 */
export const KitSurfaces = () => {
  const titleId = useId();
  const [isPreviewOpen, preview] = useDisclosure(false);
  return (
    <section id="kit-surfaces" className={styles.root} aria-labelledby={titleId}>
      <div className={styles.intro}>
        <h2 id={titleId} className={styles.title}>
          Панели на общей подложке
        </h2>
        <p className={styles.description}>
          Панели ниже стоят прямо на подложке страницы через зазор --tasks-panel-gap, без внешней
          сцены, как на экранах проекта.
        </p>
      </div>
      <div className={styles.grid}>
        <SectionPanel
          className={styles.half}
          titleAs="h3"
          title={LONG_TITLE}
          count={(1204).toLocaleString("ru-RU")}
          actions={<Button variant="default">Все требования</Button>}
          description="Длинный заголовок переносится, число и действие остаются в шапке панели."
        >
          <p className={styles.note}>Содержимое владелец показывает сам.</p>
        </SectionPanel>
        <SectionPanel
          className={styles.half}
          titleAs="h3"
          title="Материалы библиотеки"
          count={ROWS.length}
          density="compact"
        >
          <ul className={styles.rows}>
            {ROWS.map((row) => (
              <RecordRow
                key={row.id}
                component="li"
                code={row.code}
                title={<a href="#kit-surfaces">{row.title}</a>}
                meta="Правила · обновлено 9 окт."
                trailing={
                  <>
                    <StatusBadge tone="success">
                      <VisuallyHidden>Состояние: </VisuallyHidden>
                      {row.status}
                    </StatusBadge>
                    <ActionIcon aria-label={`Предпросмотр: ${row.title}`} onClick={preview.open}>
                      <Eye size={16} aria-hidden="true" />
                    </ActionIcon>
                    <Menu position="bottom-end">
                      <Menu.Target>
                        <ActionIcon aria-label={`Действия: ${row.title}`}>
                          <EllipsisVertical size={16} aria-hidden="true" />
                        </ActionIcon>
                      </Menu.Target>
                      <Menu.Dropdown>
                        <Menu.Item>Закрепить</Menu.Item>
                        <Menu.Item>В архив</Menu.Item>
                      </Menu.Dropdown>
                    </Menu>
                  </>
                }
              />
            ))}
          </ul>
        </SectionPanel>
        <div className={styles.state}>
          <StatePanel
            titleAs="h2"
            title="Материалов пока нет"
            description="Добавьте первый материал или сбросьте фильтры."
            action={<Button variant="default">Сбросить фильтры</Button>}
          />
        </div>
        <div className={styles.state}>
          <StatePanel
            state="error"
            titleAs="h2"
            title="Не удалось загрузить материалы"
            description="Проверьте подключение к серверу Relay и повторите."
            action={<Button>Повторить</Button>}
          />
        </div>
        <div className={styles.state}>
          <StatePanel
            state="loading"
            titleAs="h2"
            title="Загружаем материалы"
            description="Получаем каталог проекта."
          />
        </div>
        <SectionPanel titleAs="h3" title="Правила поверхности и отступов" className={styles.rules}>
          <dl className={styles.ruleList}>
            {RULES.map((rule) => (
              <div key={rule.term} className={styles.rule}>
                <dt className={styles.ruleTerm}>{rule.term}</dt>
                <dd className={styles.ruleText}>{rule.text}</dd>
              </div>
            ))}
          </dl>
        </SectionPanel>
      </div>
      <Drawer
        opened={isPreviewOpen}
        onClose={preview.close}
        position="right"
        title="Предпросмотр материала"
      >
        <p className={styles.note}>
          Drawer — временная поверхность со своей заливкой и overlay поверх подложки и каркаса.
        </p>
      </Drawer>
    </section>
  );
};
