import { useRef, useState } from "react";
import { ActionIcon, Button, Checkbox, Menu, Select, VisuallyHidden } from "@mantine/core";
import { EllipsisVertical, FileText } from "lucide-react";
import { FilterChips } from "ui/filter-chips";
import { RecordRow } from "ui/record-row";
import { SectionPanel } from "ui/section-panel";
import { StatusBadge } from "ui/status-badge";
import type { StatusBadgeTone } from "ui/status-badge";
import { KitExample } from "../kit-example/kit-example";
import styles from "./styles/kit-panels.module.css";

const LONG_WORD_TITLE =
  "Требованиякрелизуидоговорённостиопроверкахбезединогопробеласдлиннымназванием";

const FILTER_OPTIONS = [
  { value: "all", label: "Все", count: 1204 },
  { value: "active", label: "В работе", count: 0 },
  { value: "completed", label: "Завершённые", count: 37 },
  { value: "cancelled", label: "Отменённые", count: "…" },
];

const RECORDS = [
  {
    id: "1",
    code: "REL-12",
    title: "Выпуск мобильного приложения",
    status: "Действующий",
    tone: "success",
  },
  { id: "2", code: "PLN-3", title: LONG_WORD_TITLE, status: "Черновик", tone: "warning" },
] satisfies { id: string; code: string; title: string; status: string; tone: StatusBadgeTone }[];

const LONG_TITLE =
  "Очень длинное название панели с переносом: требования к релизу, договорённости и проверки";

/**
 * Показывает панели и декор: варианты SectionPanel, числа и устойчивость градиента.
 *
 * Используется для:
 *  - выбора варианта панели сводки и каталога
 *  - проверки сплошной основы без изображения и с невалидным изображением
 */
