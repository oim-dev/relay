import { Alert, Button, Skeleton } from "@mantine/core";
import { notifications } from "@mantine/notifications";
import { CircleAlert, CircleCheck, Info, TriangleAlert } from "lucide-react";
import { SectionPanel } from "ui/section-panel";
import { StatePanel } from "ui/state-panel";
import { KitExample } from "../kit-example/kit-example";
import styles from "./styles/kit-feedback.module.css";

/** Показывает уведомление о записи; успех объявляется только после ответа сервера. */
const showWriteResult = (isSuccess: boolean) =>
  notifications.show({
    color: isSuccess ? "success" : "danger",
    title: isSuccess ? "Материал сохранён" : "Не удалось сохранить материал",
    message: isSuccess
      ? "Изменения видны всем участникам проекта."
      : "Сервер недоступен. Черновик сохранён на этой странице, повторите отправку.",
  });

/**
 * Показывает состояния чтения и записи: загрузку, пустоту, ошибку, сообщения и уведомления.
 *
 * Используется для:
 *  - выбора состояния вместо полноэкранного spinner и самодельных сообщений
 */
export const KitFeedback = () => {
  return (
    <SectionPanel title="Состояния и сообщения">
      <KitExample
        titleAs="h2"
        title="Состояние раздела"
        purpose="Первичная загрузка, пустота или отсутствие совпадений и ошибка чтения с повтором."
        importLine='import { StatePanel } from "ui/state-panel";'
        rule='state="loading" | "empty" | "error". Ошибка — alert со значком и действием; уже показанные данные StatePanel не заменяет.'
      >
        <div className={styles.states}>
          <StatePanel
            state="loading"
            titleAs="h2"
            title="Загружаем материалы"
            description="Получаем каталог проекта."
          />
          <StatePanel
            titleAs="h2"
            title="Материалов пока нет"
            description="Добавьте первый материал или измените фильтры."
            action={<Button variant="default">Сбросить фильтры</Button>}
          />
          <StatePanel
            state="error"
            titleAs="h2"
            title="Не удалось загрузить материалы"
            description="Проверьте подключение к серверу Relay и повторите."
            action={<Button>Повторить</Button>}
          />
        </div>
      </KitExample>
      <KitExample
        title="Сообщения"
        purpose="Объяснение ситуации рядом с местом, к которому она относится; устаревшие данные остаются на экране."
        importLine='import { Alert } from "@mantine/core";'
        rule="Тон по смыслу: info, success, warning, danger; заголовок, значок и текст, не только цвет. Устаревание и неудачное обновление — Alert над данными с повтором."
      >
        <div className={styles.alerts}>
          <Alert color="info" title="Срез устарел" icon={<Info size={18} />}>
            Показаны прежние данные, обновление продолжается.
          </Alert>
          <Alert color="success" title="Изменения применены" icon={<CircleCheck size={18} />}>
            Применено к 12 из 12 материалов.
          </Alert>
          <Alert color="warning" title="Конфликт версий" icon={<TriangleAlert size={18} />}>
            Материал изменил другой участник. Сравните и сохраните заново.
          </Alert>
          <Alert color="danger" title="Ошибка записи" icon={<CircleAlert size={18} />}>
            Не удалось сохранить. Черновик не потерян.
          </Alert>
        </div>
      </KitExample>
      <KitExample
        title="Уведомления записи"
        purpose="Итог операции, которую человек запустил и мог покинуть."
        importLine='import { notifications } from "@mantine/notifications";'
        rule="Уведомление — над окнами и Drawer; успех сообщается только после ответа."
      >
        <Button variant="default" onClick={() => showWriteResult(true)}>
          Показать успех
        </Button>
        <Button variant="default" onClick={() => showWriteResult(false)}>
          Показать ошибку
        </Button>
      </KitExample>
      <KitExample
        title="Скелет"
        purpose="Место будущего содержимого при первой загрузке списка."
        importLine='import { Skeleton } from "@mantine/core";'
        rule="Только при первичной загрузке и в форме будущих строк."
      >
        <div className={styles.skeleton} aria-hidden="true">
          <Skeleton height={16} width="60%" />
          <Skeleton height={12} width="90%" />
          <Skeleton height={12} width="40%" />
        </div>
      </KitExample>
    </SectionPanel>
  );
};
