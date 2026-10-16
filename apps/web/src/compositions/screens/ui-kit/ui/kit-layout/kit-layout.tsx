import { SectionPanel } from "ui/section-panel";
import { KitExample } from "../kit-example/kit-example";
import { KitNavStates } from "./ui/kit-nav-states/kit-nav-states";
import { KitShell } from "./ui/kit-shell/kit-shell";
import styles from "./styles/kit-layout.module.css";

const BACKDROP_SAMPLES = [
  { decor: "image", label: "Основа и декор", note: "backdrop + backdrop-image" },
  { decor: "solid", label: "Сплошная основа", note: "Декор выключен, печать, forced-colors" },
  { decor: "invalid", label: "Невалидное изображение", note: "Основа остаётся читаемой" },
];

/**
 * Показывает общий макет на подложке приложения: роли фона и fallback, состояния
 * навигации и композиционный пример каркаса на desktop и узком экране.
 *
 * Используется для:
 *  - сверки подложки, навигации и ритма панелей галереи с каркасом проекта
 */
export const KitLayout = () => {
  return (
    <SectionPanel
      title="Макет на общей подложке"
      description="Одна подложка под шапкой, навигацией, крошками и между панелями. Эта страница сама стоит на ней: переключите схему и декор в шапке галереи."
    >
      <KitExample
        title="Общая подложка"
        purpose="Почти белая (в тёмной схеме — тёмная нейтральная) основа с тихими холодными переходами; объединяет каркас и промежутки между панелями."
        importLine="html { background-color: var(--tasks-backdrop) } body::before { background-image: var(--tasks-backdrop-image) }"
        rule="Задаётся только темой: основа на html, декор — фиксированный слой окна (без шва и повтора при прокрутке, без событий). Экраны и панели подложку не повторяют. Отключение декора — html[data-tasks-decor='off'], в forced-colors и печати image-слой — none. Здесь образцы уменьшены и привязаны к области, а не к окну."
      >
        <ul className={styles.backdrops}>
          {BACKDROP_SAMPLES.map((sample) => (
            <li key={sample.decor} className={styles.backdrop} data-decor={sample.decor}>
              <span className={styles.backdropLabel}>{sample.label}</span>
              <span className={styles.backdropNote}>{sample.note}</span>
              <span className={styles.backdropPanel}>Панель card</span>
            </li>
          ))}
        </ul>
      </KitExample>
      <KitExample
        title="Состояния навигации"
        purpose="Пункт, вложенный пункт, кнопка-иконка и выбор проекта на подложке: без постоянных плашек, состояние — у одного контрола."
        importLine='import { NavLink, ActionIcon, Select } from "@mantine/core"; /* оформление — тема: NavLink mod={{ nested, "current-group", "group-start" }}, Select variant="navigation" */'
        rule="Правила принадлежат теме (ui/themes, navigation.module.css и controls.module.css): каркас и эти образцы используют один источник. Текущий — aria-current и локальная заливка, цвет и вес текста (у кнопки-иконки — контур); раскрытая кнопка-иконка — заливка и контур selected-border; наведение — nav-hover; фокус — контур focus-ring. Образцы зафиксированы атрибутом data-tasks-preview и не получают фокус; живое поведение — в примере каркаса ниже."
      >
        <KitNavStates />
      </KitExample>
      <KitExample
        id="kit-shell"
        title="Каркас: desktop"
        purpose="Прозрачные шапка и сайдбар, выбор проекта, крошки, заголовок и три панели в ритме 12/8px."
        importLine="--tasks-app-header-height, --tasks-workspace-gutter, --tasks-sidebar-gap, --tasks-panel-gap"
        rule="Сайдбар от 1024px окна, ниже — кнопка меню и Drawer, как в каркасе проекта. Заголовок и путь стоят на подложке; поверхность получают только панели. Пункты меню и «Настройки» меняют текущий раздел примера."
      >
        <KitShell variant="desktop" />
      </KitExample>
      <KitExample
        title="Каркас: узкий экран"
        purpose="Раскладка телефона: кнопка меню открывает Drawer поверх страницы, панели — в одну колонку."
        importLine="<Drawer classNames={{ content, header }} /> /* заливка chrome, overlay, Escape и возврат фокуса */"
        rule="Drawer — временная поверхность: у него своя читаемая заливка и разделитель шапки; прозрачность постоянного сайдбара на него не распространяется."
      >
        <KitShell variant="mobile" />
      </KitExample>
    </SectionPanel>
  );
};
