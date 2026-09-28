# Пример работы через CLI

[Главная инструкция](../skill.md). Все команды запускаются через `npx @oim-dev/relay-cli`.
Пример показывает путь от знаний к проверенной работе и выпуску. Учебное содержание
не является требованием к вашему проекту и не разрешает создавать демонстрационные записи в нём.

Команды рассчитаны на POSIX shell и выбранную local-базу. Для workspace добавляйте
`--project` и при необходимости `--config`/`--server-url` к каждой предметной команде.
Перед записью читайте существующие данные: пример создания предназначен для пустой учебной области.

## Подстановки и ответы

Переменные `$FEATURE_ID`, `$SCENARIO_ID`, `$APP_ID`, `$SI_ID`, `$TASK_ID`, `$PLAN_ID`,
`$STAGE_ID`, `$RELEASE_ID`, `$CRITERION_ID` заполняйте адресами из фактического вывода CLI:
для сущностей предпочитайте читаемые ключи (несмотря на суффикс `_ID`), для этапа
и критерия нужен внутренний ID. `$BOARD_REF` — проверенная доска приложения,
`$ACTOR` — согласованный автор. `$TASK_REVISION`, `$PLAN_REVISION`, `$RELEASE_REVISION` — ревизии
из свежего чтения перед соответствующим изменением; после записи прежние значения устаревают.
Читайте адрес и ревизию в результате команды или карточке, не угадывайте их по порядку создания.

Проверяйте код завершения и сообщения команд, читайте полный Markdown и продолжение списков.
Переменные обозначают места подстановки, а не автоматически подготовленное окружение.
Не запускайте весь пример без остановок на чтение, выполнение и проверку результата.
Потеря ответа требует проверки состояния, а не повторного исполнения цепочки.

## 1. Сохраните знания

Вымышленное ТЗ: пользователь открывает каталог и видит записи либо пустое состояние.
Исходный текст сохраняется сразу, до задач и планирования:

```bash
# relay-example: document
npx @oim-dev/relay-cli document create \
  --actor "$ACTOR" \
  --name 'Учебное ТЗ' \
  --document-kind specification \
  --body '## Требование

Пользователь открывает каталог и видит записи либо пустое состояние.'
```

Создайте паспорт, фичу и сценарий. В работающей памяти найдите и обновите существующих владельцев.

```bash
# relay-example: product
npx @oim-dev/relay-cli product create \
  --actor "$ACTOR" \
  --name 'Учебный каталог' \
  --summary 'Пример подготовки знаний' \
  --description '## Назначение

Пользователь просматривает каталог. Других требований в учебном ТЗ нет.'
```

```bash
# relay-example: feature
npx @oim-dev/relay-cli feature create \
  --actor "$ACTOR" \
  --name 'Просмотр каталога' \
  --description '## Поведение

Показать записи. При пустом каталоге объяснить отсутствие данных.'
```

```bash
# relay-example: scenario
npx @oim-dev/relay-cli scenario create \
  --actor "$ACTOR" \
  --feature "$FEATURE_ID" \
  --name 'Открыть каталог' \
  --description '## Поток

Открыть каталог и увидеть записи либо пустое состояние.'
```

Создайте приложение и его вклад в общую фичу и сценарий. SI требует FI той же фичи и приложения.

```bash
# relay-example: application
npx @oim-dev/relay-cli application create \
  --actor "$ACTOR" \
  --name 'Web' \
  --slug web \
  --type frontend \
  --description '## Ответственность

Показ каталога.'
```

```bash
# relay-example: fi
npx @oim-dev/relay-cli implementation create \
  --actor "$ACTOR" \
  --application "$APP_ID" \
  --target "$FEATURE_ID" \
  --title 'Каталог в Web' \
  --description '## Вклад

Предоставить экран просмотра.'
```

```bash
# relay-example: si
npx @oim-dev/relay-cli implementation create \
  --actor "$ACTOR" \
  --application "$APP_ID" \
  --target "$SCENARIO_ID" \
  --title 'Открытие каталога в Web' \
  --description '## Вклад

Отобразить записи и пустое состояние.'
```

Прикрепите исходное ТЗ. `$DOCUMENT_ID` — ключ документа, `$DOCUMENT_REVISION` — его свежая
ревизия. Предметный `document link` сохраняет остальные отношения документа.

```bash
# relay-example: document-read
npx @oim-dev/relay-cli document get "$DOCUMENT_ID"
```

```bash
# relay-example: attach
npx @oim-dev/relay-cli document link "$DOCUMENT_ID" \
  --actor "$ACTOR" \
  --target "$SCENARIO_ID" \
  --relation references \
  --description 'Основание сценария' \
  --if-revision "$DOCUMENT_REVISION"
```

```bash
# relay-example: document-check
npx @oim-dev/relay-cli document get "$DOCUMENT_ID"
```

```bash
# relay-example: document-links-check
npx @oim-dev/relay-cli document links "$DOCUMENT_ID"
```

## 2. Организуйте работу

Создайте задачу с целью SI и проверяемым критерием. Её доска принадлежит приложению Web.

```bash
# relay-example: task
npx @oim-dev/relay-cli task create \
  --actor "$ACTOR" \
  --board "$BOARD_REF" \
  --title 'Реализовать просмотр каталога' \
  --description '## Цель

Выполнить связанный сценарий и проверить пустое состояние.' \
  --targets "$SI_ID" \
  --criterion-title 'catalog=Каталог и пустое состояние соответствуют ТЗ'
```

