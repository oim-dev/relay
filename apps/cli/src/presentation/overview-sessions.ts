import type { OverviewSession, OverviewSessions } from "@relay/contracts/overview-sessions";
import stringWidth from "string-width";
import { actionsText } from "./common.js";
import { wrap } from "./layout.js";
import { safeText } from "./safe.js";
import type { TextOptions } from "./theme.js";
import { eventLabels, statusLabels } from "./work-history.js";

function sessionLine(
  session: OverviewSession,
  latest: boolean,
  full: boolean,
  options: TextOptions,
) {
  const key = safeText(session.key);
  const title = safeText(session.title);
  const state = `${statusLabels[session.status]}${latest ? " · последняя" : ""}`;
  const parent = session.parent ? ` · родитель ${safeText(session.parent.key)}` : "";
  const line = `${key} · ${title} · ${state}${parent}`;
  // Длинные ключи не разрываются; пользовательское название переносится отдельно.
  const heading =
    stringWidth(line) <= options.width
      ? line
      : [
          `${key} · ${state}`,
          wrap(title, options.width),
          ...(session.parent ? [`Родитель: ${safeText(session.parent.key)}`] : []),
        ].join("\n");
  return full
    ? `${heading}\n  ${eventLabels[session.lastEvent.kind]} · #${session.lastEvent.sequence} · ${session.lastEvent.at}`
    : heading;
}

/** Полная подборка даётся Core; compact сокращает только число видимых строк. */
export function overviewSessionsText(
  data: OverviewSessions,
  options: TextOptions,
  full: boolean,
  moreCommand: string,
): string {
  if (!data.latest) return "Сессии: записей пока нет.";
  const latestIsUnfinished = data.unfinished.items.some(
    (session) => session.id === data.latest!.id,
  );
  const visible = data.unfinished.items.slice(0, full ? data.unfinished.items.length : 3);
  const parts: string[] = [];
  if (!latestIsUnfinished)
    parts.push("Последняя сессия", sessionLine(data.latest, false, full, options));
  if (data.unfinished.total > 0) {
    if (parts.length) parts.push("");
    parts.push(
      wrap(
        `Незавершённые сессии: ${data.unfinished.total}${visible.length < data.unfinished.total ? ` · показано ${visible.length} из ${data.unfinished.total}` : ""}`,
        options.width,
      ),
      ...visible.map((session) =>
        sessionLine(session, session.id === data.latest!.id, full, options),
      ),
    );
    if (visible.length < data.unfinished.total)
      parts.push(
        "",
        actionsText(
          [
            {
              label: "Все незавершённые сессии",
              command: moreCommand,
              purpose: "continuation",
            },
          ],
          options,
        ),
      );
  }
  return parts.join("\n");
}
