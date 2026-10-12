import { Button } from "@mantine/core";
import { FileText, Plus } from "lucide-react";
import { Link } from "react-router-dom";
import { formatDateTime } from "infra/date-time";
import { isDefined } from "shared/value-predicates";
import { PageHeader } from "ui/page-header";
import { FRESHNESS_LABELS } from "../../config/overview.config";
import { PassportSummary } from "./ui/passport-summary/passport-summary";
import type { OverviewHeaderProps } from "./types/overview-header-props.type";
import styles from "./styles/overview-header.module.css";

/**
 * Представляет продукт, выбранный проект и актуальность показанного среза.
 *
 * Используется для:
 *  - ответа на вопрос «что это за продукт» в начале обзора
 *  - перехода к паспорту или его заполнению
 */
export const OverviewHeader = (props: OverviewHeaderProps) => {
  const { project, passport, generatedAt, freshness, passportPath, className, ...rootAttrs } =
    props;
  const isMissing = passport.state === "missing";
  const title = passport.state === "missing" ? project.name : passport.name;
  const summaryText = passport.state === "missing" ? null : passport.text;
  const hasSummary = isDefined(summaryText) && summaryText !== "";
  const summarySuffix = passport.state !== "missing" && passport.isTruncated ? "…" : "";
  const excerptNote =
    passport.state === "no-summary"
      ? "Краткое описание не заполнено — показано начало описания паспорта."
      : null;
  const passportLabel = isMissing ? "Заполнить паспорт" : "Открыть паспорт";
  const passportTarget = isMissing ? `${passportPath}/edit` : passportPath;
  const PassportIcon = isMissing ? Plus : FileText;
  const freshnessLabel = FRESHNESS_LABELS[freshness];
  const receivedLabel = `Срез от ${formatDateTime(generatedAt)}`;
  const description = (
    <>
      {hasSummary && <PassportSummary text={`${summaryText}${summarySuffix}`} />}
      {isDefined(excerptNote) && <p className={styles.hint}>{excerptNote}</p>}
      {isMissing && (
        <p className={styles.summary}>
          Паспорт продукта ещё не заполнен: опишите назначение, пользователей и границы продукта.
        </p>
      )}
    </>
  );
  return (
    <PageHeader
      {...rootAttrs}
      className={className}
      meta={
        <>
          <span>Проект {project.name}</span>
          <span className={styles.slug}>{project.slug}</span>
        </>
      }
      title={title}
      description={description}
      actions={
        <>
          <span className={styles.freshness} data-freshness={freshness}>
            <span className={styles.dot} aria-hidden="true" />
            <span role="status">{freshnessLabel}</span>
          </span>
          <span className={styles.received}>{receivedLabel}</span>
          <Button
            component={Link}
            to={passportTarget}
            variant="default"
            size="xs"
            className={styles.passport}
            leftSection={<PassportIcon size={14} aria-hidden="true" />}
          >
            {passportLabel}
          </Button>
        </>
      }
    />
  );
};