Пример использует план из одной задачи. Это допустимый объём, а не требование создавать
план для каждого действия. Создайте план, прочитайте его, добавьте этап, затем перечитайте
ревизию и явно включите задачу. `$STAGE_ID` получите через `plan stage list` после создания этапа.

```bash
# relay-example: plan
npx @oim-dev/relay-cli plan create \
  --actor "$ACTOR" \
  --title 'Просмотр каталога' \
  --goal 'Доставить проверенный сценарий'
```

```bash
# relay-example: plan-read
npx @oim-dev/relay-cli plan get "$PLAN_ID"
```

```bash
# relay-example: stage
npx @oim-dev/relay-cli plan stage create "$PLAN_ID" \
  --actor "$ACTOR" \
  --title 'Реализация и проверка' \
  --if-revision "$PLAN_REVISION"
```

```bash
# relay-example: plan-reread
npx @oim-dev/relay-cli plan get "$PLAN_ID"
```

```bash
# relay-example: stage-list
npx @oim-dev/relay-cli plan stage list "$PLAN_ID"
```

```bash
# relay-example: include
npx @oim-dev/relay-cli plan stage task add "$PLAN_ID" "$STAGE_ID" \
  --actor "$ACTOR" \
  --tasks "$TASK_ID" \
  --if-revision "$PLAN_REVISION"
```

```bash
# relay-example: scope-check
npx @oim-dev/relay-cli plan stage task list "$PLAN_ID" "$STAGE_ID"
```

## 3. Выполните и проверьте

Прочитайте задачу и начните порученную работу:

```bash
# relay-example: task-read
npx @oim-dev/relay-cli task get "$TASK_ID"
```

```bash
# relay-example: start
npx @oim-dev/relay-cli task move "$TASK_ID" \
  --actor "$ACTOR" \
  --column in-progress \
  --if-revision "$TASK_REVISION"
```

Здесь выполняются разработка и проверки внешними средствами. `$OBSERVED_RESULT` —
реальный Markdown-отчёт: сделанное, команды/сценарии проверок, их результат, основания,
ограничения и следующий шаг. Сохраните его независимо от успешности проверки:

```bash
# relay-example: evidence
npx @oim-dev/relay-cli task comment add "$TASK_ID" \
  --actor "$ACTOR" \
  --title 'Результат проверки' \
  --description "$OBSERVED_RESULT" \
  --role worker
```

**Если проверка не пройдена или не выполнена, остановите здесь путь завершения.**
Оставьте задачу в работе, сохраните причину и следующий шаг. Далее показана успешная
ветка при порученном завершении; если нужна приёмка другим участником, сначала передайте результат ему.

Получите ID нужного критерия и актуальную ревизию задачи; отмечайте только проверенный критерий:

```bash
# relay-example: criteria
npx @oim-dev/relay-cli task criterion list "$TASK_ID"
```

```bash
# relay-example: task-before-criterion
npx @oim-dev/relay-cli task get "$TASK_ID"
```

```bash
# relay-example: criterion
npx @oim-dev/relay-cli task criterion complete "$TASK_ID" "$CRITERION_ID" \
  --actor "$ACTOR" \
  --if-revision "$TASK_REVISION"
```

```bash
# relay-example: task-before-done
npx @oim-dev/relay-cli task get "$TASK_ID"
```

```bash
# relay-example: done
npx @oim-dev/relay-cli task move "$TASK_ID" \
  --actor "$ACTOR" \
  --column done \
  --if-revision "$TASK_REVISION"
```

## 4. Завершите план и зафиксируйте поставку

Проверьте прогресс; при невыполненном составе читайте причины и не завершайте план.
Для готового состава перечитайте ревизию и сохраните фактический итог:

```bash
# relay-example: progress
npx @oim-dev/relay-cli plan progress "$PLAN_ID"
```

```bash
# relay-example: plan-before-complete
npx @oim-dev/relay-cli plan get "$PLAN_ID"
```

```bash
# relay-example: complete
npx @oim-dev/relay-cli plan complete "$PLAN_ID" \
  --actor "$ACTOR" \
  --if-revision "$PLAN_REVISION" \
  --result "$OBSERVED_RESULT"
```

**Следующие действия выполняйте при порученном выпуске и подтверждённой внешней поставке.**
`$RELEASE_VERSION` — её обозначение, `$DEPLOYMENT_EVIDENCE` — реальные основания.
Пример не выполняет публикацию или развёртывание вместо пользователя.

```bash
# relay-example: release
npx @oim-dev/relay-cli release create \
  --actor "$ACTOR" \
  --title 'Учебный выпуск' \
  --release-version "$RELEASE_VERSION" \
  --plans "$PLAN_ID" \
  --description "$DEPLOYMENT_EVIDENCE"
```

```bash
# relay-example: release-read
npx @oim-dev/relay-cli release get "$RELEASE_ID"
```

```bash
# relay-example: publish
npx @oim-dev/relay-cli release publish "$RELEASE_ID" \
  --actor "$ACTOR" \
  --if-revision "$RELEASE_REVISION"
```

```bash
# relay-example: release-check
npx @oim-dev/relay-cli release get "$RELEASE_ID"
```

При продолжении после паузы читайте задачу, комментарии, требования и состав плана
заново. Прежний комментарий не доказывает свежую проверку. Выбор маршрута —
в [карте сценариев](../skill.md), точный синтаксис — в [CLI](interfaces/CLI.md).
