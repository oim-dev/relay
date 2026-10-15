# Профиль 2 перед появлением истории работы

База создана реальными `initialize`, `BoardTasksService.create` и `StorageService.reindex`
из коммита `3dc1189479e7c479f4bf8a973d8ccd685a0953b5`, без номера релиза.
Физический формат 4, оболочка 3, профиль 2. Истории работы в этой версии нет.

Генератор: [generate-profile2.mts](../generators/generate-profile2.mts), упаковка —
[pack-tree.mjs](../generators/pack-tree.mjs). Генератор запускался через tsx с
`--conditions=tasks-source` в отдельном detached worktree; Core и Contracts загружены
из того же старого checkout. Повторная установка зависимостей не выполнялась:
использованы установленные неизменённые внешние Zod и proper-lockfile.

`oracle.json` содержит исходный Markdown с CRLF, пробелами, Unicode и завершающими
переводами строк, а также ID/ключ, возвращённые старым Core. `base.json.gz` хранит
всё дерево проекта побайтно. `provenance.json` — состав и контрольные суммы упаковки.
Тест `work-history-storage.test.ts` проверяет явный переход 2 → 3, точное сохранение
прежнего содержания и отсутствие синтетических веток, участий и checkpoints.
