# Пример работы через CLI

[Главная инструкция](../skill.md). Все команды запускаются через `npx @oim-dev/relay-cli`.
Пример показывает путь от знаний к проверенной работе и выпуску. Учебное содержание
не является требованием к вашему проекту и не разрешает создавать демонстрационные записи в нём.

Команды рассчитаны на POSIX shell и выбранную local-базу. Для workspace добавляйте
`--project` и при необходимости `--config`/`--server-url` к каждой предметной команде.
Перед записью читайте существующие данные: пример создания предназначен для пустой учебной области.

## Подстановки и ответы

Переменные `$FEATURE_ID`, `$SCENARIO_ID`, `$APP_ID`, `$SI_ID`, `$TASK_ID`, `$PLAN_ID`,
`$STAGE_ID`, `$RELEASE_ID`, `$CRITERION_ID` заполняйте адресами из фактического вывода CLI,
не названием записи. `$TASK_REVISION`, `$PLAN_REVISION`, `$RELEASE_REVISION` — ревизии
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
npx @oim-dev/relay-cli --actor agent entities create document --name 'Учебное ТЗ' --document-kind specification --body '## Требование

Пользователь открывает каталог и видит записи либо пустое состояние.'
```

Создайте паспорт, фичу и сценарий. В работающей памяти найдите и обновите существующих владельцев.

```bash
# relay-example: product
npx @oim-dev/relay-cli --actor agent entities create product --name 'Учебный каталог' --summary 'Пример подготовки знаний' --description '## Назначение

Пользователь просматривает каталог. Других требований в учебном ТЗ нет.'
```

```bash
# relay-example: feature
npx @oim-dev/relay-cli --actor agent entities create feature --name 'Просмотр каталога' --description '## Поведение

Показать записи. При пустом каталоге объяснить отсутствие данных.'
```

```bash
# relay-example: scenario
npx @oim-dev/relay-cli --actor agent entities create scenario --feature "$FEATURE_ID" --name 'Открыть каталог' --description '## Поток

Открыть каталог и увидеть записи либо пустое состояние.'
```

Создайте приложение и его вклад в общую фичу и сценарий. SI требует FI той же фичи и приложения.

```bash
# relay-example: application
npx @oim-dev/relay-cli --actor agent entities create application --name 'Web' --slug web --type frontend --description '## Ответственность

Показ каталога.'
```

```bash
# relay-example: fi
npx @oim-dev/relay-cli --actor agent entities create implementation --application "$APP_ID" --target "$FEATURE_ID" --title 'Каталог в Web' --description '## Вклад

Предоставить экран просмотра.'
```

```bash
# relay-example: si
npx @oim-dev/relay-cli --actor agent entities create implementation --application "$APP_ID" --target "$SCENARIO_ID" --title 'Открытие каталога в Web' --description '## Вклад

Отобразить записи и пустое состояние.'
```

Прикрепите исходное ТЗ. `$DOCUMENT_ID` — ID документа, `$DOCUMENT_REVISION` — его свежая
ревизия. `$DOCUMENT_RELATIONS` — полный JSON-массив отношений с существующими целями,
например `[{"target":{"kind":"scenario","id":"ID_СЦЕНАРИЯ"},"type":"references","description":"Основание сценария"}]`.
В рабочем документе сохраните нужные прежние отношения при замене массива.

```bash
# relay-example: document-read
npx @oim-dev/relay-cli entities get "$DOCUMENT_ID"
```

```bash
# relay-example: attach
npx @oim-dev/relay-cli --actor agent entities update "$DOCUMENT_ID" --if-revision "$DOCUMENT_REVISION" --relations "$DOCUMENT_RELATIONS"
```

```bash
# relay-example: document-check
npx @oim-dev/relay-cli entities get "$DOCUMENT_ID"
```

## 2. Организуйте работу

Создайте задачу с целью SI и проверяемым критерием. Её доска принадлежит приложению Web.

```bash
# relay-example: task
npx @oim-dev/relay-cli --actor agent task create --board web --title 'Реализовать просмотр каталога' --description '## Цель

