import { Button, Group } from "@mantine/core";
import { BookOpen, Kanban } from "lucide-react";
import { Link } from "react-router-dom";
import { useProjectBasePath } from "domains/project";
import { PageHeader } from "ui/page-header";
import { PageStage } from "ui/page-stage";
import { StatePanel } from "ui/state-panel";
import styles from "./styles/infrastructure.module.css";

/**
 * Показывает статус раздела инфраструктуры проекта и ведёт к уже действующим местам работы.
 * Каталога записей инфраструктуры нет: у Relay пока нет её предметного контракта.
 *
 * Используется для:
 *  - перехода к разрабатываемому разделу из навигации
 *  - перехода к инфраструктурной доске и библиотеке знаний
 */
export const InfrastructureScreen = () => {
  const base = useProjectBasePath();
  return (
    <PageStage className={styles.stage}>
      <PageHeader
        title="Инфраструктура"
        description="Раздел для записей инфраструктуры проекта. Он ещё в разработке."
      />
      <StatePanel
        className={styles.state}
        title="Каталог инфраструктуры пока недоступен"
        description="Записей инфраструктуры в Relay ещё нет. Задачи инфраструктуры ведутся на отдельной доске, а описания — в библиотеке знаний."
        action={
          <Group justify="center" gap="xs" mt="md">
            <Button
              component={Link}
              to={`${base}/boards/infrastructure`}
              variant="default"
              leftSection={<Kanban size={16} aria-hidden="true" />}
            >
              Доска инфраструктуры
            </Button>
            <Button
              component={Link}
              to={`${base}/documents`}
              variant="default"
              leftSection={<BookOpen size={16} aria-hidden="true" />}
            >
              Библиотека знаний
            </Button>
          </Group>
        }
      />
    </PageStage>
  );
};
