import type { IncomingMessage } from "node:http";

export const PROJECT_SELECTOR = Symbol("relay.project");

/** Проектная адресация переиспользует один набор контроллеров и сохраняет поток SSE. */
export function projectRouting(request: IncomingMessage): string {
  const url = request.url ?? "/";
  const match = /^\/api\/v1\/projects\/([^/?]+)(\/[^?]*)(\?.*)?$/.exec(url);
  if (!match) return url;
  if (
    !/^\/(?:work-history|documents|entities|graph|context|board|boards|board-tasks|tasks|events|task-list|groups|overview|validation|project|product|progress|plans|releases)(?:\/|$)/.test(
      match[2]!,
    )
  )
    return url;
  let project: string;
  try {
    project = decodeURIComponent(match[1]!);
  } catch {
    return url;
  }
  (request as IncomingMessage & { [PROJECT_SELECTOR]?: string })[PROJECT_SELECTOR] = project;
  return `/api/v1${match[2]}${match[3] ?? ""}`;
}