Выполнить связанный сценарий и проверить пустое состояние.' --implementation "$SI_ID" --criteria '[{"title":"Каталог и пустое состояние соответствуют ТЗ"}]'
```

Пример использует план из одной задачи. Это допустимый объём, а не требование создавать
план для каждого действия. Создайте план, прочитайте его, добавьте этап, затем перечитайте
ревизию и явно включите задачу. `$STAGE_ID` получите из квитанции создания этапа.

```bash
# relay-example: plan
npx @oim-dev/relay-cli --actor agent plan create --title 'Просмотр каталога' --goal 'Доставить проверенный сценарий'
```

```bash
# relay-example: plan-read
npx @oim-dev/relay-cli plan get "$PLAN_ID"
```

```bash
# relay-example: stage
npx @oim-dev/relay-cli --actor agent plan stage create "$PLAN_ID" --title 'Реализация и проверка' --if-revision "$PLAN_REVISION"
```

```bash
# relay-example: plan-reread
npx @oim-dev/relay-cli plan get "$PLAN_ID"
```

```bash
# relay-example: include
npx @oim-dev/relay-cli --actor agent plan include "$PLAN_ID" "$STAGE_ID" --tasks "$TASK_ID" --if-revision "$PLAN_REVISION"
```

```bash
# relay-example: scope-check
npx @oim-dev/relay-cli plan tasks "$PLAN_ID" "$STAGE_ID"
```

## 3. Выполните и проверьте

Прочитайте задачу и начните порученную работу:

```bash
# relay-example: task-read
npx @oim-dev/relay-cli task get "$TASK_ID"
```

```bash
# relay-example: start
npx @oim-dev/relay-cli --actor agent task move "$TASK_ID" --column in-progress --if-revision "$TASK_REVISION"
```

Здесь выполняются разработка и проверки внешними средствами. `$OBSERVED_RESULT` —
реальный Markdown-отчёт: сделанное, команды/сценарии проверок, их результат, основания,
ограничения и следующий шаг. Сохраните его независимо от успешности проверки:

```bash
# relay-example: evidence
npx @oim-dev/relay-cli --actor agent task comment publish "$TASK_ID" --title 'Результат проверки' --description "$OBSERVED_RESULT" --role worker
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
npx @oim-dev/relay-cli --actor agent task criterion complete "$TASK_ID" "$CRITERION_ID" --if-revision "$TASK_REVISION"
```

```bash
# relay-example: task-before-done
npx @oim-dev/relay-cli task get "$TASK_ID"
```

```bash
# relay-example: done
npx @oim-dev/relay-cli --actor agent task move "$TASK_ID" --column done --if-revision "$TASK_REVISION"
```

## 4. Завершите план и зафиксируйте поставку

Проверьте прогресс; при невыполненном составе читайте причины и не завершайте план.
Для готового состава перечитайте ревизию и сохраните фактический итог:

```bash
# relay-example: progress
npx @oim-dev/relay-cli progress work-plan "$PLAN_ID"
```

```bash
# relay-example: plan-before-complete
npx @oim-dev/relay-cli plan get "$PLAN_ID"
```

```bash
# relay-example: complete
npx @oim-dev/relay-cli --actor agent plan complete "$PLAN_ID" --if-revision "$PLAN_REVISION" --result "$OBSERVED_RESULT"
```

**Следующие действия выполняйте при порученном выпуске и подтверждённой внешней поставке.**
`$RELEASE_VERSION` — её обозначение, `$DEPLOYMENT_EVIDENCE` — реальные основания.
Пример не выполняет публикацию или развёртывание вместо пользователя.

```bash
# relay-example: release
npx @oim-dev/relay-cli --actor agent release create --title 'Учебный выпуск' --release-version "$RELEASE_VERSION" --plans "$PLAN_ID" --description "$DEPLOYMENT_EVIDENCE"
```

```bash
# relay-example: release-read
npx @oim-dev/relay-cli release get "$RELEASE_ID"
```

```bash
# relay-example: publish
npx @oim-dev/relay-cli --actor agent release publish "$RELEASE_ID" --if-revision "$RELEASE_REVISION"
```

```bash
# relay-example: release-check
npx @oim-dev/relay-cli release get "$RELEASE_ID"
```

При продолжении после паузы читайте задачу, комментарии, требования и состав плана
заново. Прежний комментарий не доказывает свежую проверку. Выбор маршрута —
в [карте сценариев](../skill.md), точный синтаксис — в [CLI](interfaces/CLI.md).