export const KitPanels = () => {
  const [filter, setFilter] = useState("all");
  const [selectedIds, setSelectedIds] = useState<string[]>(["1"]);
  const panelTitleRef = useRef<HTMLHeadingElement>(null);
  const toggleSelected = (id: string, isChecked: boolean): void =>
    setSelectedIds((previous) =>
      isChecked ? [...previous, id] : previous.filter((entry) => entry !== id),
    );
  return (
    <SectionPanel
      title="Страница и панели"
      description="Шапка этой страницы — PageHeader в раскладке toolbar на сцене PageStage."
    >
      <KitExample
        title="Сцена и шапка страницы"
        purpose="Один h1, контекст, пояснение и действия; сцена отделяет содержимое от фона."
        importLine='import { PageStage } from "ui/page-stage"; import { PageHeader } from "ui/page-header";'
        rule="actionsLayout='stack' — сведения и действие записи, 'toolbar' — поиск и создание в каталоге. PageStage layout='workspace' — доска и граф на оставшуюся высоту окна от 768px. Длинное слово в h1 переносится по слогам."
      >
        <p className={styles.note}>Пример — шапка галереи над разделами.</p>
      </KitExample>
      <KitExample
        title="Панель сводки"
        purpose="Именованная область сводки с полным числом и пояснением."
        importLine='import { SectionPanel } from "ui/section-panel";'
        rule="tone='default'; ноль показывается как число, а не скрывается."
      >
        <SectionPanel
          className={styles.sample}
          titleAs="h3"
          title="Планы"
          count={0}
          description="Активных планов нет: создайте план, чтобы связать этапы и задачи."
        >
          <p className={styles.note}>Пустое содержимое владелец объясняет сам.</p>
        </SectionPanel>
      </KitExample>
      <KitExample
        title="Главная панель экрана"
        purpose="Одна выделенная область сводки с градиентом на всю панель."
        importLine={'<SectionPanel tone="feature" />'}
        rule="Не больше одной на экран; смысл не зависит от градиента."
      >
        <SectionPanel
          className={styles.sample}
          titleAs="h3"
          title="Задачи по колонкам"
          count={(1234567).toLocaleString("ru-RU")}
          countLabel="Задач"
          tone="feature"
          actions={<Button variant="default">Доска продукта</Button>}
          description="Крупное число не переносится посреди разрядов."
        >
          <p className={styles.metric}>1 234 567</p>
        </SectionPanel>
      </KitExample>
      <KitExample
        title="Выдача каталога"
        purpose="Длинная выдача строк: градиент только в шапке, тело сплошное."
        importLine={'<SectionPanel tone="feature-header" density="compact" />'}
        rule="Для каталогов; плотность compact оставляет строкам почти всю ширину."
      >
        <SectionPanel
          className={styles.sample}
          titleAs="h3"
          title={LONG_TITLE}
          count={42}
          tone="feature-header"
          density="compact"
          actions={
            <Select
              aria-label="Порядок"
              size="xs"
              data={["Сначала обновлённые", "По названию"]}
              defaultValue="Сначала обновлённые"
            />
          }
        >
          <FilterChips
            label="Состояние записи"
            options={FILTER_OPTIONS}
            value={filter}
            onChange={setFilter}
          />
          <ul className={styles.rows}>
            {RECORDS.map((record) => {
              const isSelected = selectedIds.includes(record.id);
              return (
                <RecordRow
                  key={record.id}
                  component="li"
                  selected={isSelected}
                  code={record.code}
                  leading={
                    <>
                      <Checkbox
                        size="sm"
                        aria-label={`Выбрать: ${record.title}`}
                        checked={isSelected}
                        onChange={(event) => toggleSelected(record.id, event.currentTarget.checked)}
                      />
                      <FileText size={18} strokeWidth={1.6} aria-hidden="true" />
                    </>
                  }
                  title={<a href="#record-row">{record.title}</a>}
                  meta="Описание · раздел «Релизы»"
                  trailing={
                    <>
                      <StatusBadge tone={record.tone}>
                        <VisuallyHidden>Состояние: </VisuallyHidden>
                        {record.status}
                      </StatusBadge>
                      <Menu position="bottom-end">
                        <Menu.Target>
                          <ActionIcon
                            variant="subtle"
                            color="gray"
                            size="lg"
                            aria-label={`Действия: ${record.title}`}
                          >
                            <EllipsisVertical size={17} aria-hidden="true" />
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
              );
            })}
          </ul>
        </SectionPanel>
      </KitExample>
      <KitExample
        id="record-row"
        title="Строка записи"
        purpose="Запись списка плиткой: ключ, название-ссылка, пояснения, состояние и действия в конце."
        importLine='import { RecordRow } from "ui/record-row";'
        rule="Переход — ссылка в title, не вся строка; leading — checkbox и значок, trailing — StatusBadge, сведения и меню (переносятся под название); selected — выбор для массового действия; component='li' в списке, 'article' — самостоятельная запись выдачи. Данные и тон состояния задаёт владелец."
      >
        <ul className={styles.rows}>
          <RecordRow
            component="li"
            code="FEAT-7"
            title={<a href="#record-row">Оплата картой при бронировании</a>}
            trailing={<StatusBadge tone="info">В работе</StatusBadge>}
          />
          <RecordRow
            component="li"
            code="SCN-21"
            title={<a href="#record-row">Зависимость без пояснения и состояния</a>}
          />
        </ul>
      </KitExample>
      <KitExample
        title="Фильтр-переключатель"
        purpose="Один вариант из короткого набора состояний с числом записей; выбор объявлен aria-pressed."
        importLine='import { FilterChips } from "ui/filter-chips";'
        rule="До ~6 вариантов одного фильтра каталога на тонированной панели; варианты переносятся, на touch — 44px. Для переключения режима вида — SegmentedControl, для множественного выбора — Checkbox."
      >
        <SectionPanel className={styles.sample} titleAs="h3" title="Планы" density="compact">
          <FilterChips
            label="Состояние плана"
            options={FILTER_OPTIONS}
            value={filter}
            onChange={setFilter}
          />
        </SectionPanel>
      </KitExample>
      <KitExample
        title="Фокус на заголовок панели"
        purpose="Когда исчезла строка с фокусом, владелец переводит фокус на заголовок панели."
        importLine="<SectionPanel titleRef={ref} />"
        rule="titleRef делает заголовок программно фокусируемым (tabIndex=-1); не оборачивать заголовок в span с tabIndex."
      >
        <SectionPanel
          className={styles.sample}
          titleAs="h3"
          title="Материалы"
          titleRef={panelTitleRef}
          count={3}
          actions={
            <Button variant="default" onClick={() => panelTitleRef.current?.focus()}>
              Фокус на заголовок
            </Button>
          }
        >
          <p className={styles.note}>
            Широкий ребёнок не расширяет панель: колонка minmax(0, 1fr).
          </p>
        </SectionPanel>
      </KitExample>
      <KitExample
        title="Декор: сплошной, градиент, невалидное изображение"
        purpose="Проверка раздела 6: без изображения основа сохраняется."
        importLine="background-color: var(--tasks-feature-surface); background-image: var(--tasks-feature-image);"
        rule="Цвет и изображение задаются раздельно; поздний shorthand background запрещён."
      >
        <div className={styles.decor}>
          <div className={styles.decorSample} data-decor="solid">
            Сплошная основа
          </div>
          <div className={styles.decorSample} data-decor="gradient">
            Градиент
          </div>
          <div className={styles.decorSample} data-decor="invalid">
            Невалидное изображение
          </div>
          <div className={styles.decorSample} data-decor="hatch">
            Штриховка «На проверке»
          </div>
        </div>
      </KitExample>
    </SectionPanel>
  );
};
