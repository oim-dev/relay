import { projectSettingsSchema, saveProjectSettingsSchema } from "../../domain/project-settings.js";
import type { ProjectSettings, SaveProjectSettings } from "../../domain/project-settings.js";
import { parse } from "../../domain/validation.js";
import { invariant } from "../../shared/errors.js";
import type { Workspace } from "../../storage/workspace.js";
import { projectSettings } from "../../storage/project-settings.js";
import * as unified from "../../storage/unified-adapter.js";

/**
 * Сохраняет настройки под общей блокировкой проекта, перечитывая конфигурацию перед записью.
 * Повтор уже подтверждённой пары значений не создаёт новую ревизию.
 */
export async function saveProjectSettings(
  workspace: Workspace,
  input: SaveProjectSettings,
  assertCatalogOwned: () => void = () => {},
): Promise<ProjectSettings> {
  const command = parse(saveProjectSettingsSchema, input, "настройки проекта");
  return workspace.locked(async (assertOwned) => {
    workspace.assertWritableStorage();
    const config = { ...workspace.config, projectSettings: await unified.settings(workspace) };
    const previous = projectSettings(config, workspace.configPath);
    if (previous.name === command.name && previous.slug === command.slug) return previous;
    invariant(
      previous.revision === command.ifRevision,
      "REVISION_CONFLICT",
      "Настройки изменились в другом окне. Сверьте изменения перед сохранением.",
      4,
    );
    const saved = parse(
      projectSettingsSchema,
      { ...previous, name: command.name, slug: command.slug, revision: previous.revision + 1 },
      "настройки проекта",
    );
    /** Проверяет обе блокировки непосредственно перед атомарной публикацией. */
    const assertAllOwned = () => {
      assertCatalogOwned();
      assertOwned();
    };
    if (workspace.storageSession) {
      assertAllOwned();
      await unified.saveSettings(workspace, {
        ...config.projectSettings,
        version: 3,
        ...saved,
        events: [
          ...(config.projectSettings?.events ?? []),
          {
            revision: saved.revision,
            actor: "relay",
            at: new Date().toISOString(),
            action: "settings",
          },
        ],
      });
      return saved;
    }
    return saved;
  });
}
