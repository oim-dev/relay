import {
  ActionIcon,
  Badge,
  Button,
  Checkbox,
  Progress,
  Select,
  Tabs,
  Textarea,
  TextInput,
  Tooltip,
} from "@mantine/core";
import { CircleAlert, Pencil, Plus, Settings, Trash2 } from "lucide-react";
import { SectionPanel } from "ui/section-panel";
import { StatusBadge } from "ui/status-badge";
import { KitExample } from "../kit-example/kit-example";
import styles from "./styles/kit-controls.module.css";

const SELECT_OPTIONS = ["Сначала обновлённые", "По названию"];

/**
 * Показывает контролы Mantine с настройками темы: размеры, варианты и состояния.
 *
 * Используется для:
 *  - выбора варианта кнопки, поля, отметки и бейджа без локальных обёрток
 */
export const KitControls = () => {
  return (
    <SectionPanel title="Контролы" description="Публичные компоненты Mantine с общей темой.">
      <KitExample
        title="Кнопки"
        purpose="Главное действие формы, второстепенные и опасные действия."
        importLine='import { Button } from "@mantine/core";'
        rule="Одно filled-действие на панели; опасное — color='danger'; loading до ответа сервера."
      >
        <Button leftSection={<Plus size={16} aria-hidden="true" />}>Сохранить</Button>
        <Button variant="default">Отмена</Button>
        <Button variant="light" color="accent">
          Текущий выбор
        </Button>
        <Button variant="subtle">Ещё</Button>
        <Button color="danger" leftSection={<Trash2 size={16} aria-hidden="true" />}>
          Удалить
        </Button>
        <Button loading>Сохраняем</Button>
        <Button disabled>Недоступно</Button>
        <Button size="xs" variant="default">
          Компактная 30px
        </Button>
        <Button size="md" variant="default">
          Крупная 42px
        </Button>
      </KitExample>
      <KitExample
        title="Иконки-действия"
        purpose="Компактное действие в строке или шапке с доступным именем."
        importLine='import { ActionIcon, Tooltip } from "@mantine/core";'
        rule="Всегда aria-label; на touch область нажатия 44×44px задаёт тема."
      >
        <Tooltip label="Изменить материал">
          <ActionIcon aria-label="Изменить материал">
            <Pencil size={16} aria-hidden="true" />
          </ActionIcon>
        </Tooltip>
        <Tooltip label="Настройки проекта">
          <ActionIcon variant="default" aria-label="Настройки проекта">
            <Settings size={16} aria-hidden="true" />
          </ActionIcon>
        </Tooltip>
        <ActionIcon color="danger" variant="light" aria-label="Удалить связь">
          <Trash2 size={16} aria-hidden="true" />
        </ActionIcon>
        <ActionIcon disabled aria-label="Недоступное действие">
          <Pencil size={16} aria-hidden="true" />
        </ActionIcon>
      </KitExample>
      <KitExample
        title="Поля"
        purpose="Ввод и выбор значений формы, ошибки рядом с полем."
        importLine='import { TextInput, Select, Textarea } from "@mantine/core";'
        rule="Видимая подпись label; ошибка — свойство error, а не цвет рамки вручную."
      >
        <div className={styles.fields}>
          <TextInput label="Название" placeholder="Например, Правила релиза" />
          <TextInput label="Адрес" defaultValue="не адрес" error="Укажите адрес с https://" />
          <TextInput label="Ключ" defaultValue="PRODUCT-12" disabled />
          <Select label="Порядок" data={SELECT_OPTIONS} defaultValue={SELECT_OPTIONS[0]} />
          <Textarea
            label="Описание"
            autosize
            minRows={2}
            defaultValue="Длинное описание переносится внутри поля и не расширяет страницу."
          />
        </div>
      </KitExample>
      <KitExample
        title="Отметки"
        purpose="Выбор записей и согласие с условием."
        importLine='import { Checkbox } from "@mantine/core";'
        rule="Выбор строки — checkbox с подписью или aria-label, а не клик по всей строке."
      >
        <Checkbox label="Не выбрано" />
        <Checkbox label="Выбрано" defaultChecked />
        <Checkbox label="Выбраны не все" indeterminate />
        <Checkbox label="Недоступно" disabled />
        <Checkbox label="Нужно подтвердить" error="Подтвердите перед публикацией" />
      </KitExample>
      <KitExample
        title="Вкладки"
        purpose="Переключение представлений одной записи."
        importLine='import { Tabs } from "@mantine/core";'
        rule="Текущая вкладка — акцент; для перехода между страницами используйте ссылки."
      >
        <Tabs defaultValue="content" className={styles.wide}>
          <Tabs.List>
            <Tabs.Tab value="content">Содержание</Tabs.Tab>
            <Tabs.Tab value="relations">Связи</Tabs.Tab>
            <Tabs.Tab value="history" disabled>
              История
            </Tabs.Tab>
          </Tabs.List>
        </Tabs>
      </KitExample>
      <KitExample
        title="Бейдж состояния"
        purpose="Состояние записи короткой подписью."
        importLine='import { StatusBadge } from "ui/status-badge";'
        rule="Тон выбирает владелец статуса: neutral, info, success, warning, danger."
      >
        <StatusBadge>Архив</StatusBadge>
        <StatusBadge tone="info">Запланирован</StatusBadge>
        <StatusBadge tone="success">Действующий</StatusBadge>
        <StatusBadge tone="warning">Черновик</StatusBadge>
        <StatusBadge tone="danger" icon={<CircleAlert size={12} />}>
          Заблокирован
        </StatusBadge>
      </KitExample>
      <KitExample
        title="Счётчики Mantine Badge"
        purpose="Количество и короткая метка на контроле."
        importLine='import { Badge } from "@mantine/core";'
        rule="Подпись не меньше 12px; для состояния записи — StatusBadge."
      >
        <Badge>0</Badge>
        <Badge color="accent">1 234 567</Badge>
        <Badge variant="light" color="success">
          Готово
        </Badge>
        <Badge variant="outline" color="danger">
          Ошибка
        </Badge>
      </KitExample>
      <KitExample
        title="Прогресс"
        purpose="Доля выполнения: ноль, часть и завершение."
        importLine='<Progress variant="accent" value={45} />'
        rule="Акцентный вариант для показателей выполнения; число всегда рядом в тексте."
      >
        <div className={styles.progress}>
          <Progress variant="accent" value={0} aria-label="Выполнено 0%" />
          <Progress variant="accent" value={45} aria-label="Выполнено 45%" />
          <Progress variant="accent" value={100} aria-label="Выполнено 100%" />
          <Progress value={30} aria-label="Нейтральная доля 30%" />
        </div>
      </KitExample>
    </SectionPanel>
  );
};
