import { useState } from "react";
import {
  ActionIcon,
  Button,
  Checkbox,
  Drawer,
  Menu,
  Modal,
  Select,
  TextInput,
} from "@mantine/core";
import { useDisclosure } from "@mantine/hooks";
import { Archive, Ellipsis, Eye, Pencil, Trash2 } from "lucide-react";
import { SectionPanel } from "ui/section-panel";
import { StatusBadge } from "ui/status-badge";
import { KitExample } from "../kit-example/kit-example";
import styles from "./styles/kit-overlays.module.css";

const ROW_TITLE = "Правила публикации релиза для команды поддержки и внешних интеграций";

/**
 * Показывает строку записи с выбором и меню, а также диалог и выдвижную панель.
 *
 * Используется для:
 *  - проверки фокуса, Escape, возврата фокуса и порядка слоёв
 */
export const KitOverlays = () => {
  const [isSelected, setSelected] = useState(false);
  const [isModalOpen, modal] = useDisclosure(false);
  const [isDrawerOpen, drawer] = useDisclosure(false);
  const [isConfirmOpen, confirm] = useDisclosure(false);
  return (
    <SectionPanel title="Строка, меню и окна">
      <KitExample
        title="Строка записи с выбором и меню"
        purpose="Запись каталога: выбор, название, метаданные и действия всегда видны."
        importLine='import { Checkbox, Menu, ActionIcon } from "@mantine/core";'
        rule="Строка не кнопка; выбор — checkbox, действия — отдельные кнопки с доступным именем."
      >
        <article className={styles.row} data-selected={isSelected}>
          <Checkbox
            aria-label={`Выбрать: ${ROW_TITLE}`}
            checked={isSelected}
            onChange={(event) => setSelected(event.currentTarget.checked)}
          />
          <div className={styles.rowMain}>
            <span className={styles.rowTitle}>{ROW_TITLE}</span>
            <span className={styles.rowMeta}>
              Правила
              <StatusBadge tone="warning">Черновик</StatusBadge>
              обновлено 9 окт.
            </span>
          </div>
          <div className={styles.rowActions}>
            <ActionIcon aria-label={`Предпросмотр: ${ROW_TITLE}`} onClick={drawer.open}>
              <Eye size={16} aria-hidden="true" />
            </ActionIcon>
            <Menu position="bottom-end">
              <Menu.Target>
                <ActionIcon aria-label={`Действия: ${ROW_TITLE}`}>
                  <Ellipsis size={16} aria-hidden="true" />
                </ActionIcon>
              </Menu.Target>
              <Menu.Dropdown>
                <Menu.Item leftSection={<Pencil size={14} />} onClick={modal.open}>
                  Изменить
                </Menu.Item>
                <Menu.Item leftSection={<Archive size={14} />}>В архив</Menu.Item>
                <Menu.Divider />
                <Menu.Item color="danger" leftSection={<Trash2 size={14} />}>
                  Удалить
                </Menu.Item>
              </Menu.Dropdown>
            </Menu>
          </div>
        </article>
      </KitExample>
      <KitExample
        title="Диалог и выдвижная панель"
        purpose="Короткая форма поверх страницы и подробности записи сбоку."
        importLine='import { Modal, Drawer } from "@mantine/core";'
        rule="Начальный фокус на первом поле, Escape закрывает, фокус возвращается к вызвавшей кнопке. Подтверждение поверх окна — второй Modal без собственного zIndex: Mantine кладёт его выше, список внутри окна — над обоими."
      >
        <Button variant="default" onClick={modal.open}>
          Открыть диалог
        </Button>
        <Button variant="default" onClick={drawer.open}>
          Открыть панель
        </Button>
      </KitExample>
      <Modal opened={isModalOpen} onClose={modal.close} title="Изменить материал">
        <div className={styles.form}>
          <TextInput label="Название" defaultValue={ROW_TITLE} data-autofocus />
          <Select
            label="Состояние"
            data={["Черновик", "Действующий", "Архив"]}
            defaultValue="Черновик"
            comboboxProps={{ withinPortal: true }}
          />
          <div className={styles.formActions}>
            <Button
              color="danger"
              variant="subtle"
              leftSection={<Trash2 size={15} aria-hidden="true" />}
              onClick={confirm.open}
            >
              Удалить
            </Button>
            <Button variant="default" onClick={modal.close}>
              Отмена
            </Button>
            <Button onClick={modal.close}>Сохранить</Button>
          </div>
        </div>
      </Modal>
      <Modal opened={isConfirmOpen} onClose={confirm.close} title="Удалить материал?" size="lg">
        <div className={styles.form}>
          <p className={styles.drawerText}>
            Материал и его связи будут удалены. Восстановление после удаления не предусмотрено.
          </p>
          <div className={styles.formActions}>
            <Button variant="default" onClick={confirm.close} data-autofocus>
              Отмена
            </Button>
            <Button
              color="danger"
              onClick={() => {
                confirm.close();
                modal.close();
              }}
            >
              Подтвердить удаление
            </Button>
          </div>
        </div>
      </Modal>
      <Drawer
        opened={isDrawerOpen}
        onClose={drawer.close}
        position="right"
        title="Предпросмотр материала"
      >
        <div className={styles.drawerBody}>
          <p className={styles.drawerText}>{ROW_TITLE}</p>
          {Array.from({ length: 12 }, (_, index) => (
            <p key={index} className={styles.drawerText}>
              Абзац {index + 1}. Длинное содержимое прокручивается внутри панели, а страница под ней
              остаётся на месте.
            </p>
          ))}
        </div>
      </Drawer>
    </SectionPanel>
  );
};
